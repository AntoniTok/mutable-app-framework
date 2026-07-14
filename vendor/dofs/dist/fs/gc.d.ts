import type { Database } from "../storage.js";
export interface GcOptions {
    now?: () => number;
    safetyWindowMs?: number;
}
export interface GcResult {
    blobsFreed: number;
    manifestsFreed: number;
}
export declare function gc(db: Database, options?: GcOptions): GcResult;
