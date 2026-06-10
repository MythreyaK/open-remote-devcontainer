import { workspace } from 'vscode';
import * as common from './spawn';
import { ExtensionError } from '../extension/error';
import { getLogSink } from '../extension/log';

export async function runCmd(cmd: string, args: string[], env: common.Envs) {
    const folders = workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        throw new ExtensionError("Not in a devcontainer workspace");
    }
    else {
        return await common.spawn(cmd, args, folders[0].uri.fsPath, env, getLogSink());
    }
}
    }
}
