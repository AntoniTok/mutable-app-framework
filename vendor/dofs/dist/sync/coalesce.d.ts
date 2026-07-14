import type { Database } from "../storage.js";
import { type ChangeEntry } from "./changes.js";
import { type ChangeCursor } from "./watermarks.js";
export interface CoalesceOptions {
    ignore?: string[];
    through?: ChangeCursor;
}
export declare function coalesceChanges(db: Database, after: ChangeCursor | number, options?: CoalesceOptions): AsyncIterable<ChangeEntry>;
