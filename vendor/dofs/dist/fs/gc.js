const DEFAULT_SAFETY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export function gc(db, options = {}) {
    const now = (options.now ?? Date.now)();
    const safety = options.safetyWindowMs ?? DEFAULT_SAFETY_WINDOW_MS;
    const cutoff = now - safety;
    return db.transactionSync(() => {
        // Sweep orphan blobs: no row in vfs_chunks references the hash and
        // last_seen is older than the safety cutoff. vfs_blob_bytes
        // cascades on delete via the foreign key, so the bytes row goes
        // with its parent.
        db.run(`DELETE FROM vfs_blobs
        WHERE last_seen < ?
          AND NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = vfs_blobs.hash)`, cutoff);
        const blobsFreed = db.scalar("SELECT changes()") ?? 0;
        // Manifests share the blob safety window: a writer might have
        // inserted a manifest row but not yet linked it from vfs_nodes.
        // Inside the same transactionSync block this can't happen, but
        // keep the window as defence in depth for sync-layer code that
        // might stage manifests before linking nodes.
        db.run(`DELETE FROM vfs_manifests
        WHERE last_seen < ?
          AND NOT EXISTS (
            SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = vfs_manifests.hash
          )`, cutoff);
        const manifestsFreed = db.scalar("SELECT changes()") ?? 0;
        return { blobsFreed, manifestsFreed };
    });
}
