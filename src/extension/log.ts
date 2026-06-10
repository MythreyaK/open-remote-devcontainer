import { window, LogOutputChannel } from 'vscode';
import { ExtensionError } from './error';

let log: LogOutputChannel | undefined;

export function initLog(name: string) {
    log = window.createOutputChannel(name, { log: true });
}

// Must be disposed
export function getLogSink(): LogOutputChannel {
    if (!log) {
        window.showErrorMessage("Devcontainers: Logging is not initialized. This is a bug, please report it.");
        throw new ExtensionError("Logging is not initialized: Call `initLog` first");
    };
    return log;
}
