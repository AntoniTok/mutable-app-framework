import type { Database } from "../storage.js";
export interface WorkspaceDirentResult {
    name: string;
    parentPath: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}
export declare function readdir(db: Database, path: string): WorkspaceDirentResult[];
