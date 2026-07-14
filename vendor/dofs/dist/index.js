export { createWorkspaceError } from "./errors.js";
export { chmod } from "./fs/chmod.js";
export { WorkspaceFilesystem, } from "./fs/filesystem.js";
export { link } from "./fs/link.js";
// Read-only mount enforcement. The workspace-side indexer writes
// _vfs_mounts; the helpers here let it invalidate the in-Database
// cache after a write, and let dofs callers (and tests) inspect or
// assert against the registered roots without re-implementing the
// overlap check.
export { assertNotReadOnly, getReadOnlyMountRoots, invalidateReadOnlyMountCache, readOnlyRootFor, } from "./fs/mount-guard.js";
export { readlink } from "./fs/readlink.js";
export { lstat, stat } from "./fs/stat.js";
export { symlink } from "./fs/symlink.js";
export { SQLiteWorkspaceProvider } from "./provider.js";
export { initializeSchema, ROOT_INODE, SCHEMA_VERSION } from "./schema/index.js";
export { Database } from "./storage.js";
// Sync protocol building blocks. The wire wiring lives in
// @cloudflare/workspace-rpc; these are the helpers that wiring binds
// to a Database.
export { applyChanges, applyChangesSync } from "./sync/apply.js";
export { stageBlob } from "./sync/blobs.js";
export { materialiseChange } from "./sync/changes.js";
export { coalesceChanges } from "./sync/coalesce.js";
export { fetchChanges, fetchObjects, hasObjects } from "./sync/fetch.js";
export { DEFAULT_IGNORE, isIgnored } from "./sync/ignore.js";
export { assertAppliedPushCursor } from "./sync/invariant.js";
export { buildManifest, MANIFEST_VERSION } from "./sync/manifests.js";
export { pushObjects } from "./sync/push.js";
export { compareChangeCursors, currentRev, readFetchCursor, readWatermark, writeFetchCursor, writeWatermark, } from "./sync/watermarks.js";
// RecordingStorage is workerd-safe (pure JS). SQLiteTestStorage
// wraps node:sqlite and must be imported from
// '@cloudflare/dofs/testing' under node-only call sites.
export { RecordingStorage } from "./testing-recording.js";
