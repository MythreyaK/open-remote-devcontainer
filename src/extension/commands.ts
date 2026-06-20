import * as vscode from 'vscode';
import * as cmd from '../common/cmd';
import { getContainerEngine } from './settings';

export async function getContainerEngineVersion() {
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], getActiveWorkspace(), {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}
