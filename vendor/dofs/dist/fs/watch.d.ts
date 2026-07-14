import { EventEmitter } from "node:events";
import type { Database } from "../storage.js";
export interface WatchOptions {
    recursive?: boolean;
    signal?: AbortSignal;
    interval?: number;
}
export interface WatchEvent {
    eventType: "rename" | "change";
    filename: string;
}
export interface WatchHandle extends EventEmitter {
    close(): void;
}
export declare function createWatcher(db: Database, path: string, options: WatchOptions, defaultInterval: number): WatchHandle;
export declare function createWatchAsyncIterable(watcher: WatchHandle): AsyncIterable<WatchEvent> & {
    return(): Promise<{
        value: undefined;
        done: true;
    }>;
};
