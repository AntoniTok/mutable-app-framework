import { createWorkspaceError } from "../errors.js";
// Stream chunk bytes by hash. The receiver collects these into the
// keyed map it uses when assembling files from ChangeEntry chunks.
// Missing hashes throw — the caller is supposed to have probed
// hasObjects() first to avoid asking for what the sender doesn't have.
//
// The push direction (DO → container) and the fetch direction
// (container → DO) both use this same shape; on the wire it is
// fetchObjects on one side and pushObjects on the other. Both names
// resolve to the same SQL.
export async function* pushObjects(db, hashes) {
    for (const hash of hashes) {
        const row = db.one("SELECT bytes FROM vfs_blob_bytes WHERE hash = ?", hash);
        if (row === undefined) {
            throw createWorkspaceError("EUNKNOWN_HASH", "pushObjects: missing blob for requested hash");
        }
        yield { hash, bytes: row.bytes };
    }
}
