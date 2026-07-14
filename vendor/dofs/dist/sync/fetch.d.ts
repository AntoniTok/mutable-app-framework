import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import type { ChangeCursor } from "./watermarks.js";
export declare function fetchChanges(db: Database, after: ChangeCursor | number, options?: {
    ignore?: string[];
}): AsyncIterable<ChangeEntry>;
export declare function fetchObjects(db: Database, hashes: Uint8Array[]): AsyncIterable<{
    hash: Uint8Array;
    bytes: Uint8Array;
}>;
export declare function hasObjects(db: Database, hashes: Uint8Array[]): Uint8Array[];
