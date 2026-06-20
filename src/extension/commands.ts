import * as vscode from 'vscode';

import * as cmd from '../common/cmd';
import { getContainerEngine } from './settings';
import { encodeRemoteAuthority } from '../remote/resolver';
import { findDevcontainerJson, getActiveWorkspace } from './workspace';
import { parseDevcontainerFile } from '../parser/parser';
import { ContainerConfig } from '../engine/container';

export async function getContainerEngineVersion() {
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], getActiveWorkspace(), {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}

export async function openRemote(context: vscode.ExtensionContext) {
    const localWsf = getActiveWorkspace();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, parsedConfig);

    const remoteWsf = cc.getRemoteMountDir();
    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.from({
            scheme: 'vscode-remote',
            authority: encodeRemoteAuthority(localWsf),
            path: remoteWsf}
        )
    );
}
