import * as vscode from 'vscode';
import * as cmd from '../common/cmd';
import { getContainerEngine } from './settings';

export function showHello() {
    vscode.window.showInformationMessage('Hello World from Open Remote - Devcontainer!' + " " + vscode.env.appRoot);
}

export async function getContainerEngineVersion() {
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}
