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

export interface ContentEvents {
    idle: (this: Content) => this;
    downloading: (this: Content) => this;
    downloaded: (this: Content, bufferLength: number) => this;
    uploaded: (this: Content, chunkSize: number) => this;
}

const ContentEmitter: { new (): StrictEventEmitter<EventEmitter, ContentEvents> } = EventEmitter;

export class Content extends ContentEmitter {
    constructor(
        public readonly contentTransferer: ContentTransferer,
        public readonly metadata: ContentMetadata,
        public readonly storageDir: string,
        // TODO: investigate how it's being used.
        public storageStats?: StorageStats
    ) {
        super();
        this.checkDirectoriesAndVerify();
    }

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

        const missingPieces = [];
        for (let i = 0; i <= this.metadata.pieces; i += 1) {
            if (i === this.metadata.pieces) {
                return this.verified(missingPieces);
            }
            if (await fs.pathExists(path.join(this.storageDir, this.metadata.infoHash, i.toString()))) {
                continue;
            }
            missingPieces.push(i);
        }
    }

    public verified(missingPieces: number[]): void {
        if (missingPieces.length === 0) {
            this.emit("idle");
        } else {
            this.download(missingPieces);
        }
    }

    public download(missingPieces: number[]): void {
        if (this.contentTransferer == null) {
            logger.info("Skipping download... no master wire to download content from.");
            return;
        }
        this.emit("downloading");
        this.contentTransferer.on("response", info => {
            const buffer = Buffer.from(info.data.data, "hex");
            const infoHashLength = 24;
            const pieceBuffer = buffer.slice(infoHashLength, buffer.length);

            if (!this.isEnoughSpace(pieceBuffer.length)) {
                this.deleteHash();
                return;
            }
            this.proceedDownload(missingPieces, buffer, pieceBuffer);
        });
        if (this.contentTransferer.isConnected()) {
            const missingPiece = missingPieces.shift();
            if (missingPiece != null) {
                this.contentTransferer.requested(missingPiece, this.metadata.infoHash);
            }
        } else {
            this.contentTransferer.on("connected", () => {
                const missingPiece = missingPieces.shift();
                if (missingPiece != null) {
                    this.contentTransferer.requested(missingPiece, this.metadata.infoHash);
                }
            });
        }
    }

    public proceedDownload(missingPieces: number[], buffer: Buffer, pieceBuffer: Buffer): void {
        const piece = buffer.readUInt32BE(0).toString();
        const infoHashLength = 24;
        const infoHash = buffer.toString("hex", 4, infoHashLength);
        const digest = Helpers.sha1(pieceBuffer);

        logger.info(`Received (piece ${piece}, infoHash ${infoHash}, length ${buffer.length - infoHashLength}, sha1 ${digest}).`);
        this.emit("downloaded", buffer.length);
        fs.writeFile(path.join(this.storageDir, infoHash, piece), pieceBuffer, "binary");
        this.next(missingPieces, () => {
            if (this.$isVerified) {
                return;
            }
            this.$isVerified = true;
            this.emit("idle");
        });
    }

    private next(missingPieces: number[], cb: () => void): void {
        if (missingPieces.length === 0) {
            return typeof cb === "function" ? cb() : undefined;
        }
        const missigPiece = missingPieces.shift();
        if (missigPiece == null) {
            logger.warn("Function next() tried to shift piece from an empty array.");
            return;
        }
        this.contentTransferer.requested(missigPiece, this.metadata.infoHash);
    }

    public async getResponseBuffer(piece: number, offset: number, length: number): Promise<Buffer> {
        const filePath = path.join(this.storageDir, this.metadata.infoHash, piece.toString());
        const fd = await fs.open(filePath, "r");
        const stats = await fs.stat(filePath);
        const size = length && length > 0 && length <= stats.size - offset ? length : stats.size - offset;
        const dataBuffer = Buffer.allocUnsafe(size);
        await fs.read(fd, dataBuffer, 0, size, offset);
        const resBuffer = concatBuffers(piece, offset, this.metadata.infoHash, dataBuffer);
        // logger.info(`response infoHash=${this.infoHash} index=${piece} length=${dataBuffer.length}`)
        await fs.close(fd);
        return resBuffer;

        function concatBuffers(part: number, partOffset: number, infoHash: string, buff: Buffer): Buffer {
            const partBuf = Buffer.allocUnsafe(4);
            const offsetBuf = Buffer.allocUnsafe(4);
            partBuf.writeUInt32BE(part, 0, undefined);
            offsetBuf.writeUInt32BE(partOffset, 0, undefined);
            const infoHashBuf = Buffer.from(infoHash, "hex");
            const buf = Buffer.concat([partBuf, offsetBuf, infoHashBuf, buff]);
            return buf;
        }
    }

    // TODO: inspect if storageStats is correctly used.
    public isEnoughSpace(pieceLength: number, storageStats?: StorageStats): boolean {
        let storagePath: string;
        const requiredSpace: number = this.metadata.pieces * pieceLength;

        if (storageStats != null && storageStats.available && storageStats.available < requiredSpace) {
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