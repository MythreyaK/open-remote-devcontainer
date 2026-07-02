import * as vscode from "vscode";
import path from "node:path";

import { getLogSink } from "../extension/log";
import { BuildOpts, ContainerState } from "../engine/lifecycle";
import { findDevcontainerJson } from "../extension/workspace";
import { ContainerConfig } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { BuildOptIntent } from "../common/globalState";
import { getExtensionList } from "../extension/settings";

export const AUTHORITY_BASE: string = "devcontainer-remote";

const ENCODE_SCHEME = "hex";

export function encodeRemoteAuthority(localWsf: string) {
    const encoded = Buffer.from(localWsf).toString(ENCODE_SCHEME);
    return `${AUTHORITY_BASE}+${encoded}`;
}

export function decodeRemoteAuthority(authority: string) {
    const authorityPrefix = `${AUTHORITY_BASE}+`;
    if (authority.startsWith(authorityPrefix)) {
        const wsf = authority.slice(authorityPrefix.length, authority.length);
        getLogSink().info(`Trying to decode '${authority}': got '${wsf}'`);

        const decoded = Buffer.from(wsf, ENCODE_SCHEME).toString("utf-8");
        getLogSink().info(`Decoded '${wsf}' = '${decoded}'`);

        return decoded;
    }
    else { throw new Error(`Bad remote authority '${authority}'`); }
}

export class DevContainerResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
    // candidatePortSource?: vscode.CandidatePortSource;
    private readonly extensionCtx: vscode.ExtensionContext;
    private containerState: ContainerState | undefined;
    private localWsf: string = "";

    private statusItemFormatter: vscode.Disposable | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.extensionCtx = context;
        void this.extensionCtx; // TODO
    }

    resolve(authority: string, _1: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        this.localWsf = decodeRemoteAuthority(authority);

        getLogSink().info(`Starting remote session from ${this.localWsf} (authority ${authority})...`);

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification },
            (p, i) => this.createWindowTask(p, i),
        );
    }

    private async createWindowTask(progress: vscode.Progress<{ message?: string, increment?: number }>, _2: vscode.CancellationToken): Promise<vscode.ResolverResult> {
        const buildOpt = BuildOptIntent.get(this.extensionCtx) ?? BuildOpts.Default;

        progress.report({ message: "Parsing config...", increment: 5 });

        const devcontainerJson = findDevcontainerJson(this.localWsf);
        const parsedConfig = parseDevcontainerFile(devcontainerJson);

        const containerConfig = ContainerConfig.create(this.localWsf, devcontainerJson, parsedConfig);

        progress.report({ message: "Building image and starting container...", increment: 50 });
        this.containerState = await ContainerState.create(this.localWsf, containerConfig, buildOpt);

        const containerId = await this.containerState.getContainerId();
        const localWsfBasename = path.parse(this.localWsf).base;

        // set status bar item
        this.statusItemFormatter
            = vscode.workspace.registerResourceLabelFormatter({
                scheme: "vscode-remote",
                authority: `${AUTHORITY_BASE}+*`,
                formatting: {
                    label: "${path}",
                    separator: "/",
                    tildify: true,
                    workspaceSuffix: `📦 ${containerId.slice(0, 8)}: ${localWsfBasename}`,
                    authorityPrefix: this.localWsf,
                },
            });

        progress.report({ message: "Created container...", increment: 75 });
        progress.report({ message: "Installing server...", increment: 85 });

        const { host, port } = await this.containerState.installServer([
            ...getExtensionList(),
            ...parsedConfig.customizations?.vscode?.extensions ?? [],
        ]);
        progress.report({ message: "Server install complete, opening remote...", increment: 85 });

        const ctkn = await this.containerState.getConnectionToken();
        progress.report({ message: "Opening remote ...", increment: 100 });

        const ret: vscode.ResolverResult = new vscode.ResolvedAuthority(host, port, ctkn);
        return ret;
    }

    // getCanonicalURI?(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    //     throw new Error('Method not implemented.');
    // }

    // tunnelFactory?: (tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions) => Thenable<vscode.Tunnel> | undefined;

    // showCandidatePort?: (host: string, port: number, detail: string) => Thenable<boolean>;

    dispose() {
        this.statusItemFormatter?.dispose();
    }
};
