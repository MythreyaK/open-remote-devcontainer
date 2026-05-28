import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DevcontainerConfig, parseDevcontainerConfig } from "./devcontainerConfig";
import {
  containerExists,
  ensureContainerStarted,
  findFreePort,
  getDevcontainerPath,
  getOutput,
  getWorkspaceFolder,
  initLog,
  openLogFile,
  makeWorkspaceSlug,
  rebuildContainerDirect,
  resolveDevcontainerContext,
  shouldRebuildForDevcontainer,
} from "./devcontainerCore";
import {
  RemoteDevcontainerResolver,
  REMOTE_DEVCONTAINER_AUTHORITY,
  getRemoteAuthority,
  parseAuthoritySlug,
} from "./authResolver";
import { SERVER_PORT } from "./serverInstall";

export function activate(context: vscode.ExtensionContext) {
  const resolver = new RemoteDevcontainerResolver(context);
  context.subscriptions.push(
    vscode.workspace.registerRemoteAuthorityResolver(
      REMOTE_DEVCONTAINER_AUTHORITY,
      resolver
    )
  );
  context.subscriptions.push(resolver);

  async function updateDevcontainerContext() {
    const ws = getWorkspaceFolder();
    const has = ws ? fs.existsSync(getDevcontainerPath(ws.uri.fsPath)) : false;
    await vscode.commands.executeCommand("setContext", "openremotedevcontainer.hasConfig", has);
  }
  updateDevcontainerContext();
  const ws = getWorkspaceFolder();
  if (ws) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ws.uri.fsPath, ".devcontainer/devcontainer.json")
    );
    watcher.onDidCreate(async () => {
      await updateDevcontainerContext();
      await runPostStartCommand();
    });
    watcher.onDidDelete(updateDevcontainerContext);
    watcher.onDidChange(async () => {
      await updateDevcontainerContext();
      await runPostStartCommand();
    });
    context.subscriptions.push(watcher);
  }

  function getWorkspaceOrThrow(): vscode.WorkspaceFolder {
    const ws = getWorkspaceFolder();
    if (!ws) {
      throw new Error("No folder open");
    }
    return ws;
  }

  function getWorkspaceFsPathOrThrow(): string {
    return getWorkspaceOrThrow().uri.fsPath;
  }

  function withUiErrorHandling(
    action: () => Promise<void>,
    options?: { appendToOutput?: boolean }
  ): () => Promise<void> {
    return async () => {
      try {
        await action();
      } catch (err: any) {
        const message = err?.message ?? String(err);
        if (options?.appendToOutput ?? true) {
          getOutput().appendLine(`Error: ${message}`);
        }
        const choice = await vscode.window.showErrorMessage(
          message,
          "Show Log"
        );
        if (choice === "Show Log") {
          await openLogFile();
        }
      }
    };
  }

  function getRemoteSlug(): string | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws || ws.uri.scheme !== "vscode-remote") { return undefined; }
    return parseAuthoritySlug(ws.uri.authority);
  }

  async function openFolderViaResolver(forceRebuild: boolean): Promise<void> {
    const wsFsPath = getWorkspaceFsPathOrThrow();
    const resolved = resolveDevcontainerContext(wsFsPath);
    const slug = makeWorkspaceSlug(wsFsPath);
    initLog(slug, "client");
    const out = getOutput();

    const exists = await containerExists(resolved.containerName);

    let needsRebuild = forceRebuild;
    if (exists && !forceRebuild) {
      needsRebuild = await shouldRebuildForDevcontainer(wsFsPath, resolved.containerName);
      if (needsRebuild) {
        const choice = await vscode.window.showWarningMessage(
          "Devcontainer configuration changed. Rebuild?",
          { modal: true },
          "Rebuild",
          "Reuse"
        );
        if (!choice) {
          throw new Error("Operation cancelled");
        }
        needsRebuild = choice === "Rebuild";
      }
    }

    if (!exists || needsRebuild) {
      const hostPort = await findFreePort();
      resolver.setForceRebuild(needsRebuild);
      await rebuildContainerDirect(context, resolved, hostPort, SERVER_PORT);
    } else {
      await ensureContainerStarted(resolved.containerName);
    }

    await context.globalState.update(`localPath:${slug}`, wsFsPath);

    const projectName = path.basename(wsFsPath);
    const remoteUri = vscode.Uri.parse(
      `vscode-remote://${getRemoteAuthority(slug)}/workspace/${projectName}`
    );
    out.appendLine(`Opening remote folder: ${remoteUri.toString()}`);
    await vscode.commands.executeCommand("vscode.openFolder", remoteUri, {
      forceNewWindow: false,
    });
  }

  const addDockerfileTemplate = vscode.commands.registerCommand(
    "openremotedevcontainer.addDockerfileTemplate",
    withUiErrorHandling(async () => {
      const ws = getWorkspaceOrThrow();

      getOutput().show(true);
      const devcontainerDir = path.join(ws.uri.fsPath, ".devcontainer");
      const destDockerfile = path.join(devcontainerDir, "Dockerfile");

      fs.mkdirSync(devcontainerDir, { recursive: true });

      if (fs.existsSync(destDockerfile)) {
        const choice = await vscode.window.showWarningMessage(
          "A .devcontainer/Dockerfile already exists. Overwrite?",
          { modal: true },
          "Overwrite"
        );
        if (choice !== "Overwrite") {
          return;
        }
      }

      const templateUri = vscode.Uri.joinPath(
        context.extensionUri,
        "assets",
        "devcontainer",
        "Dockerfile"
      );

      const template = fs.readFileSync(templateUri.fsPath);
      fs.writeFileSync(destDockerfile, template);

      vscode.window.showInformationMessage(
        "Template Dockerfile added to .devcontainer/Dockerfile"
      );
      getOutput().appendLine("Template Dockerfile created.");

      const devcontainerJson = path.join(devcontainerDir, "devcontainer.json");
      if (!fs.existsSync(devcontainerJson)) {
        vscode.window.showInformationMessage(
          "No devcontainer.json found. The build command expects one in .devcontainer."
        );
      }
    })
  );

  const openFolderInDevcontainer = vscode.commands.registerCommand(
    "openremotedevcontainer.openFolderInDevcontainer",
    withUiErrorHandling(async () => {
      await openFolderViaResolver(false);
    })
  );

  const rebuildAndOpen = vscode.commands.registerCommand(
    "openremotedevcontainer.rebuildAndOpen",
    withUiErrorHandling(async () => {
      await openFolderViaResolver(true);
    })
  );

  const openDevcontainerConfig = vscode.commands.registerCommand(
    "openremotedevcontainer.openDevcontainerConfig",
    withUiErrorHandling(async () => {
      const ws = getWorkspaceOrThrow();
      const cfgPath = getDevcontainerPath(ws.uri.fsPath);
      if (!fs.existsSync(cfgPath)) {
        throw new Error(".devcontainer/devcontainer.json not found in this folder");
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(cfgPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    }, { appendToOutput: false })
  );

  const reopenLocally = vscode.commands.registerCommand(
    "openremotedevcontainer.reopenLocally",
    withUiErrorHandling(async () => {
      const slug = getRemoteSlug();
      if (!slug) {
        throw new Error("Not connected to a devcontainer");
      }
      const localPath = context.globalState.get<string>(`localPath:${slug}`);
      if (!localPath) {
        throw new Error(`No local path stored for workspace '${slug}'`);
      }
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(localPath),
        { forceNewWindow: false }
      );
    }, { appendToOutput: false })
  );

  const showLog = vscode.commands.registerCommand(
    "openremotedevcontainer.showLog",
    async () => {
      if (vscode.env.remoteName === REMOTE_DEVCONTAINER_AUTHORITY) {
        const slug = getRemoteSlug();
        const logPath = slug
          ? context.globalState.get<string>(`serverLogFile:${slug}`)
          : undefined;
        if (logPath) {
          const ws = vscode.workspace.workspaceFolders?.[0];
          if (ws) {
            const logUri = ws.uri.with({ path: logPath });
            const doc = await vscode.workspace.openTextDocument(logUri);
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
          }
        }
        vscode.window.showInformationMessage("No server log file path stored — try reconnecting");
      } else {
        await openLogFile();
      }
    }
  );

  const showMenu = vscode.commands.registerCommand(
    "openremotedevcontainer.showMenu",
    async () => {
      const ws = getWorkspaceFolder();
      const has = ws ? fs.existsSync(getDevcontainerPath(ws.uri.fsPath)) : false;
      const runIfHasConfig = async (commandId: string, missingMessage: string) => {
        if (!has) {
          vscode.window.showInformationMessage(missingMessage);
          return;
        }
        await vscode.commands.executeCommand(commandId);
      };
      const picks: vscode.QuickPickItem[] = [
        has
          ? { label: "$(gear) Open Devcontainer Configuration", detail: ".devcontainer/devcontainer.json" }
          : { label: "$(gear) Open Devcontainer Configuration", description: "(no devcontainer.json)" },
        has
          ? { label: "$(refresh) Open Folder in container", detail: "Build and Open Folder in container" }
          : { label: "$(circle-slash) Open Folder in container", description: "(requires .devcontainer/devcontainer.json)" },
        has
          ? { label: "$(sync) Rebuild & repen in container", detail: "Force rebuild and recreate container" }
          : { label: "$(circle-slash) Rebuild & repen in container", description: "(requires .devcontainer/devcontainer.json)" },
        { label: "$(output) Show Log", detail: "Open the devcontainer log file" },
        ...(vscode.env.remoteName
          ? [{ label: "$(close) Reopen Folder Locally", detail: "Close remote and reopen workspace locally" }]
          : []),
      ];
      const chosen = await vscode.window.showQuickPick(picks, {
        title: "Open Remote - Devcontainer",
        placeHolder: "Select an action"
      });
      if (!chosen) return;
      if (chosen.label.includes("Open Devcontainer Configuration")) {
        await runIfHasConfig(
          "openremotedevcontainer.openDevcontainerConfig",
          "No devcontainer.json found in this folder. Use 'Devcontainer: Add Dockerfile Template' to scaffold and create .devcontainer/devcontainer.json."
        );
      } else if (chosen.label.includes("Open Folder in container")) {
        await runIfHasConfig(
          "openremotedevcontainer.openFolderInDevcontainer",
          "Cannot reopen in devcontainer: .devcontainer/devcontainer.json is missing."
        );
      } else if (chosen.label.includes("Rebuild & repen in container")) {
        await runIfHasConfig(
          "openremotedevcontainer.rebuildAndOpen",
          "Cannot rebuild: .devcontainer/devcontainer.json is missing."
        );
      } else if (chosen.label.includes("Show Log")) {
        await openLogFile();
      } else if (chosen.label.includes("Reopen Folder Locally")) {
        await vscode.commands.executeCommand("openremotedevcontainer.reopenLocally");
      }
    }
  );

  const showOutputLog = vscode.commands.registerCommand(
    "openremotedevcontainer.showOutputLog",
    () => { getOutput().show(false); }
  );

  context.subscriptions.push(
    addDockerfileTemplate,
    openFolderInDevcontainer,
    openDevcontainerConfig,
    rebuildAndOpen,
    reopenLocally,
    showLog,
    showOutputLog,
    showMenu
  );
  runPostStartCommand();
}

async function runPostStartCommand() {
  try {
    if (!vscode.env.remoteName) return;
    const ws = getWorkspaceFolder();
    if (!ws) return;
    const dev = await readDevcontainerConfigFromWorkspace(ws.uri);
    if (!dev) return;
    const postStart = dev.postStartCommand;
    if (!postStart || (Array.isArray(postStart) && postStart.length === 0)) return;
    const out = getOutput();
    out.appendLine("Running postStartCommand in remote terminal...");
    out.show(true);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Devcontainer: Running postStartCommand" },
      async () => {
        await vscode.commands.executeCommand("workbench.action.closePanel");
        const term = vscode.window.createTerminal({ name: "Devcontainer: Post Start" });
        term.show(false);
        const cmds: string[] = Array.isArray(postStart) ? postStart : [postStart];
        for (const c of cmds) {
          out.appendLine(`postStartCommand: ${c}`);
          term.sendText(c, true);
        }
      }
    );
  } catch {
    // ignore
  }
}

async function waitForWorkspaceFile(uri: vscode.Uri, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      // not found yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readDevcontainerConfigFromWorkspace(wsUri: vscode.Uri): Promise<DevcontainerConfig | undefined> {
  const uri = vscode.Uri.joinPath(wsUri, ".devcontainer", "devcontainer.json");
  const ok = await waitForWorkspaceFile(uri, 10000);
  if (!ok) return undefined;
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    const raw = Buffer.from(data).toString("utf-8");
    return parseDevcontainerConfig(raw);
  } catch {
    return undefined;
  }
}

export async function deactivate() {}
