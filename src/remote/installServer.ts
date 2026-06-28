import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface ServerInfo {
    version: string,
    commit: string,
    serverUrlTemplate: string,
};

export async function getProductJson() {
    interface ProductJson {
        commit: string,
        version: string,
        serverDownloadUrlTemplate: string,
    }

    const jsonPath = path.join(vscode.env.appRoot, "product.json");
    const jsonData = JSON.parse(await fs.readFile(jsonPath, { encoding: "utf-8", flag: "r" })) as ProductJson;

    return {
        version: jsonData.version,
        commit: jsonData.commit,
        serverUrlTemplate: jsonData.serverDownloadUrlTemplate,
    };
}

export interface ScriptInstallInfo {
    port: number,
    extensions: string[],
    remoteEnvs: Record<string, string>,
    connectionToken: string,
    downloadTemplateUrl: string,
    codiumVersion: string,
    forceReinstall: boolean,
}

export function updateScript(script: string, info: ScriptInstallInfo, debug: boolean = false): string {
    let scriptCopy = script;

    if (debug) {
        scriptCopy = script.replace("#_CODIUM_INJECT_DEBUG_SET_X", "set -x");
    }

    const extensArgs = info.extensions
        .map(e => `--install-extension ${e}`)
        .join(" ");

    const remoteEnvs = (() => {
        const entries = Object.entries(info.remoteEnvs);
        if (entries.length === 0) {
            return "";
        }

        return entries
            .map(([k, v]) => `export ${k}=${v}`)
            .join(";\n")
            .concat("\n");
    })();

    scriptCopy = scriptCopy
        .replace("CODIUM_INJECT_INSTALL_EXTENSIONS", extensArgs)
        .replace("CODIUM_INJECT_SERVER_LISTEN_PORT", info.port.toString())
        .replace("CODIUM_INJECT_DOWNLOAD_URL", info.downloadTemplateUrl)
        .replace("CODIUM_INJECT_CODIUM_INSTALL_VERSION", info.codiumVersion)
        .replace("CODIUM_INJECT_TOKEN_VALUE", info.connectionToken)
        .replace("CODIUM_INJECT_FORCE_REINSTALL_SERVER", info.forceReinstall ? "true" : "false")
        .replace("#_CODIUM_INJECT_SERVER_LAUNCH_ENVS", remoteEnvs);

    return scriptCopy;
}

export const INSTALL_SCRIPT_LOCATION: string = path.join(__dirname, "installServer.sh");

export async function generateInstallScript(info: ScriptInstallInfo, debug: boolean = false) {
    const script = await fs.readFile(INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
    return updateScript(script, info, debug);
}
