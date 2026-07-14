import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
export interface SkippedEntry {
    path: string;
    mountRoot: string;
    op: "write" | "delete";
    reason: "read-only";
}
export interface ApplyResult {
    applied: number;
    skipped: SkippedEntry[];
}
export interface ApplyOptions {
    maxBytesPerBatch?: number;
    maxPathsPerBatch?: number;
    source?: "local" | "upstream";
    backend?: string;
}
export declare function applyChanges(db: Database, entries: Iterable<ChangeEntry> | AsyncIterable<ChangeEntry>, objects: Map<string, Uint8Array>, options?: ApplyOptions): Promise<ApplyResult>;
export declare function applyChangesSync(db: Database, entries: readonly ChangeEntry[], objects: Map<string, Uint8Array>, options?: ApplyOptions): ApplyResult;
