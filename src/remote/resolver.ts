import * as vscode from "vscode";
import path from "node:path";

import { getLogSink, getLogfilePath } from "../extension/log";
import { BuildOpts, ContainerState } from "../engine/lifecycle";
import { findDevcontainerJson } from "../extension/workspace";
import { ContainerConfig, ContainerEngine } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { BuildOptIntent } from "../common/globalState";
import { EngineError, InstallError } from "../extension/error";
import { getExtensionList, getContainerEngine } from "../extension/settings";
import { DEVCONTAINER_SERVER_LISTEN_PORT } from "../common/constants";

export const AUTHORITY_BASE: string = "devcontainer-remote";

const ENCODE_SCHEME = "hex";

export enum RetryOpts {
    // Cancel = "Cancel",
    Retry = "Retry",
    ShowLog = "Show log",
    Close = "Close remote",
};

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
    readonly candidatePortSource = vscode.CandidatePortSource.Process;

    private readonly extensionCtx: vscode.ExtensionContext;
    private containerState: ContainerState | undefined;
    private localWsf: string = "";
    private serverHostPort: number | undefined;

    private statusItemFormatter: vscode.Disposable | undefined;
    private onContainerReadyFunc?: () => void;
    public readonly onContainerReady = new Promise<void>((r) => { this.onContainerReadyFunc = r; });

    constructor(context: vscode.ExtensionContext) {
        this.extensionCtx = context;
        void this.extensionCtx; // TODO
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        this.localWsf = decodeRemoteAuthority(authority);

        getLogSink().info(`Starting remote session from ${this.localWsf} (authority ${authority}, attempt #${context.resolveAttempt})...`);

        const localWsfBasename = path.parse(this.localWsf).base;

        return vscode.window.withProgress(
            {
                title: `Remote - Devcontainer: ${localWsfBasename}`,
                location: vscode.ProgressLocation.Notification,
            },
            (p, i) => this.tryResolve(context, p, i),
        );
    }

    private async tryResolve(
        context: vscode.RemoteAuthorityResolverContext,
        progress: vscode.Progress<{ message?: string, increment?: number }>,
        cancellationToken: vscode.CancellationToken,
    ): Promise<vscode.ResolverResult> {
        try {
            return await this.createWindowTask(progress, cancellationToken);
        }
        catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            getLogSink().error(`Resolver failed (attempt #${context.resolveAttempt}): ${msg}`);

            if (context.resolveAttempt === 1) {
                await notifyResolverError(msg);
            }

            if (e instanceof InstallError || e instanceof EngineError) {
                throw vscode.RemoteAuthorityResolverError.NotAvailable(msg);
            }
            throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(msg);
        }
    }

    private async createWindowTask(progress: vscode.Progress<{ message?: string, increment?: number }>, _2: vscode.CancellationToken): Promise<vscode.ResolverResult> {
        const buildOpt = BuildOptIntent.get(this.extensionCtx) ?? BuildOpts.Default;
        const engine = (() => {
            const e = path.parse(getContainerEngine()).base;
            if (e === "podman") { return ContainerEngine.podman; }
            if (e === "docker") { return ContainerEngine.docker; }
            return ContainerEngine.none;
        })();

        progress.report({ message: "Parsing config...", increment: 5 });

        const devcontainerJson = findDevcontainerJson(this.localWsf);
        const parsedConfig = parseDevcontainerFile(devcontainerJson);

        const containerConfig = ContainerConfig.create(this.localWsf, devcontainerJson, parsedConfig, process.env, { engine: engine });

        progress.report({ message: "Building image and starting container...", increment: 15 });
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
                    workspaceSuffix: `📦 ${localWsfBasename} (${containerId.slice(0, 8)})`,
                },
            });

        progress.report({ message: "Installing server...", increment: 30 });

        const { host, port } = await this.containerState.installServer([
            ...getExtensionList(),
            ...parsedConfig.customizations?.vscode?.extensions ?? [],
        ]);
        this.serverHostPort = port;
        progress.report({ message: "Connecting...", increment: 40 });

        const ctkn = await this.containerState.getConnectionToken();
        progress.report({ message: "Opening remote...", increment: 10 });

        this.onContainerReadyFunc?.();

        vscode.commands.executeCommand("setContext", "forwardedPortsViewEnabled", true);
        vscode.commands.executeCommand("setContext", "forwardedPortsFeaturesEnabled", true);

        for (const p of parsedConfig.forwardPorts) {
            if (typeof p === "string") {
                getLogSink().warn(`Skipping forwardPorts entry '${p}' (host:port compose format not supported)`);
                continue;
            }
            else {
                const remotePort = p;
                getLogSink().info(`Forwarding remote port ${remotePort} -> to local http://localhost:${remotePort}`);
                vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${remotePort}`));
            }
        }

        return new vscode.ResolvedAuthority(host, port, ctkn);
    }

    // getCanonicalURI?(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    //     throw new Error('Method not implemented.');
    // }

    // tunnelFactory?: (tunnelOptions: vscode.TunnelOptions, tunnelCreationOptions: vscode.TunnelCreationOptions) => Thenable<vscode.Tunnel> | undefined;

    showCandidatePort(host: string, port: number, detail: string): Thenable<boolean> {
        const prettyDetail = detail.split("\0").map(e => e.trim()).filter(e => !!e).map(e => `'${e}'`).join(", ");
        getLogSink().info(`showCandidatePort: detected port ${host}:${port} detail: [${prettyDetail}]`);

        if (port === DEVCONTAINER_SERVER_LISTEN_PORT || port === this.serverHostPort) {
            return Promise.resolve(false);
        }
        return Promise.resolve(true);
    }

    public async dispose() {
        this.statusItemFormatter?.dispose();
        await this.containerState?.dispose();
    }
};

async function notifyResolverError(message: string) {
    const choice = await vscode.window.showErrorMessage(
        "Could not open devcontainer",
        { modal: true, detail: message },
        ...Object.values(RetryOpts),
    );

    if (choice === RetryOpts.Retry) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
    }
    else if (choice === RetryOpts.ShowLog) {
        try {
            const logPath = getLogfilePath();
            getLogSink().show();
            await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(logPath));
        }
        catch {
            getLogSink().show();
        }
    }
    else if (choice === RetryOpts.Close) {
        await vscode.commands.executeCommand("open-remote-devcontainer.openLocal");
        return;
    }
}
