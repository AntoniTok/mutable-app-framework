// SQLiteWorkspaceProvider — a @platformatic/vfs VirtualProvider backed
// by the dofs SQLite store.
//
// Every method on VirtualProvider is declared. Methods we already have
// synchronous building blocks for delegate to the existing fs/ helpers;
// the rest throw ENOSYS so the gaps are visible at the call site.
// Subsequent commits fill in the stubs (file descriptors, positional
// I/O, truncate, symlinks, watch).
import { createWorkspaceError } from "./errors.js";
import { getBlobBytes } from "./fs/blobCache.js";
import { link as linkImpl } from "./fs/link.js";
import { mkdir as mkdirImpl } from "./fs/mkdir.js";
import { readdir as readdirImpl } from "./fs/readdir.js";
import { readRangeSync as readRangeSyncImpl } from "./fs/readFile.js";
import { readlink as readlinkImpl } from "./fs/readlink.js";
import { rename as renameImpl } from "./fs/rename.js";
import { resolveInode } from "./fs/resolve.js";
import { rm as rmImpl } from "./fs/rm.js";
import { stat as statImpl } from "./fs/stat.js";
import { symlink as symlinkImpl } from "./fs/symlink.js";
import { createWatchAsyncIterable, createWatcher, } from "./fs/watch.js";
import { deleteWriteBuffer, getPendingWriteBufferByPath, getWriteBuffer, } from "./fs/writeBuffer.js";
import { createFileSync as createFileSyncImpl, flushPendingByPath, openWriteBufferForCreateSync as openWriteBufferForCreateSyncImpl, openWriteBufferSync as openWriteBufferSyncImpl, releaseWriteBufferSync as releaseWriteBufferSyncImpl, truncateFileSync as truncateFileSyncImpl, writeFileRangesSync as writeFileRangesSyncImpl, writeFileSync as writeFileSyncImpl, writeRangeSync as writeRangeSyncImpl, } from "./fs/writeFile.js";
import { canonicalizePath } from "./path.js";
import { incrementRev } from "./rev.js";
export class SQLiteWorkspaceProvider {
    db;
    now;
    // Capability flags consulted by @platformatic/vfs callers.
    readonly = false;
    supportsSymlinks = true;
    supportsWatch = true;
    // Fd table. Start at 3 — 0/1/2 are reserved by convention even
    // though we don't expose them — so consumers that pass them around
    // can't accidentally collide with stdio mental models.
    #fds = new Map();
    #nextFd = 3;
    watchIntervalMs;
    constructor(db, options = {}) {
        this.db = db;
        this.now = options.now ?? Date.now;
        this.watchIntervalMs = options.watchIntervalMs ?? 100;
    }
    // -- Essential primitives ------------------------------------------
    open(path, flags, mode) {
        return Promise.resolve(this.openSync(path, flags, mode));
    }
    openSync(path, flags = "r", _mode) {
        const { read, write, truncate, append, create, exclusive } = parseFlags(flags);
        const existing = resolveInode(this.db, path);
        if (existing === null) {
            if (!create) {
                throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
            }
            writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
        }
        else {
            if (existing.type !== "file") {
                throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
            }
            if (exclusive) {
                throw createWorkspaceError("EEXIST", `path exists: ${path}`, path);
            }
            if (truncate) {
                writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
            }
        }
        const stat = statImpl(this.db, path);
        const fd = this.#nextFd++;
        this.#fds.set(fd, {
            path,
            position: append ? stat.size : 0,
            readable: read,
            writable: write,
            append,
        });
        return fd;
    }
    stat(path, options) {
        return Promise.resolve(this.statSync(path, options));
    }
    statSync(path, _options) {
        // statImpl resolves the path once (following symlinks) and returns
        // the inode, so nlink comes from the same walk. A pending-create
        // file reports inode 0, which yields nlink 1.
        const s = statImpl(this.db, path);
        return wrapStats({
            mode: s.mode,
            size: s.size,
            mtimeMs: s.mtime,
            ino: s.inode,
            isFile: s.isFile,
            isDirectory: s.isDirectory,
            isSymbolicLink: false,
            nlink: linkCount(this.db, s.inode),
        });
    }
    lstat(path, options) {
        return Promise.resolve(this.lstatSync(path, options));
    }
    lstatSync(path, _options) {
        const { path: canonical } = canonicalizePath(path);
        const pending = getPendingWriteBufferByPath(this.db, canonical);
        if (pending !== undefined && pending.pending !== undefined) {
            return wrapStats({
                mode: pending.mode & 0o7777,
                size: pending.size,
                mtimeMs: pending.pending.mtime,
                ino: 0,
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                nlink: 1,
            });
        }
        const node = resolveInode(this.db, path, { followSymlinks: false });
        if (node === null) {
            throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
        }
        const isSymlink = node.type === "symlink";
        const size = isSymlink
            ? (node.linkTarget ?? "").length
            : node.type === "file"
                ? fileSize(this.db, node.inode)
                : 0;
        return wrapStats({
            mode: node.mode,
            size,
            mtimeMs: node.mtime,
            ino: node.inode,
            isFile: node.type === "file",
            isDirectory: node.type === "dir",
            isSymbolicLink: isSymlink,
            nlink: linkCount(this.db, node.inode),
        });
    }
    readdir(path, options) {
        return Promise.resolve(this.readdirSync(path, options));
    }
    readdirSync(path, options) {
        const entries = readdirImpl(this.db, path);
        if (options?.withFileTypes === true) {
            return entries.map((entry) => wrapDirent(entry));
        }
        return entries.map((entry) => entry.name);
    }
    mkdir(path, options) {
        return Promise.resolve(this.mkdirSync(path, options));
    }
    mkdirSync(path, options) {
        mkdirImpl(this.db, path, options ?? {}, this.now);
        return undefined;
    }
    rmdir(path) {
        this.rmdirSync(path);
        return Promise.resolve();
    }
    rmdirSync(path) {
        rmImpl(this.db, path, {});
    }
    unlink(path) {
        this.unlinkSync(path);
        return Promise.resolve();
    }
    unlinkSync(path) {
        // If a buffered create is still pending for this path, commit
        // it first so rm sees a real inode to unlink (and so the
        // resulting GC sees the orphaned blob, matching the non-buffered
        // shape). The buffer's open handles continue to address bytes
        // through the inode-keyed cache.
        flushPendingByPath(this.db, path, this.now);
        // Capture the target inode before rm runs so we can evict its
        // write-buffer cache entry if rm removed the last link. Without
        // this, a release-after-unlink leaves the buffer dangling on a
        // dead inode and the eventual commit silently affects no rows.
        const target = resolveInode(this.db, path, { followSymlinks: false });
        rmImpl(this.db, path, {});
        if (target !== null) {
            const stillAlive = this.db.scalar("SELECT inode FROM vfs_nodes WHERE inode = ?", target.inode);
            if (stillAlive === undefined) {
                deleteWriteBuffer(this.db, target.inode);
            }
        }
    }
    link(existingPath, newPath) {
        this.linkSync(existingPath, newPath);
        return Promise.resolve();
    }
    linkSync(existingPath, newPath) {
        // Commit a still-pending source before adding the second dirent,
        // otherwise link has nothing real to point at. Also commit a
        // still-pending destination: link's existence check looks at
        // dirents, so a pending buffer at newPath wouldn't trip it, and
        // the eventual release on that pending buffer would re-check the
        // dirent in commitPendingBuffer, throw EEXIST, drop the entry,
        // and silently lose the user's bytes.
        flushPendingByPath(this.db, existingPath, this.now);
        flushPendingByPath(this.db, newPath, this.now);
        linkImpl(this.db, existingPath, newPath);
    }
    rename(oldPath, newPath) {
        this.renameSync(oldPath, newPath);
        return Promise.resolve();
    }
    renameSync(oldPath, newPath) {
        // Commit any still-pending creates at either end before the rename
        // touches dirents: the source needs a real inode to move, and a
        // pending buffer at the destination would otherwise slip past
        // rename's dirent-based existence check and lose bytes on release.
        flushPendingByPath(this.db, oldPath, this.now);
        flushPendingByPath(this.db, newPath, this.now);
        // Capture the destination inode before the rename so we can evict
        // its write-buffer cache entry if the rename displaced and reaped
        // it. Without this, a release on an open destination would commit
        // chunks against a dead inode (0-row UPDATE, silent data loss).
        const displaced = resolveInode(this.db, newPath, { followSymlinks: false });
        renameImpl(this.db, oldPath, newPath);
        if (displaced !== null) {
            const stillAlive = this.db.scalar("SELECT inode FROM vfs_nodes WHERE inode = ?", displaced.inode);
            if (stillAlive === undefined) {
                deleteWriteBuffer(this.db, displaced.inode);
            }
        }
    }
    // -- Default implementations ---------------------------------------
    readFile(path, options) {
        return Promise.resolve(this.readFileSync(path, options));
    }
    readFileSync(path, options) {
        const encoding = typeof options === "string" ? options : options?.encoding;
        const { path: canonical } = canonicalizePath(path);
        const pending = getPendingWriteBufferByPath(this.db, canonical);
        if (pending !== undefined) {
            const snapshot = Buffer.alloc(pending.size);
            snapshot.set(pending.buf.subarray(0, pending.size));
            return encoding ? snapshot.toString(encoding) : snapshot;
        }
        const node = resolveInode(this.db, path);
        if (node === null) {
            throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
        }
        if (node.type !== "file") {
            throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
        }
        // While a buffer is open for this inode it owns the latest
        // bytes; serve from it instead of the chunk store.
        const buffered = getWriteBuffer(this.db, node.inode);
        if (buffered?.dirty) {
            const snapshot = Buffer.alloc(buffered.size);
            snapshot.set(buffered.buf.subarray(0, buffered.size));
            return encoding ? snapshot.toString(encoding) : snapshot;
        }
        const chunks = this.db.all("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", node.inode);
        let total = 0;
        for (const c of chunks)
            total += c.size;
        const out = Buffer.alloc(total);
        let offset = 0;
        for (const chunk of chunks) {
            const bytes = getBlobBytes(this.db, chunk.hash);
            if (bytes === undefined) {
                throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
            }
            out.set(bytes, offset);
            offset += bytes.byteLength;
        }
        return encoding ? out.toString(encoding) : out;
    }
    writeFile(path, data, options) {
        this.writeFileSync(path, data, options);
        return Promise.resolve();
    }
    writeFileSync(path, data, options) {
        const mode = typeof options === "string" ? undefined : options?.mode;
        const bytes = typeof data === "string"
            ? new TextEncoder().encode(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        writeFileSyncImpl(this.db, path, bytes, { mode }, this.now);
    }
    writeFileRangesSync(path, data, ranges, options) {
        const mode = typeof options === "string" ? undefined : options?.mode;
        const bytes = typeof data === "string"
            ? new TextEncoder().encode(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        writeFileRangesSyncImpl(this.db, path, bytes, ranges, { mode }, this.now);
    }
    createFileSync(path, options) {
        createFileSyncImpl(this.db, path, { mode: options?.mode }, this.now);
    }
    writeRangeSync(path, data, offset, options) {
        const mode = typeof options === "string" ? undefined : options?.mode;
        const bytes = typeof data === "string"
            ? new TextEncoder().encode(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        return writeRangeSyncImpl(this.db, path, bytes, offset, { mode }, this.now);
    }
    truncateFileSync(path, len) {
        truncateFileSyncImpl(this.db, path, len, this.now);
    }
    openWriteBufferSync(path) {
        openWriteBufferSyncImpl(this.db, path);
    }
    openWriteBufferForCreateSync(path, options) {
        openWriteBufferForCreateSyncImpl(this.db, path, { mode: options?.mode }, this.now);
    }
    releaseWriteBufferSync(path) {
        releaseWriteBufferSyncImpl(this.db, path, this.now);
    }
    chmodSync(path, mode) {
        const { path: canonical } = canonicalizePath(path);
        const pending = getPendingWriteBufferByPath(this.db, canonical);
        if (pending !== undefined) {
            // Pending-create files don't have a row yet; stash the mode on
            // the buffer so the eventual INSERT picks it up.
            pending.mode = mode & 0o7777;
            return;
        }
        const node = resolveInode(this.db, path, { followSymlinks: false });
        if (node === null) {
            throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
        }
        const rev = incrementRev(this.db);
        this.db.run("UPDATE vfs_nodes SET mode = ?, rev = ? WHERE inode = ?", mode & 0o7777, rev, node.inode);
    }
    appendFile(_path, _data, _options) {
        return Promise.reject(notImplemented("appendFile"));
    }
    appendFileSync(_path, _data, _options) {
        throw notImplemented("appendFileSync");
    }
    exists(path) {
        return Promise.resolve(this.existsSync(path));
    }
    existsSync(path) {
        try {
            const { path: canonical } = canonicalizePath(path);
            if (getPendingWriteBufferByPath(this.db, canonical) !== undefined)
                return true;
            return resolveInode(this.db, path) !== null;
        }
        catch {
            return false;
        }
    }
    copyFile(_src, _dest, _mode) {
        return Promise.reject(notImplemented("copyFile"));
    }
    copyFileSync(_src, _dest, _mode) {
        throw notImplemented("copyFileSync");
    }
    internalModuleStat(_path) {
        // Used by node:vfs module-resolution hooks. The wsd driver doesn't
        // need it; if this provider is ever mounted via `vfs.mount()` we'll
        // need to return 0 for files, 1 for dirs, -1 for not-found.
        throw notImplemented("internalModuleStat");
    }
    realpath(path, _options) {
        return Promise.resolve(this.realpathSync(path));
    }
    realpathSync(path, _options) {
        const { path: canonical } = canonicalizePath(path);
        if (resolveInode(this.db, canonical) === null) {
            throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
        }
        return canonical;
    }
    access(path, _mode) {
        this.accessSync(path);
        return Promise.resolve();
    }
    accessSync(path, _mode) {
        if (resolveInode(this.db, path) === null) {
            throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
        }
    }
    // -- File descriptors ----------------------------------------------
    closeSync(fd) {
        if (!this.#fds.delete(fd)) {
            throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
        }
    }
    readSync(fd, buffer, offset, length, position) {
        const state = this.#fdOrThrow(fd);
        if (!state.readable) {
            throw createWorkspaceError("EBADF", `fd ${fd} is not readable`);
        }
        const startAt = position ?? state.position;
        const slice = readRangeSyncImpl(this.db, state.path, startAt, length);
        const view = buffer instanceof Buffer
            ? buffer
            : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        view.set(slice, offset);
        if (position === null || position === undefined) {
            state.position = startAt + slice.byteLength;
        }
        return slice.byteLength;
    }
    readRangeSync(path, offset, length) {
        const slice = readRangeSyncImpl(this.db, path, offset, length);
        return Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
    }
    writeSync(fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
        const state = this.#fdOrThrow(fd);
        if (!state.writable) {
            throw createWorkspaceError("EBADF", `fd ${fd} is not writable`);
        }
        // Append needs the current EOF, so stat only then. A non-append
        // write of >0 bytes doesn't need it: writeRangeSyncImpl resolves the
        // path and raises ENOENT/EISDIR. A zero-length write short-circuits
        // before that resolve, so keep an explicit existence check for it.
        let startAt;
        if (state.append) {
            startAt = this.statSync(state.path).size;
        }
        else {
            if (length === 0) {
                this.statSync(state.path);
            }
            startAt = position ?? state.position;
        }
        const view = buffer instanceof Buffer
            ? new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)
            : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        writeRangeSyncImpl(this.db, state.path, view, startAt, {}, this.now);
        if (position === null || position === undefined) {
            state.position = startAt + length;
        }
        return length;
    }
    fstatSync(fd, _options) {
        const state = this.#fdOrThrow(fd);
        return this.statSync(state.path);
    }
    truncateSync(path, len) {
        const node = resolveInode(this.db, path);
        if (node === null) {
            throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
        }
        if (node.type !== "file") {
            throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
        }
        truncateFileSyncImpl(this.db, path, len, this.now);
    }
    ftruncateSync(fd, len) {
        const state = this.#fdOrThrow(fd);
        this.truncateSync(state.path, len);
    }
    #fdOrThrow(fd) {
        const state = this.#fds.get(fd);
        if (state === undefined) {
            throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
        }
        return state;
    }
    // -- Symlinks ------------------------------------------------------
    readlink(path, _options) {
        return Promise.resolve(this.readlinkSync(path));
    }
    readlinkSync(path, _options) {
        return readlinkImpl(this.db, path);
    }
    symlink(target, path, _type) {
        this.symlinkSync(target, path);
        return Promise.resolve();
    }
    symlinkSync(target, path, _type) {
        symlinkImpl(this.db, target, path, this.now);
    }
    // -- Watch ----------------------------------------------------------
    //
    // The watcher polls vfs_meta.rev on a timer. Each tick
    // coalesceChanges yields every path touched since the last
    // observed rev; we filter by the watched directory (and
    // recursive flag) and emit one 'change' event per path. Cheap
    // because coalesceChanges is one indexed range scan on
    // vfs_nodes.rev plus a path walk per touched inode.
    //
    // Event types follow node's fs.watch convention:
    //   - 'rename' for deletes (path went away)
    //   - 'change' for everything else (file/dir/symlink mutation)
    // We don't distinguish first-time creation from in-place edit
    // — the cost is a per-watcher state map that's bigger than
    // the signal is worth. Callers that need rename-vs-change
    // semantics can stat the path themselves.
    watch(path, options = {}) {
        return createWatcher(this.db, path, options, this.watchIntervalMs);
    }
    watchAsync(path, options = {}) {
        return createWatchAsyncIterable(this.watch(path, options));
    }
    // watchFile / unwatchFile fire on stat changes at a single path
    // (not the directory under it). Different semantics from watch();
    // editors typically use watch() instead. Leave as ENOSYS until a
    // real call site shows up.
    watchFile(_path, _options, _listener) {
        throw notImplemented("watchFile");
    }
    unwatchFile(_path, _listener) {
        throw notImplemented("unwatchFile");
    }
}
function notImplemented(method) {
    return createWorkspaceError("ENOSYS", `SQLiteWorkspaceProvider.${method} is not implemented yet`);
}
// POSIX mode-bit constants. Linux FUSE rejects a stat whose mode
// has no S_IF* bits set with EIO — it can't decide whether
// the inode is a regular file, a directory, or a symlink.
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
function fileTypeBits(input) {
    if (input.isDirectory)
        return S_IFDIR;
    if (input.isSymbolicLink)
        return S_IFLNK;
    if (input.isFile)
        return S_IFREG;
    return 0;
}
function linkCount(db, inode) {
    const count = db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?", inode);
    return Math.max(1, count ?? 0);
}
function fileSize(db, inode) {
    const buffered = getWriteBuffer(db, inode);
    if (buffered?.dirty) {
        return buffered.size;
    }
    return db.scalar("SELECT size FROM vfs_nodes WHERE inode = ?", inode) ?? 0;
}
function wrapStats(input) {
    const mtime = new Date(input.mtimeMs);
    return {
        dev: 0,
        mode: (input.mode & 0o7777) | fileTypeBits(input),
        nlink: input.nlink,
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: 4096,
        ino: input.ino,
        size: input.size,
        blocks: Math.ceil(input.size / 512),
        atimeMs: input.mtimeMs,
        mtimeMs: input.mtimeMs,
        ctimeMs: input.mtimeMs,
        birthtimeMs: input.mtimeMs,
        atime: mtime,
        mtime,
        ctime: mtime,
        birthtime: mtime,
        isFile: () => input.isFile,
        isDirectory: () => input.isDirectory,
        isSymbolicLink: () => input.isSymbolicLink,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
    };
}
function wrapDirent(input) {
    const fullPath = input.parentPath === "/" ? `/${input.name}` : `${input.parentPath}/${input.name}`;
    return {
        name: input.name,
        parentPath: input.parentPath,
        path: fullPath,
        isFile: () => input.isFile,
        isDirectory: () => input.isDirectory,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
    };
}
// Translate Node's fs flag strings into the boolean flag set the fd
// table uses. Mirrors the documented behaviour of fs.open(flags) at
// https://nodejs.org/api/fs.html#file-system-flags.
function parseFlags(flags) {
    switch (flags) {
        case "r":
            return {
                read: true,
                write: false,
                create: false,
                truncate: false,
                append: false,
                exclusive: false,
            };
        case "r+":
            return {
                read: true,
                write: true,
                create: false,
                truncate: false,
                append: false,
                exclusive: false,
            };
        case "w":
            return {
                read: false,
                write: true,
                create: true,
                truncate: true,
                append: false,
                exclusive: false,
            };
        case "w+":
            return {
                read: true,
                write: true,
                create: true,
                truncate: true,
                append: false,
                exclusive: false,
            };
        case "wx":
            return {
                read: false,
                write: true,
                create: true,
                truncate: false,
                append: false,
                exclusive: true,
            };
        case "wx+":
            return {
                read: true,
                write: true,
                create: true,
                truncate: false,
                append: false,
                exclusive: true,
            };
        case "a":
            return {
                read: false,
                write: true,
                create: true,
                truncate: false,
                append: true,
                exclusive: false,
            };
        case "a+":
            return {
                read: true,
                write: true,
                create: true,
                truncate: false,
                append: true,
                exclusive: false,
            };
        case "ax":
            return {
                read: false,
                write: true,
                create: true,
                truncate: false,
                append: true,
                exclusive: true,
            };
        case "ax+":
            return {
                read: true,
                write: true,
                create: true,
                truncate: false,
                append: true,
                exclusive: true,
            };
        default:
            throw createWorkspaceError("EINVAL", `unsupported fs flag: ${flags}`);
    }
}
