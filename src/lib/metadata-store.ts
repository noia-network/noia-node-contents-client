import EventEmitter from "events";
import fs from "fs";
import jsonfile from "jsonfile";

import { filterContentProps } from "./common";

export = class MetadataStore extends EventEmitter {
    public file: any;
    public ready: any;

    constructor(metadataPath: any) {
        super();
        this.file = metadataPath ? metadataPath : "metadata-store.json";
        if (!fs.existsSync(this.file)) {
            this._write({});
        }
        try {
            JSON.parse(JSON.stringify(this._read()));
        } catch (ex) {
            this._write({});
        }

        const contents = this._read();
        Object.keys(contents).forEach(infoHash => {
            process.nextTick(() => {
                this.emit("added", contents[infoHash]);
            });
        });
        this.ready = true;
    }

    add(metadata: any) {
        const contents = this._read();
        const content = filterContentProps(metadata);
        contents[content.infoHash] = content;
        this._write(contents);
    }

    get(infoHash: any) {
        const contents = this._read();
        return contents[infoHash];
    }

    clear() {
        this._write({});
    }

    remove(infoHash: any) {
        const contents = this._read();
        delete contents[infoHash];
        this._write(contents);
    }

    _write(contents: any) {
        if (this.ready) {
            const oldContents = Object.keys(this._read());
            const newContents = Object.keys(contents);
            const removed = oldContents.filter(o => !newContents.find(n => o == n));
            const added = newContents.filter(n => !oldContents.find(o => n == o));
            let notChanged = true;
            added.forEach(infoHash => {
                notChanged = false;
                this.emit("added", contents[infoHash]);
            });
            removed.forEach(infoHash => {
                notChanged = false;
                this.emit("removed", infoHash);
            });
            if (notChanged) {
                this.emit("notChanged", contents);
            }
        }

        try {
            jsonfile.writeFileSync(this.file, contents, { spaces: 2 });
        } catch (ex) {
            if (ex.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw ex;
            }
        }
    }

    _read() {
        try {
            return jsonfile.readFileSync(this.file);
        } catch (ex) {
            if (ex.code === "EPERM") {
                throw new Error("File access permissions violation. Open application as an administrator.");
            } else {
                throw ex;
            }
        }
    }
};
