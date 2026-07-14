import type { DurableObjectStorageLike, SQLCursorLike } from "./types.js";
export interface ExecutedStatement {
    query: string;
    bindings: unknown[];
}
export declare class RecordingStorage implements DurableObjectStorageLike {
    readonly statements: ExecutedStatement[];
    readonly sql: {
        exec: <Row extends object = Record<string, unknown>>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
    };
    private readonly meta;
    constructor(seed?: {
        schemaVersion?: number;
        rev?: number;
    });
    transactionSync<T>(closure: () => T): T;
    private rowsFor;
}
