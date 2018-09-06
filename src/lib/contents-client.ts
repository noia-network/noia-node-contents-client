import EventEmitter from "events";
import fs from "fs";
import path from "path";
import mkdirp from "mkdirp";
import jsonfile from "jsonfile";
const speedometer = require("speedometer");

import MetadataStore from "./metadata-store";
import logger from "./logger";
import Content from "./content";
import { StorageStats } from "./contracts";

export class ContentsClient extends EventEmitter {
    public contents: any;
    public contentsNotVerified: any;
    public _destroyed: boolean;
    public _downloadSpeed: any;
    public _uploadSpeed: any;
    public dir: any;
    public metadataPath: any;
    public master: any;
    public metadataStore: any;
    public storageStats?: StorageStats;

    constructor(master: any, dir: any, storageStats?: StorageStats) {
        super();

        this.contents = {};
        this.contentsNotVerified = {};

        if (!dir) throw new Error("unspecified dataDir");
        if (!fs.existsSync(dir)) mkdirp.sync(dir);

        this._destroyed = false;
        this._downloadSpeed = speedometer(3);
        this._uploadSpeed = speedometer(3);
        this.dir = dir;
        this.storageStats = storageStats;
        this.metadataPath = path.join(dir, "metadata.json");
        this.master = master;

        try {
            if (!fs.existsSync(this.metadataPath)) {
                jsonfile.writeFileSync(this.metadataPath, {}, { spaces: 2 });
            }
        } catch (ex) {
            if (ex.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw ex;
            }
        }

        Object.defineProperty(ContentsClient.prototype, "downloadSpeed", {
            get: () => {
                return this._downloadSpeed();
            }
        });
        Object.defineProperty(ContentsClient.prototype, "uploadSpeed", {
            get: () => {
                return this._uploadSpeed();
            }
        });
    }

    public start() {
        this.metadataStore = new MetadataStore(this.metadataPath);
        this.metadataStore.on("added", (metadata: any) => this._add(metadata));
        this.metadataStore.on("removed", (infoHash: string) => this._remove(infoHash));
        this.metadataStore.on("notChanged", (infoHashes: string[]) => {
            const keys = Object.keys(this.contentsNotVerified);
            keys.forEach((infoHash: any) => {
                this.contentsNotVerified[infoHash].verify();
            });
        });
    }

    public stop() {
        this.contents = {};
        this.metadataStore = null;
    }

    public add(metadata: any) {
        this.metadataStore.add(metadata);
    }

    public remove(infoHash: any) {
        this.metadataStore.remove(infoHash);
    }

    public get(id: any) {
        if (this._destroyed) {
            logger.warn("Called get() when contents client instance is destroyed.");
            return;
        }
        if (Array.isArray(id)) {
            const contents: string[] = [];
            id.forEach(infoHash => contents.push(this.contents[infoHash]));
            return contents;
        } else {
            return this.contents[id];
        }
    }

    public getInfoHashes(): string[] {
        if (this._destroyed) {
            logger.warn("Called getInfoHashes() when contents client instance is destroyed.");
            return [];
        }
        return Object.keys(this.contents);
    }

    private _add(metadata: any) {
        if (this._destroyed) {
            logger.warn("Called _add() when contents client instance is destroyed.");
            return;
        }
        const content = new Content(this.master, metadata, this.dir, this.storageStats);
        this.contentsNotVerified[content.infoHash] = content;
        content.on("idle", () => {
            delete this.contentsNotVerified[content.infoHash];
            this.contents[content.infoHash] = content;
            this.emit("seeding", this.getInfoHashes());
        });
        content.on("downloading", () => {
            logger.info(`downloading ${content.infoHash}...`);
        });
        content.on("downloaded", (chunkSize: any) => {
            this.emit("downloaded", chunkSize);
            this._downloadSpeed(chunkSize);
        });
        content.on("uploaded", (chunkSize: any) => {
            this.emit("uploaded", chunkSize);
            this._uploadSpeed(chunkSize);
        });
    }

    private _remove(infoHash: any) {
        if (this._destroyed) {
            logger.warn("Called _remove() when contents client instance is destroyed.");
            return;
        }
        delete this.contents[infoHash];
        this.emit("seeding", this.getInfoHashes());
    }

    public destroy() {
        return new Promise(resolve => {
            this._destroyed = true;
            resolve();
        });
    }
}
