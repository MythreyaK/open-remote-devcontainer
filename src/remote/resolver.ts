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


    // candidatePortSource?: vscode.CandidatePortSource;


    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): vscode.ResolverResult | Thenable<vscode.ResolverResult> {
        throw new Error('Method not implemented.');
    }

    resolveExecServer?(remoteAuthority: string, context: vscode.RemoteAuthorityResolverContext): vscode.ExecServer | Thenable<vscode.ExecServer> {
        throw new Error('Method not implemented.');
    }

    getCanonicalURI?(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
        throw new Error('Method not implemented.');
    }

    tunnelFactory?: (tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions) => Thenable<vscode.Tunnel> | undefined;

    showCandidatePort?: (host: string, port: number, detail: string) => Thenable<boolean>;

    dispose() {
        throw new Error('Method not implemented.');
    }
};
