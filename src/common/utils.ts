import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import path from "node:path";

import { run } from "../common/cmd";
import { formatCmdErr } from "../common/spawn";
import { SpawnError } from "../extension/error";
import { Settings } from "../extension/settings";

export interface HostUserInfo {
    uid: number,
    gid: number,
    name: string,
};

/**
 *
 * @param envStdout null-char (env -0) seperated list of env vars
 * @returns Record<string, string | undefined>
 */
export function parseEnv(envStdout: string) {
    const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

    /* eslint-disable @stylistic/quotes */
    const envs: string[] = envStdout.split('\0').filter(Boolean);
    const parsedEnvs: Record<string, string> = {};

    for (const env of envs) {
        const eqIdx = env.indexOf('=');
        if (eqIdx === -1) { continue; }

        const k = env.slice(0, eqIdx);
        const v = env.slice(eqIdx + 1);

        if (!ENV_KEY_REGEX.test(k)) { continue; }

        parsedEnvs[k] = v;
    }
    return parsedEnvs;
    /* eslint-enable @stylistic/quotes */
}

/**
 * returns `[engine, ...engine_args]` in `engine <engine_args...>
 * command <command args...>`
 *
 * e.g., `[ "podman", "--root", "<root dir>"]` for
 * `podman --root <root dir> command <command args>`
*/
export function getEngineCmd(s: Settings): string[] {
    return [s.dockerPath, ...s.extraArgs];
}

export async function getHostUserInfo(): Promise<HostUserInfo> {
    const userName = await run(["/bin/sh", "-c", "id -n -u $UID"], {});
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    if (userName.exit === 0) {
        return {
            uid: process.getuid!(),
            gid: process.getgid!(),
            name: userName.stdout.trim(),
        };
    }
    else {
        throw new SpawnError(`Could not query host user info (uid, gid, name): ${formatCmdErr(userName)}`);
    }
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
}

export interface ProductJson {
    applicationName: string,
    dataFolderName: string,
    serverDataFolderName: string,
    sharedDataFolderName: string,
    commit: string,
    version: string,
    serverDownloadUrlTemplate: string,
};

export async function getProductJson(): Promise<ProductJson> {
    const jsonPath = path.join(vscode.env.appRoot, "product.json");
    const jsonData = JSON.parse(await fs.readFile(jsonPath, { encoding: "utf-8", flag: "r" })) as ProductJson;

    return {
        applicationName: jsonData.applicationName,
        dataFolderName: jsonData.dataFolderName,
        serverDataFolderName: jsonData.serverDataFolderName,
        sharedDataFolderName: jsonData.sharedDataFolderName,
        version: jsonData.version,
        commit: jsonData.commit,
        serverDownloadUrlTemplate: jsonData.serverDownloadUrlTemplate,
    };
}
