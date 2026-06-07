import * as vscode from 'vscode';
import * as cmd from '../common/cmd';

export function showHello() {
    vscode.window.showInformationMessage('Hello World from Open Remote - Devcontainer!');
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getConfig<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("remote.devcontainer").get<T>(key);
}

export function getContainerEngine(): string {
    return getConfig<string>("engine") || "docker";
}

export async function getContainerEngineVersion(log: vscode.LogOutputChannel) {
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], {}, log);
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}
