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

// Mirrors the exit codes in installServer.sh. tests/installError.test.ts checks they stay in sync.
export enum InstallScriptError {
    EXIT_OK = 0,
    UNSUPPORTED_PLATFORM = 11,
    DEPENDENCIES_NOT_INSTALLED = 12,
    SERVER_DOWNLOAD_FAILED = 13,
    SERVER_INSTALL_FAILED = 14,
    WRITE_STATE_FILES_FAILED = 15,
    INSTALL_RETRIES_FAILED = 16,
    INSTALL_LOCK_TIMEOUT = 17,
    BAD_ARGS = 20,
};

const FALLBACK_TAIL_LINES = 10;

/**
 * Builds a hopefully user-readable error string from the output of the install script
 *
 * Looks for INSTALL_SCRIPT_ERROR lines and EXITCODE in stdout to format the message. Returns
 * tail 10 of stdout + stderr if there are no matches for INSTALL_SCRIPT_ERROR.
 */
export function formatInstallError(res: { exit: number | string, stdout: string, stderr: string }): string {
    const exitCodeRegex = /^EXITCODE\[\[CODE:(\d+)\]\]$/m;
    const installScriptRegex = /^INSTALL_SCRIPT_ERROR:(.*)/gm;

    const codeMatch = exitCodeRegex.exec(res.stdout);
    // res.exit can be a signal name if the script was killed
    const code = codeMatch ? Number(codeMatch[1]) : res.exit;
    const codeName = (typeof code === "number" ? InstallScriptError[code] : undefined) ?? "UNKNOWN";

    const errLines = Array.from(res.stdout.matchAll(installScriptRegex))
        .map(m => m[1].trimEnd())
        .filter(l => l.trim().length > 0);

    const details = (() => {
        if (errLines.length > 0) {
            return errLines.join("\n");
        }

        const prefix = (str: string) => {
            if (str.length === 0) { return ""; }
            return str
                .split("\n")
                .map(s => `>> ${s}`)
                .slice(-FALLBACK_TAIL_LINES)
                .join("\n");
        };

        const stdoutTrim = prefix(res.stdout.trim());
        const stderrTrim = prefix(res.stderr.trim());

        return (stdoutTrim.length + stderrTrim.length) > 0
            ? (
                "INSTALL_SCRIPT_ERROR not found in stdout. This is probably a bug."
                + ((stdoutTrim.length > 0) ? `\nLast ${FALLBACK_TAIL_LINES} lines of stdout:\n${stdoutTrim}\n` : "")
                + ((stderrTrim.length > 0) ? `\nLast ${FALLBACK_TAIL_LINES} lines of stderr:\n${stderrTrim}\n` : "")
            )
            : "[Empty output from installScript.sh. This is probably a bug]";
    })();

    return `${codeName} (exit ${code}):\n${details}`;
}
