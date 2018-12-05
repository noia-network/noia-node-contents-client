import * as protobuf from "protobufjs";
import * as wrtc from "wrtc";
import StrictEventEmitter from "strict-event-emitter-types/types/src";
import { Client } from "@noia-network/webrtc-direct-client";
import { EventEmitter } from "events";
import { Wire, ContentResponse } from "@noia-network/protocol";

import { ContentTransferer, ContentTransfererEvents } from "./contracts";
import { ContentsClient } from "./contents-client";
import { logger } from "./logger";

let ContentResponseProtobuf: protobuf.Type;
protobuf.load(Wire.getProtoFilePath(), (err, root) => {
    if (err) {
        throw err;
    }
    if (root == null) {
        console.info("Root is null.");
        return;
    }
    ContentResponseProtobuf = root.lookupType("ContentResponse");
});

const WebRtcContentTransfererEmitter: { new (): StrictEventEmitter<EventEmitter, ContentTransfererEvents> } = EventEmitter;

export class WebRtcContentTransferer extends WebRtcContentTransfererEmitter implements ContentTransferer {
    constructor(private readonly contentsClient: ContentsClient, private readonly address: string, public readonly externalIp?: string) {
        super();
    }

    private connectionState: "connected" | "not-connected" = "not-connected";
    public client?: Client;

    public getExternalIp(): string | undefined {
        return this.externalIp;
    }

    public isConnected(): boolean {
        return this.connectionState === "connected";
    }

    public requested(pieceIndex: number, contentId: string): void {
        if (this.client == null) {
            logger.warn("WebRTC client is invalid.");
            return;
        }

        this.client.send(
            JSON.stringify({
                contentId: contentId,
                index: pieceIndex,
                offset: 0
            })
        );
    }

    public createResponseBuffer(contentId: string, pieceIndex: number, dataBuf: Buffer): Buffer {
        const data = dataBuf;
        const pieceBuf = Buffer.allocUnsafe(4);
        pieceBuf.writeUInt32BE(pieceIndex, 0);
        const infoHashBuf = Buffer.from(contentId, "hex");
        const buf = Buffer.concat([pieceBuf, infoHashBuf, data]);
        return buf;
    }

    public async connect(): Promise<void> {
        if (this.client != null) {
            logger.warn("Client is already initialized.");
            return;
        }

        logger.info(`Establishing WebRTC connection to address=${this.address}.`);

        this.client = new Client(this.address, {
            wrtc: wrtc,
            candidateIp: this.externalIp
        });
        await this.client.connect();

        // @ts-ignore
        this.client.on("data", async (buffer: ArrayBuffer) => {
            // @ts-ignore
            const contentResponse: ContentResponse = ContentResponseProtobuf.decode(new Uint8Array(buffer));
            if (contentResponse.status === 200 && contentResponse.data != null) {
                const infoHash = contentResponse.data.contentId;
                const pieceBuffer = contentResponse.data.buffer;

                const content = this.contentsClient.contentsNotVerified.get(infoHash);
                if (content != null) {
                    if (!(await content.isEnoughSpace(pieceBuffer.length, this.contentsClient.storageStats))) {
                        content.deleteHash();
                        return;
                    }
                    content.proceedWebRtcDownload(pieceBuffer, infoHash, contentResponse.data.index);
                }
            }
        });

        this.connectionState = "connected";
        // @ts-ignore
        this.emit("connected");
        logger.info(`Established WebRTC connection to address=${this.address}.`);
    }

    public async disconnect(): Promise<void> {
        if (this.client == null) {
            return;
        }
        await this.client.stop();
    }
}
