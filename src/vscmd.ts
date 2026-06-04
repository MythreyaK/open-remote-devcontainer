import * as vscode from 'vscode';
import * as common from './run';
import * as ch from 'node:child_process';

export function showHello() {
    vscode.window.showInformationMessage('Hello World from Open Remote - Devcontainer! within a file');
}

export function getContainerEngine(): string {
    return common.getConfig("engine") || "docker";
}

export function getContaunerEngineVersion() {
    const ver = ch.execFileSync(getContainerEngine(), ["--version"], {encoding: "utf-8"});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${ver}`);
}
