import * as crypto from "crypto";

import { ContentMetadata } from "./metadata-store";

export namespace Helpers {
    export function filterContentProps(metadata: ContentMetadata): ContentMetadata {
        return {
            source: metadata.source,
            infoHash: metadata.infoHash,
            pieces: metadata.pieces
        };
    }

    export function sha1(buf: Buffer): string {
        return crypto
            .createHash("sha1")
            .update(buf)
            .digest("hex");
    }
}
