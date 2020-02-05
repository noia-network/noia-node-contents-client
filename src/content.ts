import * as EventEmitter from "events";
import * as diskusage from "diskusage";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import StrictEventEmitter from "strict-event-emitter-types";

import { ContentMetadata } from "./metadata-store";
import { Helpers } from "./helpers";
import { StorageStats, ContentTransferer } from "./contracts";
import { logger } from "./logger";
import { ContentsClient } from "./contents-client";

export interface ContentEvents {
    idle: (this: Content) => this;
    downloading: (this: Content) => this;
    downloaded: (this: Content, bufferLength: number) => this;
    uploaded: (this: Content, chunkSize: number) => this;
}

const ContentEmitter: { new (): StrictEventEmitter<EventEmitter, ContentEvents> } = EventEmitter;

interface ContentPiece {
    index: number;
    integrity: string | null;
    verified: boolean;
    reserved: boolean;
}

export class Content extends ContentEmitter {
    constructor(
        public readonly contentsClient: ContentsClient,
        public readonly contentTransferer: ContentTransferer,
        public readonly metadata: ContentMetadata,
        public readonly storageDir: string
    ) {
        super();
        this.checkDirectoriesAndVerify();
    }

    private missingPieces: ContentPiece[] = [];

    private async checkDirectoriesAndVerify(): Promise<void> {
        const contentDir = path.join(this.storageDir, this.metadata.infoHash);
        await fs.ensureDir(this.storageDir);
        await fs.ensureDir(contentDir);
        this.verify();
    }

    protected $isVerified: boolean = false;

    public async verify(): Promise<void> {
        if (isNaN(this.metadata.pieces)) {
            logger.error("Value `this.metadata.pieces` is not a number.");
            return;
        }

        const missingPieces: ContentPiece[] = [];
        for (let index = 0; index <= this.metadata.pieces; index += 1) {
            if (index === this.metadata.pieces) {
                return this.verified(missingPieces);
            }
            let verified = false;
            if (await fs.pathExists(path.join(this.storageDir, this.metadata.infoHash, index.toString()))) {
                verified = true;
            }
            missingPieces.push({
                index,
                integrity: Array.isArray(this.metadata.piecesIntegrity) ? this.metadata.piecesIntegrity[index] : null,
                reserved: false,
                verified
            });
        }
    }

    public verified(missingPieces: ContentPiece[]): void {
        if (!missingPieces.some(piece => !piece.verified)) {
            this.emit("idle");
        } else {
            this.download(missingPieces);
        }
    }

    public async download(missingPieces: ContentPiece[]): Promise<void> {
        this.missingPieces = missingPieces;
        if (this.contentTransferer == null) {
            logger.info("Skipping download... no master wire to download content from.");
            return;
        }
        try {
            if (this.metadata.source != null) {
                logger.info(`Requesting content data from WebRTC source-address=${this.metadata.source}.`);
                await this.contentTransferer.connect();
            } else {
                logger.info(`Requesting content data from master.`);
            }
            this.emit("downloading");
            if (this.contentTransferer.isConnected()) {
                const missingPiece = this.missingPieces.find(piece => !piece.verified && !piece.reserved);
                if (missingPiece != null) {
                    missingPiece.reserved = true;
                    this.contentTransferer.requested(missingPiece.index, this.metadata.infoHash);
                }
            } else {
                this.contentTransferer.once("connected", () => {
                    const missingPiece = this.missingPieces.find(piece => !piece.verified && !piece.reserved);
                    if (missingPiece != null) {
                        missingPiece.reserved = true;
                        this.contentTransferer.requested(missingPiece.index, this.metadata.infoHash);
                    }
                });
            }
        } catch (err) {
            logger.error("Failed to download content:", err);
            await this.contentsClient.getMetadataStore().remove(this.metadata.infoHash);
            await this.deleteHash();
        }
    }

    public proceedDownload(buffer: Buffer, pieceBuffer: Buffer): void {
        const piece = buffer.readUInt32BE(0).toString();
        const infoHashLength = 24;
        const infoHash = buffer.toString("hex", 4, infoHashLength);
        // const digest = Helpers.sha1(pieceBuffer);

        // TODO: Should digest be checked?
        const missingPiece = this.missingPieces.find(p => p.index === +piece);
        if (missingPiece != null) {
            missingPiece.verified = true;
        }

        // logger.info(`Received (piece ${piece}, infoHash ${infoHash}, length ${buffer.length - infoHashLength}, sha1 ${digest}).`);
        this.emit("downloaded", buffer.length);
        fs.writeFile(path.join(this.storageDir, infoHash, piece), pieceBuffer, "binary");
        this.next(this.missingPieces, () => {
            if (this.$isVerified) {
                return;
            }
            this.$isVerified = true;
            this.emit("idle");
        });
    }

    public proceedWebRtcDownload(pieceBuffer: Buffer, contentId: string, pieceIndex: number): void {
        const pieceLength = 4;
        const infoHashLength = 24;
        const digest = Helpers.sha1(pieceBuffer);

        if (this.metadata.piecesIntegrity != null && this.metadata.piecesIntegrity[pieceIndex] !== digest) {
            logger.warn(
                `Received (piece ${pieceIndex}, infoHash ${contentId}, length ${pieceBuffer.length}, sha1 ${digest}) data is invalid. Expected sha1 ${this.metadata.piecesIntegrity[pieceIndex]}.`
            );
            this.deleteHash();
            return;
        }

        logger.info(`Received (piece ${pieceIndex}, infoHash ${contentId}, length ${pieceBuffer.length}, sha1 ${digest}).`);
        this.emit("downloaded", pieceBuffer.length + infoHashLength + pieceLength);
        fs.writeFile(path.join(this.storageDir, contentId, pieceIndex.toString()), pieceBuffer, "binary");
        this.next(this.missingPieces, () => {
            if (this.$isVerified) {
                return;
            }
            this.$isVerified = true;
            this.emit("idle");
        });
    }

    private next(missingPieces: ContentPiece[], cb: () => void): void {
        if (!missingPieces.some(piece => !piece.verified)) {
            return typeof cb === "function" ? cb() : undefined;
        }

        // TODO: noia-master bottleneck needs to be fixed before fully testing missing pieces improvement. Lock 1 piece at a time.
        setTimeout(() => {
            for (let i = 0; i < 1; i++) {
                const missingPiece = this.missingPieces.find(piece => !piece.verified && !piece.reserved);
                if (missingPiece != null) {
                    missingPiece.reserved = true;
                    this.contentTransferer.requested(missingPiece.index, this.metadata.infoHash);
                    // logger.warn("Function next() tried to shift piece from an empty array.");
                    // return;
                }
            }
        }, this.contentsClient.downloadRequestTimeoutMs);
    }

    public async getContentData(
        piece: number,
        offset: number,
        length: number
    ): Promise<{
        contentId: string;
        index: number;
        offset: number;
        length: number;
        buffer: Buffer;
    }> {
        const filePath = path.join(this.storageDir, this.metadata.infoHash, piece.toString());
        const fd = await fs.open(filePath, "r");
        const stats = await fs.stat(filePath);
        const size = length && length > 0 && length <= stats.size - offset ? length : stats.size - offset;
        const dataBuffer = Buffer.allocUnsafe(size);
        await fs.read(fd, dataBuffer, 0, size, offset);
        // const resBuffer = concatBuffers(this.metadata.infoHash, dataBuffer);
        // logger.info(`response infoHash=${this.metadata.infoHash} index=${piece} length=${dataBuffer.length}`)
        await fs.close(fd);
        return {
            contentId: this.metadata.infoHash,
            buffer: dataBuffer,
            index: piece,
            length: size,
            offset: offset
        };
    }

    // TODO: inspect if storageStats is correctly used.
    public async isEnoughSpace(pieceLength: number, storageStatsFn: () => Promise<StorageStats>): Promise<boolean> {
        let storagePath: string;
        // Deprecated:
        // const requiredSpace: number = this.metadata.pieces * pieceLength;
        const requiredSpace: number = pieceLength;

        const storageStats = await storageStatsFn();
        if (storageStats != null && storageStats.available < requiredSpace) {
            logger.error("Not enough space in available storage.");
            return false;
        }

        if (os.platform() === "win32") {
            storagePath = `${this.storageDir.split(":")[0]}:`;
        } else {
            // TODO: fix undesired effects.
            storagePath = "/";
        }

        try {
            const info = diskusage.checkSync(storagePath);

            if (info.available < requiredSpace) {
                logger.error("Not enough space in storage.");
                return false;
            }
            return true;
        } catch (err) {
            logger.error(err);
            return false;
        }
    }

    public async deleteHash(): Promise<void> {
        const hashPath = path.join(this.storageDir, this.metadata.infoHash);

        if (await fs.pathExists(hashPath)) {
            try {
                await fs.remove(hashPath);
                logger.info(`Deleted files with hash ${this.metadata.infoHash}.`);
            } catch (err) {
                if (err.code === "EPERM") {
                    logger.error("File access permissions violation. Open application as an administrator.");
                } else {
                    throw err;
                }
            }
        }
    }
}
