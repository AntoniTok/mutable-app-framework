// Directory watcher backed by polling vfs_meta.rev.
//
// On each tick, coalesceChanges yields every path touched since
// the watcher last looked. We filter by the watched directory and
// recursive flag, then emit one 'change' event per path with
// fs.watch-compatible (eventType, filename) arguments.
//
// The polling cadence is the provider's watchIntervalMs (default
// 100 ms). That's already what node's fs.watch uses internally on
// platforms without inotify, and it's slow enough that the SQL
// scan stays in the noise even with many watchers active.
//
// Coverage: there is no watch.test.ts here because watch is only
// reachable through SQLiteWorkspaceProvider.watch /
// watchAsyncIterable; the test surface is provider.watch.test.ts,
// which exercises both the EventEmitter and the AsyncIterable
// adapters end-to-end.
import { EventEmitter } from "node:events";
import { canonicalizePath } from "../path.js";
import { coalesceChanges } from "../sync/coalesce.js";
import { currentRev } from "../sync/watermarks.js";
export function createWatcher(db, path, options, defaultInterval) {
    const { path: canonical } = canonicalizePath(path);
    const prefix = canonical === "/" ? "/" : `${canonical}/`;
    const recursive = options.recursive === true;
    const interval = options.interval ?? defaultInterval;
    const emitter = new EventEmitter();
    let cursor = currentRev(db);
    let closed = false;
    const tick = async () => {
        if (closed)
            return;
        try {
            const seen = new Set();
            for await (const entry of coalesceChanges(db, cursor)) {
                // Filter to entries inside the watched scope.
                if (!isInScope(entry.path, canonical, prefix, recursive))
                    continue;
                if (seen.has(entry.path))
                    continue;
                seen.add(entry.path);
                const filename = relativeName(entry.path, canonical);
                const eventType = entry.kind === "delete" ? "rename" : "change";
                emitter.emit("change", eventType, filename);
            }
            cursor = currentRev(db);
        }
        catch (error) {
            emitter.emit("error", error);
        }
    };
    const handle = setInterval(() => void tick(), interval);
    handle.unref?.();
    emitter.close = () => {
        if (closed)
            return;
        closed = true;
        clearInterval(handle);
        emitter.emit("close");
    };
    if (options.signal !== undefined) {
        if (options.signal.aborted) {
            emitter.close();
        }
        else {
            options.signal.addEventListener("abort", () => emitter.close(), {
                once: true,
            });
        }
    }
    return emitter;
}
function isInScope(entryPath, watchedPath, prefix, recursive) {
    if (entryPath === watchedPath)
        return true;
    if (!entryPath.startsWith(prefix))
        return false;
    if (recursive)
        return true;
    // Non-recursive: only direct children. No extra '/' in the
    // remainder past the prefix.
    const remainder = entryPath.slice(prefix.length);
    return !remainder.includes("/");
}
function relativeName(entryPath, watchedPath) {
    if (entryPath === watchedPath)
        return "";
    const prefix = watchedPath === "/" ? "/" : `${watchedPath}/`;
    return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}
// Adapter from EventEmitter-based watcher to AsyncIterable for
// for-await consumers. Mirrors @platformatic/vfs's VFSWatchAsyncIterable.
export function createWatchAsyncIterable(watcher) {
    const pending = [];
    const waiters = [];
    let done = false;
    watcher.on("change", (eventType, filename) => {
        const event = { eventType, filename };
        const next = waiters.shift();
        if (next)
            next({ value: event, done: false });
        else
            pending.push(event);
    });
    watcher.on("close", () => {
        done = true;
        while (waiters.length > 0) {
            const next = waiters.shift();
            if (next)
                next({ value: undefined, done: true });
        }
    });
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next() {
            const buffered = pending.shift();
            if (buffered)
                return Promise.resolve({ value: buffered, done: false });
            if (done)
                return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
        },
        async return() {
            watcher.close();
            return { value: undefined, done: true };
        },
    };
}
