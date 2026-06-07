import { LogOutputChannel, workspace } from 'vscode';
import * as common from './spawn';

export async function runCmd(cmd: string, args: string[], env: common.Envs, log: LogOutputChannel) {
    const folders = workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        log.error("Not in a devcontainer workspace");
        throw new Error("Not in a devcontainer workspace");
    }
    else {
        return await common.spawn(cmd, args, folders[0].uri.fsPath, env, log);
    }
}
