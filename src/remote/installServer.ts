import * as path from "node:path";
import * as fs from "node:fs/promises";

import { ShutdownAction } from "../parser/schema";

export interface ScriptInstallInfo {
    port: number,
    extensions: string[],
    connectionToken: string,
    downloadTemplateUrl: string,
    serverVersion: string,
    serverCommit: string,
    forceReinstall: boolean,
    shutdownAction: ShutdownAction,
}

export function updateScript(script: string, info: ScriptInstallInfo, debug: boolean = false): string {
    let scriptCopy = script;

    if (debug) {
        scriptCopy = script.replaceAll("#_CODIUM_INJECT_DEBUG_SET_X", "set -x");
    }

    const extensArgs = info.extensions
        .map(e => `--install-extension ${e}`)
        .join(" ");

    scriptCopy = scriptCopy
        .replaceAll("CODIUM_INJECT_INSTALL_EXTENSIONS", extensArgs)
        .replaceAll("CODIUM_INJECT_SERVER_LISTEN_PORT", info.port.toString())
        .replaceAll("CODIUM_INJECT_DOWNLOAD_URL", info.downloadTemplateUrl)
        .replaceAll("CODIUM_INJECT_CODIUM_INSTALL_VERSION", info.serverVersion)
        .replaceAll("CODIUM_INJECT_SERVER_COMMIT", info.serverCommit)
        .replaceAll("CODIUM_INJECT_TOKEN_VALUE", info.connectionToken)
        .replaceAll("CODIUM_INJECT_FORCE_REINSTALL_SERVER", info.forceReinstall ? "true" : "false")
        .replaceAll("CODIUM_INJECT_SHUTDOWN_ACTION", info.shutdownAction);

    return scriptCopy;
}

export const INSTALL_SCRIPT_LOCATION: string = path.join(__dirname, "installServer.sh");

export async function generateInstallScript(info: ScriptInstallInfo, debug: boolean = false) {
    const script = await fs.readFile(INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
    return updateScript(script, info, debug);
}
