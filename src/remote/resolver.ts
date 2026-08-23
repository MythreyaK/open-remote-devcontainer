import * as vscode from "vscode";
import path from "node:path";

import { getLogSink, getLogfilePath } from "../extension/log";
import { BuildOpts, ContainerState } from "../engine/lifecycle";
import { findDevcontainerJson } from "../extension/workspace";
import { ContainerConfig, ContainerEngine } from "../engine/container";
import { parseDevcontainer } from "../parser/parser";
import { BuildOptIntent } from "../common/globalState";
import { EngineError, InstallError, InternalError } from "../extension/error";
import { getExtensionList, getSettings } from "../extension/settings";
import { DEVCONTAINER_SERVER_LISTEN_PORT } from "../common/constants";
import { setExecCtx, getExecCtx } from "../common/ctx/ctx";
import { RemoteExecCtx } from "../common/ctx/remoteCtx";

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
    const devcAuthority = `${AUTHORITY_BASE}+${encoded}`;

    // if on a remote session, say ssh, return the chained one
    if (vscode.env.remoteAuthority) {
        getLogSink().info(`Chaining with authority '${vscode.env.remoteAuthority}'`);
        return `${devcAuthority}@${vscode.env.remoteAuthority}`;
    }
    else {
        return devcAuthority;
    }
}

export function decodeDevcontainerAuthority(authority: string) {
    getLogSink().info(`decodeDevcontainerAuthority: trying to decode '${authority}'`);
    const authorityPrefix = `${AUTHORITY_BASE}+`;

    if (authority.startsWith(authorityPrefix)) {
        const wsf = authority.slice(authorityPrefix.length, authority.length);
        const decoded = Buffer.from(wsf, ENCODE_SCHEME).toString("utf-8");
        getLogSink().info(`Decoded '${wsf}' = '${decoded}'`);
        return decoded;
    }
    else {
        throw new Error(`Bad remote authority '${authority}'`);
    }
}

export function decodeRemoteAuthority(authority: string) {
    getLogSink().info(`decodeRemoteAuthority: trying to decode '${authority}'`);

    // if chained authority, then ensure remote authority part is retained
    if (authority.includes("@")) {
        const inx = authority.indexOf("@");
        const [devcAuthority, remoteAuthority] = [authority.slice(0, inx), authority.slice(inx + 1)];

        const ret = vscode.Uri.from({
            scheme: "vscode-remote",
            authority: remoteAuthority,
            path: decodeDevcontainerAuthority(devcAuthority),
        });
        getLogSink().info(`decodeRemoteAuthority: returning ${ret.toString(true)}`);
        return ret;
    }
    else {
        getLogSink().info(`decodeRemoteAuthority: returning local file:///${authority}`);
        return vscode.Uri.file(decodeDevcontainerAuthority(authority));
    }
}

export class DevContainerResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
    readonly candidatePortSource = vscode.CandidatePortSource.Process;

    private readonly extensionCtx: vscode.ExtensionContext;
    private containerState: ContainerState | undefined;
    private localWsf: vscode.Uri | undefined;
    private serverHostPort: number | undefined;

    private statusItemFormatter: vscode.Disposable | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.extensionCtx = context;
        void this.extensionCtx; // TODO
    }

    resolve(_authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const fullAuthority = vscode.env.remoteAuthority!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        if (context.execServer) {
            getLogSink().info(`Exec server was provided: '${fullAuthority}'`);
            setExecCtx(new RemoteExecCtx(context.execServer));
            // if exec server, any commands below run on the remote machine
        }

        // authority has just our part, but we need the entirety for full Uri
        this.localWsf = decodeRemoteAuthority(fullAuthority);

        getLogSink().info(`Starting remote session from ${this.localWsf.toString(true)} (authority ${fullAuthority}, attempt #${context.resolveAttempt})...`);

        const localWsfBasename = path.parse(this.localWsf.fsPath).base;

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
            return await this.createWindowTask(context, progress, cancellationToken);
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

    private async createWindowTask(context: vscode.RemoteAuthorityResolverContext, progress: vscode.Progress<{ message?: string, increment?: number }>, _2: vscode.CancellationToken): Promise<vscode.ResolverResult> {
        const buildOpt = BuildOptIntent.get(this.extensionCtx) ?? BuildOpts.Default;
        const settings = getSettings();
        const engine = (() => {
            const e = path.parse(settings.dockerPath).base;
            if (e === "podman") { return ContainerEngine.podman; }
            if (e === "docker") { return ContainerEngine.docker; }
            return ContainerEngine.none;
        })();

        progress.report({ message: "Parsing config...", increment: 5 });

        if (!this.localWsf) { throw new InternalError("this.localWsf was undefined"); }

        const devcontainerJson = await findDevcontainerJson(this.localWsf);
        const parsedConfig = await parseDevcontainer(devcontainerJson);

        const hostEnv = await getExecCtx().env();
        const containerConfig = ContainerConfig.create(this.localWsf.fsPath, devcontainerJson.fsPath, parsedConfig, hostEnv.env, { engine: engine });

        progress.report({ message: "Building image and starting container...", increment: 15 });
        this.containerState = await ContainerState.create(this.localWsf.fsPath, containerConfig, settings, buildOpt);

        const containerId = await this.containerState.getContainerId();
        const localWsfBasename = path.parse(this.localWsf.fsPath).base;

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

        vscode.commands.executeCommand("setContext", "forwardedPortsViewEnabled", true);
        vscode.commands.executeCommand("setContext", "forwardedPortsFeaturesEnabled", true);

        // if exec server, host and port are on the remote machine. forward it out to the local machine
        if (context.execServer) {
            const msg = connectToRemote(context.execServer, host, port);
            return new vscode.ManagedResolvedAuthority(() => { return msg; }, ctkn);
        }
        else {
            return new vscode.ResolvedAuthority(host, port, ctkn);
        }
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

// better name lol
async function connectToRemote(execServer: vscode.ExecServer, host: string, port: number): Promise<vscode.ManagedMessagePassing> {
    const { stream, done } = await execServer.tcpConnect(host, port);

    const onDidClose = new vscode.EventEmitter<Error | undefined>();
    const onDidEnd = new vscode.EventEmitter<void>();

    done.then(
        () => {
            onDidEnd.fire();
            onDidClose.fire(undefined);
        },
        (err: unknown) => {
            onDidClose.fire(err instanceof Error ? err : new Error(String(err)));
        },
    );

    return {
        onDidReceiveMessage: stream.onDidReceiveMessage,
        onDidClose: onDidClose.event,
        onDidEnd: onDidEnd.event,
        send: (data: Uint8Array) => { stream.write(data); },
        end: () => { stream.end(); },
    };
}
