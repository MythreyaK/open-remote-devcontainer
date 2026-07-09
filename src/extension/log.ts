import path from "node:path";
import * as vscode from "vscode";

import * as consts from "node:constants";
import { close, mkdirSync, openSync, truncateSync, writeSync } from "node:fs";
import { EXTENSION_ID, EXTENSION_PRETTY_NAME } from "../common/constants";
import { getLocalWorkspaceFolder, getWorkspaceId } from "./workspace";
import { InternalError } from "./error";

let log: vscode.LogOutputChannel | undefined;
let logFile: string | undefined;

const LOG_FLAGS = consts.O_NOFOLLOW | consts.O_CREAT | consts.O_RDWR;
const LOG_MODE = consts.S_IRUSR | consts.S_IWUSR;

export function _initLog(name: string) {
    log = vscode.window.createOutputChannel(name, { log: true });
}

export function getLogfileInfo(ctx: vscode.ExtensionContext, logSlug: string) {
    const logfileName = `devcontainer-${logSlug}.log`;
    return [ctx.logUri.fsPath, logfileName];
}

export function initLogs(ctx: vscode.ExtensionContext) {
    // mmmm spaghetti
    _initLog(EXTENSION_PRETTY_NAME);

    try {
        const logSlug = getWorkspaceId(getLocalWorkspaceFolder());
        const [dir, name] = getLogfileInfo(ctx, logSlug);

        mkdirSync(dir, { recursive: true });
        logFile = path.join(dir, name);
        log = new TeeLogOutputChannel(logFile, getLogSink());
    }
    catch (e) {
        getLogSink().error(`Could not switch to TeeLog. Not in a workspace? Error: ${JSON.stringify(e)}`);
    }

    const logger = getLogSink();
    logger.info(`Activating ${EXTENSION_PRETTY_NAME} (${EXTENSION_ID})`);
    return logger;
}

// TODO: better log wrap
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-deprecated */
export class TeeLogOutputChannel implements vscode.LogOutputChannel {
    private readonly logfile: number;
    readonly logLevel: vscode.LogLevel;
    readonly onDidChangeLogLevel: vscode.Event<vscode.LogLevel>;

    constructor(
        logPath: string,
        private readonly base: vscode.LogOutputChannel,
        readonly name: string = base.name,
    ) {
        this.logLevel = this.base.logLevel;
        this.onDidChangeLogLevel = this.base.onDidChangeLogLevel;
        this.logfile = openSync(logPath, LOG_FLAGS, LOG_MODE);
        truncateSync(logPath, 0);
    }

    trace(message: string, ...args: any[]): void {
        writeSync(this.logfile, getLogLine([message, ...args].join(" ")));
        this.base.trace(message, ...args);
    }

    debug(message: string, ...args: any[]): void {
        writeSync(this.logfile, getLogLine([message, ...args].join(" ")));
        this.base.debug(message, ...args);
    }

    info(message: string, ...args: any[]): void {
        writeSync(this.logfile, getLogLine([message, ...args].join(" ")));
        this.base.info(message, ...args);
    }

    warn(message: string, ...args: any[]): void {
        writeSync(this.logfile, getLogLine([message, ...args].join(" ")));
        this.base.warn(message, ...args);
    }

    error(error: string | Error, ...args: any[]): void {
        writeSync(this.logfile, getLogLine([error.toString(), ...args].join(" ")));
        this.base.error(error, ...args);
    }

    append(value: string): void {
        writeSync(this.logfile, value);
        this.base.append(value);
    }

    appendLine(value: string): void {
        writeSync(this.logfile, getLogLine(value.trim()));
        this.base.appendLine(value);
    }

    replace(value: string): void {
        this.base.replace(value);
    }

    clear(): void {
        writeSync(this.logfile, "", 0);
        this.base.clear();
    }

    show(columnOrPreserve?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
        this.base.show(columnOrPreserve as any, preserveFocus);
    }

    hide(): void {
        this.base.hide();
    }

    dispose(): void {
        close(this.logfile);
        this.base.dispose();
    }
};
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-deprecated */

// Must be disposed
export function getLogSink(): vscode.LogOutputChannel {
    if (!log) {
        vscode.window.showErrorMessage("Devcontainers: Logging is not initialized. This is a bug, please report it!");
        throw new Error("InternalError: Logging is not initialized: Call `initLog` first. This is a bug, please report it!");
    };
    return log;
}

export function getLogfilePath() {
    if (!log || !logFile) {
        vscode.window.showErrorMessage("Devcontainers: getLogfilePath: Logging was incorrectly initialized. This is a bug, please report it.");
        throw new InternalError("Devcontainers: getLogfilePath: Logging was incorrectly initialized.");
    };
    return logFile;
}

function getLogLine(msg: string) {
    if (!msg.endsWith("\n")) { return msg + "\n"; }
    else { return msg; }
}
