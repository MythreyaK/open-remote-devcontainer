import * as vscode from 'vscode';

import { getLogSink } from '../extension/log';
import { ContainerState } from '../engine/lifecycle';
import { findDevcontainerJson } from '../extension/workspace';
import { ContainerConfig } from '../engine/container';
import { parseDevcontainerFile } from '../parser/parser';

export const AUTHORITY_BASE: string = "devcontainer-remote";

export function encodeRemoteAuthority(localWsf: string) {
    const encoded = Buffer.from(localWsf).toString('base64url');
    return `${AUTHORITY_BASE}+${encoded}`;
}

export function decodeRemoteAuthority(authority: string) {
    const authorityPrefix = `${AUTHORITY_BASE}+`
    if (authority.startsWith(authorityPrefix)) {
        const [_, wsf] = authority.split(authorityPrefix);
        getLogSink().info(`Trying to decode ${authority}: got '${_}' and '${wsf}'`);
        return Buffer.from(wsf, 'base64url').toString('utf-8');
    }
    else throw new Error(`Bad remote authority '${authority}'`);
}


export class DevContainerResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    // candidatePortSource?: vscode.CandidatePortSource;
    private containerState: ContainerState | undefined;
    private localWsf: string = "";

    constructor(context: vscode.ExtensionContext) {}

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        this.localWsf = decodeRemoteAuthority(authority);

        getLogSink().info(`Starting remote session from ${this.localWsf} (authority ${authority})...`);

        return vscode.window.withProgress(
            {location: vscode.ProgressLocation.Notification},
            (p, i) => this.createWindowTask(p, i)
        );
    }

    private async createWindowTask(progress: vscode.Progress<{message?: string; increment?: number;}>, _: vscode.CancellationToken): Promise<vscode.ResolverResult> {
        progress.report({message: "Parsing config...", increment: 5});

        const devcontainerJson = findDevcontainerJson(this.localWsf);
        const parsedConfig = parseDevcontainerFile(devcontainerJson);

        const containerConfig = ContainerConfig.create(this.localWsf, parsedConfig);

        progress.report({message: "Building image and starting container...", increment: 50});
        this.containerState = await ContainerState.create(this.localWsf, "", containerConfig);

        progress.report({message: "Created container...", increment: 75});
        progress.report({message: "Installing server...", increment: 85});

        const {host, port, result} = await this.containerState.installServer();
        progress.report({message: "Server install complete, opening remote...", increment: 85});

        const ctkn = await this.containerState.getConnectionToken();
        progress.report({message: "Opening remote ...", increment: 100});

        const ret: vscode.ResolverResult = new vscode.ResolvedAuthority(host, port, ctkn);
        return ret;
    }

    // getCanonicalURI?(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    //     throw new Error('Method not implemented.');
    // }

    // tunnelFactory?: (tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions) => Thenable<vscode.Tunnel> | undefined;

    // showCandidatePort?: (host: string, port: number, detail: string) => Thenable<boolean>;

    dispose() {}
};
