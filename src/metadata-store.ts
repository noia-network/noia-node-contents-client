import * as EventEmitter from "events";
import * as fs from "fs-extra";
import StrictEventEmitter from "strict-event-emitter-types";

import { Helpers } from "./helpers";

export type ContentsMetadata = { [infoHash: string]: ContentMetadata };

export interface ContentMetadata {
    source?: string | null;
    infoHash: string;
    pieces: number;
    // Optional since supported in latest master only.
    piecesIntegrity?: string[];
}

export interface MetadataStoreEvents {
    added: (this: MetadataStore, content: ContentMetadata) => this;
    removed: (this: MetadataStore, infoHash: string) => this;
    notChanged: (this: MetadataStore, contents: ContentsMetadata) => this;
}

const MetadataStoreEmitter: { new (): StrictEventEmitter<EventEmitter, MetadataStoreEvents> } = EventEmitter;

export class MetadataStore extends MetadataStoreEmitter {
    constructor(public metadataPath: string = "metadata-store.json") {
        super();

        const contentsMetadata: ContentsMetadata = this.read();
        Object.keys(contentsMetadata).forEach(infoHash => {
            // TODO: Investigate nextTick in `noia-node` scenario.
            process.nextTick(() => {
                this.emit("added", contentsMetadata[infoHash]);
            });
        });
    }

    public async add(metadata: ContentMetadata): Promise<void> {
        const contentsMetadata = this.read();
        const contentMetadata = Helpers.filterContentProps(metadata);
        contentsMetadata[contentMetadata.infoHash] = contentMetadata;
        await this.write(contentsMetadata);
    }

    public get(infoHash: string): ContentMetadata {
        const contents = this.read();
        return contents[infoHash];
    }

    public clear(): void {
        this.write({});
    }

    public async remove(infoHash: string): Promise<void> {
        const contentsMetadata = this.read();
        delete contentsMetadata[infoHash];
        await this.write(contentsMetadata);
    }

    private async write(contents: ContentsMetadata): Promise<void> {
        const oldContentsIds = Object.keys(this.read());
        const newContentsIds = Object.keys(contents);
        const removedIds = oldContentsIds.filter(o => !newContentsIds.find(n => o === n));
        const addedIds = newContentsIds.filter(n => !oldContentsIds.find(o => n === o));
        let notChanged = true;
        for (const addedContentId of addedIds) {
            notChanged = false;
            this.emit("added", contents[addedContentId]);
        }
        for (const removedContentId of removedIds) {
            notChanged = false;
            this.emit("removed", removedContentId);
        }
        if (notChanged) {
            this.emit("notChanged", contents);
        }

        try {
            return await fs.writeJson(this.metadataPath, contents, { spaces: 4 });
        } catch (err) {
            if (err.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw err;
            }
        }
    }

    private read(): ContentsMetadata {
        try {
            return fs.readJsonSync(this.metadataPath);
        } catch (err) {
            if (err.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw err;
            }
        }
    }
}
