import * as WebSocket from "ws";
import { ContentsClient, ContentTransferer } from "../src/index";
import { Wire, NodeMetadata, MasterMetadata } from "@noia-network/protocol";
import { Content } from "../src/content";

class Transfered extends Wire<NodeMetadata, MasterMetadata> implements ContentTransferer {
    constructor(socket: string | WebSocket) {
        super(socket, {
            nodeId: "nodeId",
            version: "1.0.0",
            interface: "cli",
            walletAddress: "any",
            connections: { webrtc: null, ws: 7676, wss: null }
        });
    }
}

const wire = new Transfered(new WebSocket("ws://localhost:7777"));

wire.once("handshake", async () => {
    const client = new ContentsClient(wire, "./storage");
    await client.start();
    client.add({
        infoHash: "f8f40a6b918314b6ec7cb71d487aec1d529b163b",
        pieces: 691
    });
    client.on("seeding", async infoHashes => {
        console.info("seeding", infoHashes);
        const content = client.get("f8f40a6b918314b6ec7cb71d487aec1d529b163b");
        await (content as Content).getResponseBuffer(690, 0, 0);
        console.info("data");
    });
    client.on("downloaded", chunkSize => {
        console.info("downloaded", chunkSize, "speed", client.downloadSpeed);
    });
    client.on("uploaded", chunkSize => {
        console.info("uploaded", chunkSize, "speed", client.uploadSpeed);
    });
});
