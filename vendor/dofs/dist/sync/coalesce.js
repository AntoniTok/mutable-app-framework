import { materialiseChange } from "./changes.js";
import { isIgnored } from "./ignore.js";
import { pathsOf } from "./paths.js";
import { compareChangeCursors } from "./watermarks.js";
export async function* coalesceChanges(db, after, options = {}) {
    const ignore = options.ignore ?? [];
    const cursor = typeof after === "number" ? { rev: after, path: null } : after;
    const through = options.through;
    const candidates = new Map();
    // Live mutations: every mkdir / writeFile / symlink bumps
    // vfs_nodes.rev. The by_rev index makes this a range scan.
    const lowerRev = cursor.path === null ? cursor.rev : cursor.rev - 1;
    const touched = through === undefined
        ? db.all("SELECT inode, rev FROM vfs_nodes WHERE rev > ? ORDER BY rev", lowerRev)
        : db.all("SELECT inode, rev FROM vfs_nodes WHERE rev > ? AND rev <= ? ORDER BY rev", lowerRev, through.rev);
    for (const { inode, rev } of touched) {
        // One inode can carry several hardlink names; every name has to
        // become a candidate so the wire materialises each, not just the
        // arbitrary one pathOf would return.
        for (const path of pathsOf(db, inode)) {
            if (!inCursorWindow({ rev, path }, cursor, through))
                continue;
            if (isIgnored(path, ignore))
                continue;
            const prior = candidates.get(path);
            if (prior === undefined || rev > prior.rev) {
                candidates.set(path, { path, rev });
            }
        }
    }
    // Tombstones: each rm appends a row to vfs_changes with the
    // post-bump rev. The highest rev per path wins (a path can be
    // deleted-recreated-deleted; we want the last rm's rev).
    const tombs = through === undefined
        ? db.all("SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND op = 'delete' GROUP BY path", lowerRev)
        : db.all("SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND rev <= ? AND op = 'delete' GROUP BY path", lowerRev, through.rev);
    for (const { path, rev } of tombs) {
        if (!inCursorWindow({ rev, path }, cursor, through))
            continue;
        if (isIgnored(path, ignore))
            continue;
        const prior = candidates.get(path);
        if (prior === undefined || rev > prior.rev) {
            candidates.set(path, { path, rev });
        }
    }
    // Sort by rev ascending so pullOnce can checkpoint per batch.
    // Ties on rev (same transactionSync touching multiple paths)
    // break on path so the wire order is deterministic.
    const ordered = Array.from(candidates.values()).sort((a, b) => {
        if (a.rev !== b.rev)
            return a.rev - b.rev;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    // materialiseChange reads each path's *current* state, not the state
    // it held at the candidate's rev — the VFS keeps no content history.
    // If a path was rewritten or deleted again after the scan, its live
    // rev can now sit above `through`; inCursorWindow drops it. The
    // dropped change is not lost: the rev that pushed it past `through`
    // is, by definition, greater than `through.rev` (the cursor the
    // puller persists), so the next pull's `after < entry` scan finds the
    // path again and delivers its then-current state. The consequence is
    // that a `{rev, null}` cursor means "every change committed at or
    // before rev has been *offered*"; it does not guarantee the receiver
    // tree byte-matches the rev snapshot for a path that raced ahead.
    // Convergence is preserved because the cursor never advances past the
    // racing rev. See docs/02_sync_protocol.md.
    for (const { path } of ordered) {
        const entry = materialiseChange(db, path);
        if (entry !== null && inCursorWindow(entry, cursor, through)) {
            yield entry;
        }
    }
}
function inCursorWindow(entry, after, through) {
    return (compareChangeCursors(entry, after) > 0 &&
        (through === undefined || compareChangeCursors(entry, through) <= 0));
}
