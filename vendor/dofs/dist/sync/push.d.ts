import type { Database } from "../storage.js";
export declare function pushObjects(db: Database, hashes: Uint8Array[]): AsyncIterable<{
    hash: Uint8Array;
    bytes: Uint8Array;
}>;
