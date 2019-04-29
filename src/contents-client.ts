import * as EventEmitter from "events";
import * as fs from "fs-extra";
import * as path from "path";
import * as speedometer from "speedometer";
import StrictEventEmitter from "strict-event-emitter-types";

import { Content } from "./content";
import { MetadataStore, ContentMetadata } from "./metadata-store";
import { StorageStats, ContentTransferer } from "./contracts";
import { WebRtcContentTransferer } from "./webrtc-content-transferer";
import { logger } from "./logger";

interface ContentsClientOptions {
    maxUploadBytesPerSecond?: number;
    maxDownloadBytesPerSecond?: number;
}

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
        readonly storageStats: () => Promise<StorageStats>,
        public readonly opts: ContentsClientOptions = {}
    ) {
        super();

        const calcTimeoutMs = (transferSpeed: number, maxBytesPerSecond: number | undefined, timeoutMs: number): number => {
            // If max speed is not set, use as small timeout as posssible.
            if (maxBytesPerSecond == null || maxBytesPerSecond === 0) {
                return 0;
            }

            if (transferSpeed === 0) {
                return timeoutMs;
            }

            const change = transferSpeed / maxBytesPerSecond;

            // Escape multiplication by 0.
            if ((timeoutMs === 0 && change > 0) || timeoutMs < 0.1) {
                return 0.1;
            }

            // This implementation of transfer speed control has limitation of delaying up to
            // speed calculation
            if (Math.ceil((timeoutMs * change) / 1000) > 1) {
                logger.warn("Set maximum trasnfer speed is too small to perform reliably!");
                return 950;
            }

            return timeoutMs * change;
        };

        // Emit download speed.
        let prevDownloadSpeed: number | null = null;
        setInterval(() => {
            this.downloadRequestTimeoutMs = calcTimeoutMs(
                this.downloadSpeed,
                this.opts.maxDownloadBytesPerSecond,
                this.downloadRequestTimeoutMs
            );
            const currDownloadSpeed = this.downloadSpeed;
            if (currDownloadSpeed !== prevDownloadSpeed) {
                this.emit("downloadSpeed", currDownloadSpeed);
            }
            prevDownloadSpeed = currDownloadSpeed;
        }, 1 * 1000);

        // Emit upload speed.
        let prevUploadSpeed: number | null = null;
        setInterval(() => {
            this.uploadResponseTimeoutMs = calcTimeoutMs(this.uploadSpeed, this.opts.maxUploadBytesPerSecond, this.uploadResponseTimeoutMs);
            const currUploadSpeed = this.uploadSpeed;
            if (currUploadSpeed !== prevUploadSpeed) {
                this.emit("uploadSpeed", currUploadSpeed);
            }
            prevUploadSpeed = currUploadSpeed;
        }, 1 * 1000);

        this.contentTransferer.on("response", async info => {
            const buffer = Buffer.from(info.data.data, "hex");
            const pieceBytes = 4;
            const infoHashLength = pieceBytes + 20;
            const infoHash = buffer.toString("hex", pieceBytes, infoHashLength);
            const pieceBuffer = buffer.slice(infoHashLength, buffer.length);

            const content = this.contentsNotVerified.get(infoHash);
            if (content != null) {
                if (!(await content.isEnoughSpace(pieceBuffer.length, storageStats))) {
                    content.deleteHash();
                    return;
                }
                content.proceedDownload(buffer, pieceBuffer);
            }
        });
    }

    private isDestroyed: boolean = false;
    public downloadSpeedSpeedometer: (chunkSize?: number) => number = speedometer(1);
    public uploadSpeedSpeedometer: (chunkSize?: number) => number = speedometer(1);
    private metadataStore?: MetadataStore;
    public contentsNotVerified: Map<string, Content> = new Map<string, Content>();
    public readonly contents: Map<string, Content> = new Map<string, Content>();
    public readonly metadataPath: string = path.join(this.dir, "metadata.json");
    public downloadRequestTimeoutMs: number = 500;
    public uploadResponseTimeoutMs: number = 500;

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

    public async add(metadata: ContentMetadata): Promise<void> {
        await this.getMetadataStore().add(metadata);
    }

    public async remove(infoHash: string): Promise<void> {
        const content = this.contents.get(infoHash);
        if (content != null) {
            await this.getMetadataStore().remove(infoHash);
            await content.deleteHash();
        }
    }

    public getMetadataStore(): MetadataStore {
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
        let content: Content;
        let webRtcContentTransferer: WebRtcContentTransferer | null = null;
        if (metadata.source != null) {
            webRtcContentTransferer = new WebRtcContentTransferer(this, metadata.source, this.contentTransferer.getExternalIp());
            content = new Content(this, webRtcContentTransferer, metadata, this.dir);
        } else {
            content = new Content(this, this.contentTransferer, metadata, this.dir);
        }
        this.contentsNotVerified.set(content.metadata.infoHash, content);
        content.on("idle", () => {
            if (webRtcContentTransferer != null) {
                webRtcContentTransferer.disconnect();
            }
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
