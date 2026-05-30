// Based on open-remote-ssh/src/authResolver.ts (MIT, jeanp413)
// Adapted for devcontainer use: port-mapped localhost instead of SSH tunnel,
// server install via docker exec instead of SSH.

import * as vscode from "vscode";
import {
  getMappedPort,
  getOutput,
  initLog,
  openLogFile,
  runContainerCommandCapture,
} from "./devcontainerCore";
import {
  installServer,
  makeRemoteContainerExec,
  getRemoteMappedPort,
  SERVER_PORT,
  ServerInstallError,
} from "./serverInstall";

export const REMOTE_DEVCONTAINER_AUTHORITY = "devcontainer";

export function getRemoteAuthority(slug: string): string {
  return `${REMOTE_DEVCONTAINER_AUTHORITY}+${slug}`;
}

export function parseAuthoritySlug(authority: string): string {
  const prefix = `${REMOTE_DEVCONTAINER_AUTHORITY}+`;
  return authority.startsWith(prefix)
    ? authority.slice(prefix.length)
    : authority;
}

export class RemoteDevcontainerResolver
  implements vscode.RemoteAuthorityResolver, vscode.Disposable
{
  private labelFormatterDisposable: vscode.Disposable | undefined;
  private forceRebuild = false;
  private hostPort: number | undefined;
  private serverDataFolder: string | undefined;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext
  ) {}

  setForceRebuild(value: boolean): void {
    this.forceRebuild = value;
  }

  showCandidatePort(_host: string, port: number, detail: string): Thenable<boolean> {
    if (port === SERVER_PORT || port === this.hostPort) return Promise.resolve(false);
    if (this.serverDataFolder && detail.includes(this.serverDataFolder)) return Promise.resolve(false);
    return Promise.resolve(true);
  }

  resolve(
    authority: string,
    context: vscode.RemoteAuthorityResolverContext
  ): Thenable<vscode.ResolverResult> {
    const slug = parseAuthoritySlug(authority);
    const containerName = `open-remote-devcontainer-${slug}`;

    initLog(slug, "server");
    const out = getOutput();
    out.appendLine(
      `Resolving devcontainer authority '${authority}' (attempt #${context.resolveAttempt})`
    );

    if (context.execServer) {
      out.appendLine("ExecServer provided — resolving via remote SSH host");
    }

    return vscode.window.withProgress(
      {
        title: `Dev Container: ${slug} ([show log](command:openremotedevcontainer.showOutputLog))`,
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      },
      async (progress) => {
        try {
          if (context.execServer) {
            return await this.resolveRemote(slug, containerName, context.execServer, progress, out);
          }
          return await this.resolveLocal(slug, containerName, progress, out);
        } catch (e: unknown) {
          out.appendLine(
            `Error resolving authority: ${e instanceof Error ? e.message : String(e)}`
          );

          if (context.resolveAttempt === 1) {
            const retry = "Retry";
            const showLog = "Show Log";
            const close = "Close Remote";
            const choice = await vscode.window.showErrorMessage(
              `Dev Container failed: ${e instanceof Error ? e.message : String(e)}`,
              { modal: true },
              retry,
              showLog,
              close
            );
            if (choice === showLog) {
              await openLogFile();
            } else if (choice === close) {
              await vscode.commands.executeCommand(
                "workbench.action.remote.close"
              );
            } else if (choice === retry) {
              await vscode.commands.executeCommand(
                "workbench.action.reloadWindow"
              );
            }
          }

          if (e instanceof ServerInstallError) {
            throw vscode.RemoteAuthorityResolverError.NotAvailable(e.message);
          }
          throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
            e instanceof Error ? e.message : String(e)
          );
        }
      }
    );
  }

  private async resolveLocal(
    slug: string,
    containerName: string,
    progress: vscode.Progress<{ message?: string }>,
    out: vscode.OutputChannel
  ): Promise<vscode.ResolverResult> {
    progress.report({ message: "Installing server…" });
    const server = await installServer(containerName);
    this.serverDataFolder = server.dataFolder;

    if (server.logFile) {
      await this.extensionContext.globalState.update(`serverLogFile:${slug}`, server.logFile);
    }

    progress.report({ message: "Reading port mapping…" });
    const hostPort = await getMappedPort(containerName, SERVER_PORT);
    this.hostPort = hostPort;
    out.appendLine(
      `Server listening on container port ${server.port}, mapped to localhost:${hostPort} (token: ${server.connectionToken.slice(0, 8)}…)`
    );

    const idRes = await runContainerCommandCapture([
      "inspect", "--format", "{{.Id}}", containerName,
    ]);
    const shortId = idRes.stdout.trim().slice(0, 7);

    this.setupLabelFormatter(slug, shortId);

    vscode.commands.executeCommand(
      "setContext",
      "forwardedPortsViewEnabled",
      true
    );

    return new vscode.ResolvedAuthority(
      "127.0.0.1",
      hostPort,
      server.connectionToken
    );
  }

  private async resolveRemote(
    slug: string,
    containerName: string,
    execServer: vscode.ExecServer,
    progress: vscode.Progress<{ message?: string }>,
    out: vscode.OutputChannel
  ): Promise<vscode.ResolverResult> {
    progress.report({ message: "Installing server on remote host…" });
    const executor = makeRemoteContainerExec(execServer);
    const server = await installServer(containerName, executor);
    if (server.scriptOutput) {
      out.appendLine(server.scriptOutput);
    }
    this.serverDataFolder = server.dataFolder;

    if (server.logFile) {
      await this.extensionContext.globalState.update(`serverLogFile:${slug}`, server.logFile);
    }

    progress.report({ message: "Reading remote port mapping…" });
    const mappedPort = await getRemoteMappedPort(execServer, containerName, SERVER_PORT);
    out.appendLine(
      `Server listening on container port ${server.port}, remote mapped port ${mappedPort} (token: ${server.connectionToken.slice(0, 8)}…)`
    );

    this.setupLabelFormatter(slug, "remote");

    vscode.commands.executeCommand(
      "setContext",
      "forwardedPortsViewEnabled",
      true
    );

    return new vscode.ManagedResolvedAuthority(
      async () => {
        out.appendLine(`Connecting to remote container via SSH tunnel (127.0.0.1:${mappedPort})…`);
        const tcp = await execServer.tcpConnect("127.0.0.1", mappedPort);
        return RemoteDevcontainerResolver.tcpToManagedConnection(tcp);
      },
      server.connectionToken
    );
  }

  private setupLabelFormatter(slug: string, suffix: string): void {
    this.labelFormatterDisposable?.dispose();
    this.labelFormatterDisposable =
      vscode.workspace.registerResourceLabelFormatter({
        scheme: "vscode-remote",
        authority: `${REMOTE_DEVCONTAINER_AUTHORITY}+*`,
        formatting: {
          label: "${path}",
          separator: "/",
          tildify: true,
          workspaceSuffix: `Dev Container: ${slug} [${suffix}]`,
        },
      });
  }

  private static tcpToManagedConnection(
    tcp: { stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> }
  ): vscode.ManagedMessagePassing {
    const closeEmitter = new vscode.EventEmitter<Error | undefined>();
    const endEmitter = new vscode.EventEmitter<void>();

    tcp.done.then(
      () => { endEmitter.fire(); closeEmitter.fire(undefined); },
      (err) => { closeEmitter.fire(err instanceof Error ? err : new Error(String(err))); }
    );

    return {
      onDidReceiveMessage: tcp.stream.onDidReceiveMessage,
      onDidClose: closeEmitter.event,
      onDidEnd: endEmitter.event,
      send: (data: Uint8Array) => tcp.stream.write(data),
      end: () => tcp.stream.end(),
    };
  }

  dispose(): void {
    this.labelFormatterDisposable?.dispose();
  }
}
