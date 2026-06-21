import path from "node:path";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";

/**
 *
 * @param localWsp : Full path to the local workspace folder, without resolving symlinks
 * @returns
 */
export function getWorkspaceId(localWsp: string): string {
    return crypto
        .createHash("sha256")
        .update(localWsp)
        .digest("hex")
        .slice(0, 8);
}

export function findDevcontainerJson(dir: string): string {
    const filePaths = [
        path.join(dir, ".devcontainer", "devcontainer.json"),
        path.join(dir, ".devcontainer.json"),
    ];

    for (const f of filePaths) {
        if (existsSync(f)) {
            return f;
        }
    }

    throw new Error(`devcontainer.json not found. Searched: ${filePaths.join(", ")}`);
}
