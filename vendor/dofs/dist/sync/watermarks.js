export const DEFAULT_BACKEND_ID = "default";
export function readWatermark(db, key, backend = DEFAULT_BACKEND_ID) {
    return (db.scalar("SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?", key, backend) ?? 0);
}
function readFetchRev(db, backend = DEFAULT_BACKEND_ID) {
    return (db.scalar("SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?", "fetchRev", backend) ?? 0);
}
function writeWatermarkValue(db, key, value, backend = DEFAULT_BACKEND_ID) {
    db.run("INSERT INTO _vfs_watermark (k, backend, v) VALUES (?, ?, ?) " +
        "ON CONFLICT(k, backend) DO UPDATE SET v = excluded.v", key, backend, value);
}
function writeFetchCursorPath(db, path, backend = DEFAULT_BACKEND_ID) {
    db.run("INSERT INTO _vfs_fetch_cursor (k, backend, path) VALUES (?, ?, ?) " +
        "ON CONFLICT(k, backend) DO UPDATE SET path = excluded.path", "fetch", backend, path);
}
export function writeWatermark(db, key, value, backend = DEFAULT_BACKEND_ID) {
    writeWatermarkValue(db, key, value, backend);
}
export function readFetchCursor(db, backend = DEFAULT_BACKEND_ID) {
    const rev = readFetchRev(db, backend);
    if (rev === 0)
        return { rev: 0, path: null };
    const path = db.scalar("SELECT path FROM _vfs_fetch_cursor WHERE k = ? AND backend = ?", "fetch", backend);
    return { rev, path: path ?? null };
}
export function writeFetchCursor(db, cursor, backend = DEFAULT_BACKEND_ID) {
    db.transactionSync(() => {
        writeWatermarkValue(db, "fetchRev", cursor.rev, backend);
        writeFetchCursorPath(db, cursor.path, backend);
    });
}
export function compareChangeCursors(a, b) {
    if (a.rev !== b.rev)
        return a.rev - b.rev;
    if (a.path === b.path)
        return 0;
    if (a.path === null)
        return 1;
    if (b.path === null)
        return -1;
    return a.path < b.path ? -1 : 1;
}
// The latest rev stamped on any DO-side mutation. coalesceChanges
// reads this implicitly via vfs_nodes.rev; the sync layer exposes it
// to callers that want to record the rev component of their next
// cursor.
export function currentRev(db) {
    return db.scalar("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
}
