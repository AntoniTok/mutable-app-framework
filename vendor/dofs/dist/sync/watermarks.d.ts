import type { Database } from "../storage.js";
export type WatermarkKey = "pushRev";
export declare const DEFAULT_BACKEND_ID = "default";
export type ChangeCursor = {
    rev: number;
    path: string | null;
};
export declare function readWatermark(db: Database, key: WatermarkKey, backend?: string): number;
export declare function writeWatermark(db: Database, key: WatermarkKey, value: number, backend?: string): void;
export declare function readFetchCursor(db: Database, backend?: string): ChangeCursor;
export declare function writeFetchCursor(db: Database, cursor: ChangeCursor, backend?: string): void;
export declare function compareChangeCursors(a: ChangeCursor, b: ChangeCursor): number;
export declare function currentRev(db: Database): number;
