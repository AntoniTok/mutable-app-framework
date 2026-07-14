import type { MkdirOptions } from "./fs/mkdir.js";
import { type WatchEvent, type WatchHandle, type WatchOptions } from "./fs/watch.js";
import { type WriteFileRange } from "./fs/writeFile.js";
import type { Database } from "./storage.js";
export interface SQLiteWorkspaceProviderOptions {
    now?: () => number;
    watchIntervalMs?: number;
}
interface VirtualStatsLike {
    dev: number;
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    rdev: number;
    blksize: number;
    ino: number;
    size: number;
    blocks: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
}
interface VirtualDirentLike {
    name: string;
    parentPath: string;
    path: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
}
export declare class SQLiteWorkspaceProvider {
    #private;
    readonly db: Database;
    readonly now: () => number;
    readonly readonly = false;
    readonly supportsSymlinks = true;
    readonly supportsWatch = true;
    readonly watchIntervalMs: number;
    constructor(db: Database, options?: SQLiteWorkspaceProviderOptions);
    open(path: string, flags?: string, mode?: number): Promise<number>;
    openSync(path: string, flags?: string, _mode?: number): number;
    stat(path: string, options?: {
        bigint?: boolean;
    }): Promise<VirtualStatsLike>;
    statSync(path: string, _options?: {
        bigint?: boolean;
    }): VirtualStatsLike;
    lstat(path: string, options?: {
        bigint?: boolean;
    }): Promise<VirtualStatsLike>;
    lstatSync(path: string, _options?: {
        bigint?: boolean;
    }): VirtualStatsLike;
    readdir(path: string, options?: {
        withFileTypes?: boolean;
    }): Promise<string[] | VirtualDirentLike[]>;
    readdirSync(path: string, options?: {
        withFileTypes?: boolean;
    }): string[] | VirtualDirentLike[];
    mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
    mkdirSync(path: string, options?: MkdirOptions): string | undefined;
    rmdir(path: string): Promise<void>;
    rmdirSync(path: string): void;
    unlink(path: string): Promise<void>;
    unlinkSync(path: string): void;
    link(existingPath: string, newPath: string): Promise<void>;
    linkSync(existingPath: string, newPath: string): void;
    rename(oldPath: string, newPath: string): Promise<void>;
    renameSync(oldPath: string, newPath: string): void;
    readFile(path: string, options?: BufferEncoding | {
        encoding?: BufferEncoding | null;
    } | null): Promise<Buffer | string>;
    readFileSync(path: string, options?: BufferEncoding | {
        encoding?: BufferEncoding | null;
    } | null): Buffer | string;
    writeFile(path: string, data: string | Buffer, options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): Promise<void>;
    writeFileSync(path: string, data: string | Buffer, options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): void;
    writeFileRangesSync(path: string, data: string | Buffer, ranges: WriteFileRange[], options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): void;
    createFileSync(path: string, options?: {
        mode?: number;
    }): void;
    writeRangeSync(path: string, data: string | Buffer | Uint8Array, offset: number, options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): number;
    truncateFileSync(path: string, len: number): void;
    openWriteBufferSync(path: string): void;
    openWriteBufferForCreateSync(path: string, options?: {
        mode?: number;
    }): void;
    releaseWriteBufferSync(path: string): void;
    chmodSync(path: string, mode: number): void;
    appendFile(_path: string, _data: string | Buffer, _options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): Promise<void>;
    appendFileSync(_path: string, _data: string | Buffer, _options?: {
        encoding?: BufferEncoding;
        mode?: number;
    } | BufferEncoding): void;
    exists(path: string): Promise<boolean>;
    existsSync(path: string): boolean;
    copyFile(_src: string, _dest: string, _mode?: number): Promise<void>;
    copyFileSync(_src: string, _dest: string, _mode?: number): void;
    internalModuleStat(_path: string): number;
    realpath(path: string, _options?: {
        encoding?: BufferEncoding;
    }): Promise<string>;
    realpathSync(path: string, _options?: {
        encoding?: BufferEncoding;
    }): string;
    access(path: string, _mode?: number): Promise<void>;
    accessSync(path: string, _mode?: number): void;
    closeSync(fd: number): void;
    readSync(fd: number, buffer: Buffer | Uint8Array, offset: number, length: number, position: number | null): number;
    readRangeSync(path: string, offset: number, length: number): Buffer;
    writeSync(fd: number, buffer: Buffer | Uint8Array, offset?: number, length?: number, position?: number | null): number;
    fstatSync(fd: number, _options?: {
        bigint?: boolean;
    }): VirtualStatsLike;
    truncateSync(path: string, len: number): void;
    ftruncateSync(fd: number, len: number): void;
    readlink(path: string, _options?: {
        encoding?: BufferEncoding;
    }): Promise<string>;
    readlinkSync(path: string, _options?: {
        encoding?: BufferEncoding;
    }): string;
    symlink(target: string, path: string, _type?: string): Promise<void>;
    symlinkSync(target: string, path: string, _type?: string): void;
    watch(path: string, options?: WatchOptions): WatchHandle;
    watchAsync(path: string, options?: WatchOptions): AsyncIterable<WatchEvent>;
    watchFile(_path: string, _options?: unknown, _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void): unknown;
    unwatchFile(_path: string, _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void): void;
}
export {};
