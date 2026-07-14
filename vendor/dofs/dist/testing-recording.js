class TestCursor {
    rows;
    constructor(rows) {
        this.rows = rows;
    }
    toArray() {
        return this.rows;
    }
}
export class RecordingStorage {
    statements = [];
    sql = {
        exec: (query, ...bindings) => {
            this.statements.push({ query, bindings });
            return new TestCursor(this.rowsFor(query, bindings));
        },
    };
    meta = new Map();
    constructor(seed) {
        if (seed?.schemaVersion !== undefined) {
            this.meta.set("schema_version", seed.schemaVersion);
        }
        if (seed?.rev !== undefined) {
            this.meta.set("rev", seed.rev);
        }
    }
    transactionSync(closure) {
        return closure();
    }
    rowsFor(query, bindings) {
        const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized === "select v from vfs_meta where k = ?") {
            const key = String(bindings[0]);
            const value = this.meta.get(key);
            return value === undefined ? [] : [{ v: value }];
        }
        if (normalized.startsWith("insert or ignore into vfs_meta")) {
            const key = String(bindings[0]);
            const value = Number(bindings[1]);
            if (!this.meta.has(key)) {
                this.meta.set(key, value);
            }
        }
        if (normalized.startsWith("update vfs_meta set v = ? where k = ?")) {
            this.meta.set(String(bindings[1]), Number(bindings[0]));
        }
        return [];
    }
}
