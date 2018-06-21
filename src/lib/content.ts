import EventEmitter from "events";
import crypto from "crypto";
import fs from "fs";
import mkdirp from "mkdirp";
import path from "path";

import { filterContentProps } from "./common";
import logger from "./logger";

function sha1(buf: any) {
    return crypto
        .createHash("sha1")
        .update(buf)
        .digest("hex");
}

export = class Content extends EventEmitter {
    public master: any;
    public storageDir: any;
    public infoHash: any;
    public pieces: any;
    public isVerified: boolean;
    constructor(master: any, metadata: any, storageDir: any) {
        super();

        if (!storageDir) throw new Error("storageDir unspecified");
        if (!metadata) throw new Error("metadata unspecified");
        if (!metadata.infoHash) throw new Error("metadata.infoHash unspecified");
        if (!metadata.pieces) throw new Error("metadata.pieces unspecified");

        this.master = master;
        this.storageDir = storageDir;
        this.infoHash = metadata.infoHash;
        this.pieces = metadata.pieces;
        this.isVerified = false;
        if (!fs.existsSync(this.storageDir)) {
            logger.info("creating storageDir", this.storageDir);
            mkdirp.sync(this.storageDir);
        }
        if (!fs.existsSync(path.join(this.storageDir, this.infoHash))) {
            mkdirp.sync(path.join(this.storageDir, this.infoHash));
        }
        this.verify();
    }

    verify() {
        let missingPieces = [];
        for (let i = 0; i <= this.pieces; i += 1) {
            if (i === Number(this.pieces)) return this.verified(missingPieces);
            if (fs.existsSync(path.join(this.storageDir, this.infoHash, i.toString()))) continue;
            missingPieces.push(i);
        }
    }

    verified(missingPieces: any) {
        if (missingPieces.length === 0) {
            process.nextTick(() => {
                this.emit("idle");
            });
        } else {
            this.download(missingPieces);
        }
    }

    download(missingPieces: any) {
        if (!this.master || !this.master._wire) {
            logger.info("Skipping download... no master wire to download content from.");
            return;
        }
        this.emit("downloading");
        this.master._wire.on("response", (info: any) => {
            const buffer = Buffer.from(info.data, "hex");
            const piece = buffer.readUInt32BE(0).toString();
            const infoHashLength = 24;
            const infoHash = buffer.toString("hex", 4, infoHashLength);
            const pieceBuffer = buffer.slice(infoHashLength, buffer.length);
            const digest = sha1(pieceBuffer);
            logger.info("Received (piece %s, infoHash %s, length %s, sha1 %s)", piece, infoHash, buffer.length - infoHashLength, digest);
            this.emit("downloaded", buffer.length);
            fs.writeFile(path.join(this.storageDir, infoHash, piece), pieceBuffer, "binary", (err: Error) => {
                if (err) throw new Error(err.message);
            });
            this._next(missingPieces, () => {
                if (this.isVerified) return;
                this.isVerified = true;
                this.emit("idle");
            });
        });
        if (this.master._wire.ready) {
            this.master._wire.requested(missingPieces.shift(), this.infoHash);
        } else {
            this.master._wire.on("handshake", () => {
                this.master._wire.requested(missingPieces.shift(), this.infoHash);
            });
        }
    }

    _next(missingPieces: any, cb: any) {
        // piece += 1
        if (missingPieces.length === 0) {
            return typeof cb === "function" ? cb() : undefined;
        }
        this.master._wire.requested(missingPieces.shift(), this.infoHash);
    }

    getResponseBuffer(piece: any, offset: any, length: any, cb: any) {
        const filePath = path.join(this.storageDir, this.infoHash, piece.toString());
        fs.open(filePath, "r", (err, fd) => {
            if (err) throw err;
            const stats = fs.statSync(filePath);
            const size = length && length > 0 && length <= stats.size - offset ? length : stats.size - offset;
            const dataBuffer = Buffer.allocUnsafe(size);
            fs.readSync(fd, dataBuffer, 0, size, offset);
            if (err) throw new Error(err);
            const resBuffer = concatBuffers(piece, offset, this.infoHash, dataBuffer);
            // logger.info(`response infoHash=${this.infoHash} index=${piece} length=${dataBuffer.length}`)
            cb(resBuffer);
            fs.close(fd, err => {
                if (err) throw err;
            });
        });

        function concatBuffers(part: any, offset: any, infoHash: any, dataBuffer: any) {
            const partBuf = Buffer.allocUnsafe(4);
            const offsetBuf = Buffer.allocUnsafe(4);
            partBuf.writeUInt32BE(part, 0, undefined);
            offsetBuf.writeUInt32BE(offset, 0, undefined);
            const infoHashBuf = Buffer.from(infoHash, "hex");
            const buf = Buffer.concat([partBuf, offsetBuf, infoHashBuf, dataBuffer]);
            return buf;
        }
    }

    toMetadata() {
        return filterContentProps(this);
    }
};
