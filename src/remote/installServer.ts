import * as path from "node:path";
import * as fs from "node:fs/promises";

import { ShutdownAction } from "../parser/schema";
import { ServerLaunchConfig } from "./codium-daemon-monitor";

export interface ScriptInstallInfo {
    port: number,
    extensions: string[],
    connectionToken: string,
    downloadTemplateUrl: string,
    serverDir: string,
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

    const config: ServerLaunchConfig = {
        host: "0.0.0.0",
        port: `${info.port}`,
        serverDir: info.serverDir,
        serverCommit: info.serverCommit,
        extensions: info.extensions,
        connectionToken: info.connectionToken,
        shutdownAction: info.shutdownAction,
    };

    const hexConfig = Buffer.from(JSON.stringify(config), "utf-8").toString("hex");

    scriptCopy = scriptCopy
        .replaceAll("CODIUM_INJECT_DOWNLOAD_URL", info.downloadTemplateUrl)
        .replaceAll("CODIUM_INJECT_SERVER_COMMIT", info.serverCommit)
        .replaceAll("CODIUM_INJECT_SERVER_VERSION", info.serverVersion)
        .replaceAll("CODIUM_INJECT_SERVER_ROOT_DIR", info.serverDir)
        .replaceAll("CODIUM_INJECT_SERVER_LAUNCH_CONFIG", hexConfig)
        .replaceAll("CODIUM_INJECT_SERVER_LISTEN_PORT", info.port.toString())
        .replaceAll("CODIUM_INJECT_FORCE_REINSTALL_SERVER", info.forceReinstall ? "true" : "false")
        .replaceAll("CODIUM_INJECT_SHUTDOWN_ACTION", info.shutdownAction);

    return scriptCopy;
}

export const INSTALL_SCRIPT_LOCATION: string = path.join(__dirname, "installServer.sh");
export const MONITOR_SCRIPT_LOCATION: string = path.join(__dirname, "codium-daemon-monitor.ts");

export async function generateInstallScript(info: ScriptInstallInfo, debug: boolean = false) {
    const script = await fs.readFile(INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
    return updateScript(script, info, debug);
}

export async function getMonitorScript() {
    return await fs.readFile(MONITOR_SCRIPT_LOCATION, { encoding: "utf-8" });
}
