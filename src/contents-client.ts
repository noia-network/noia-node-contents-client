import * as EventEmitter from "events";
import * as fs from "fs-extra";
import * as path from "path";
import * as speedometer from "speedometer";
import StrictEventEmitter from "strict-event-emitter-types";

import { Content } from "./content";
import { MetadataStore, ContentMetadata } from "./metadata-store";
import { StorageStats, ContentTransferer } from "./contracts";
import { logger } from "./logger";

export interface ContentsClientEvents {
    seeding: (this: ContentsClient, infoHashes: string[]) => this;
    downloaded: (this: ContentsClient, chunkSize: number) => this;
    uploaded: (this: ContentsClient, chunkSize: number) => this;
    downloadSpeed: (this: ContentsClient, bytesPerSecond: number) => this;
    uploadSpeed: (this: ContentsClient, bytesPerSecond: number) => this;
}

const ContentsClientEmitter: { new (): StrictEventEmitter<EventEmitter, ContentsClientEvents> } = EventEmitter;

export class ContentsClient extends ContentsClientEmitter {
    constructor(
        public readonly contentTransferer: ContentTransferer,
        private readonly dir: string = path.resolve(),
        private readonly storageStats?: StorageStats
    ) {
        super();

        // Emit download speed.
        let prevDownloadSpeed: number | null = null;
        setInterval(() => {
            const currDownloadSpeed = this.downloadSpeed;
            if (currDownloadSpeed !== prevDownloadSpeed) {
                this.emit("downloadSpeed", currDownloadSpeed);
            }
            prevDownloadSpeed = currDownloadSpeed;
        }, 1 * 1000);

        // Emit upload speed.
        let prevUploadSpeed: number | null = null;
        setInterval(() => {
            const currUploadSpeed = this.uploadSpeed;
            if (currUploadSpeed !== prevUploadSpeed) {
                this.emit("uploadSpeed", currUploadSpeed);
            }
            prevUploadSpeed = currUploadSpeed;
        }, 1 * 1000);
    }

    private isDestroyed: boolean = false;
    private downloadSpeedSpeedometer: (chunkSize?: number) => number = speedometer(3);
    private uploadSpeedSpeedometer: (chunkSize?: number) => number = speedometer(3);
    private metadataStore?: MetadataStore;
    private contentsNotVerified: Map<string, Content> = new Map<string, Content>();
    public readonly contents: Map<string, Content> = new Map<string, Content>();
    public readonly metadataPath: string = path.join(this.dir, "metadata.json");

    public async start(): Promise<void> {
        await this.ensureMetadataFile();
        this.metadataStore = new MetadataStore(this.metadataPath);
        this.metadataStore.on("added", metadata => this.internalAdd(metadata));
        this.metadataStore.on("removed", infoHash => this.internalRemove(infoHash));
        this.metadataStore.on("notChanged", contentMetadata => {
            for (const contentEntry of this.contentsNotVerified.entries()) {
                contentEntry[1].verify();
            }
        });
    }

    private async ensureMetadataFile(): Promise<void> {
        try {
            await fs.ensureDir(this.dir);
            if (!(await fs.pathExists(this.metadataPath))) {
                await fs.writeJson(this.metadataPath, {}, { spaces: 4 });
            }
        } catch (err) {
            if (err.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw err;
            }
        }
    }

    public stop(): void {
        this.contents.clear();
        this.metadataStore = undefined;
    }

    public add(metadata: ContentMetadata): void {
        this.getMetadataStore().add(metadata);
    }

    public remove(infoHash: string): void {
        this.getMetadataStore().remove(infoHash);
    }

    private getMetadataStore(): MetadataStore {
        if (this.metadataStore == null) {
            const msg = "MetadataStore is not initialized.";
            logger.error(msg);
            throw new Error(msg);
        }
        return this.metadataStore;
    }

    public get(id: string | string[]): Content | Content[] | undefined {
        if (this.isDestroyed) {
            logger.warn("Called get() when contents client instance is destroyed.");
            throw new Error("Called get() when contents client instance is destroyed.");
        }
        if (Array.isArray(id)) {
            const contentsInfoHashes = id
                .map<Content | undefined>(infoHash => this.contents.get(infoHash))
                .filter(x => x != null) as Content[];
            return contentsInfoHashes;
        } else {
            return this.contents.get(id);
        }
    }

    public getInfoHashes(): string[] {
        if (this.isDestroyed) {
            logger.warn("Called getInfoHashes() when contents client instance is destroyed.");
            return [];
        }
        const results = [];
        for (const contentInfoHash of this.contents.keys()) {
            results.push(contentInfoHash);
        }
        return results;
    }

    private internalAdd(metadata: ContentMetadata): void {
        if (this.isDestroyed) {
            logger.warn("Called internalAdd() when contents client instance is destroyed.");
            return;
        }
        const content = new Content(this.contentTransferer, metadata, this.dir, this.storageStats);
        this.contentsNotVerified.set(content.metadata.infoHash, content);
        content.on("idle", () => {
            this.contentsNotVerified.delete(content.metadata.infoHash);
            this.contents.set(content.metadata.infoHash, content);
            this.emit("seeding", this.getInfoHashes());
        });
        content.on("downloading", () => {
            logger.info(`downloading ${content.metadata.infoHash}...`);
        });
        content.on("downloaded", chunkSize => {
            this.emit("downloaded", chunkSize);
            this.downloadSpeedSpeedometer(chunkSize);
        });
        content.on("uploaded", chunkSize => {
            this.emit("uploaded", chunkSize);
            this.uploadSpeedSpeedometer(chunkSize);
        });
    }

    private internalRemove(infoHash: string): void {
        if (this.isDestroyed) {
            logger.warn("Called internalRemove() when contents client instance is destroyed.");
            return;
        }
        this.contents.delete(infoHash);
        this.emit("seeding", this.getInfoHashes());
    }

    public destroy(): void {
        this.isDestroyed = true;
    }

    public get downloadSpeed(): number {
        return this.downloadSpeedSpeedometer();
    }

    public get uploadSpeed(): number {
        return this.uploadSpeedSpeedometer();
    }
}
