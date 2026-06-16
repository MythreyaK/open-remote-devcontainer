import * as vscode from 'vscode';

export const AUTHORITY_BASE: string = "devc";

class DevContainer implements vscode.RemoteAuthorityResolver, vscode.Disposable {

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
