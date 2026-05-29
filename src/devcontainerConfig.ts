import JSON5 from "json5";

export type DevcontainerMount = {
  source?: string;
  target: string;
  type?: "bind" | "volume" | "tmpfs";
  options?: string;
};

export type DevcontainerMountEntry = string | DevcontainerMount;

export type DevcontainerConfig = {
  image?: string;
  remoteUser?: string;
  dockerFile?: string;
  postCreateCommand?: string | string[];
  postStartCommand?: string | string[];
  mounts?: DevcontainerMountEntry[];
  runArgs?: string[];
};

export type VariableContext = {
  localEnv: Record<string, string | undefined>;
  localWorkspaceFolder: string;
  localWorkspaceFolderBasename: string;
  containerWorkspaceFolder?: string;
};

export function parseDevcontainerConfig(raw: string): DevcontainerConfig {
  return JSON5.parse(raw) as DevcontainerConfig;
}

export function expandVariables(value: string, ctx: VariableContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    if (expr.startsWith("localEnv:")) {
      const rest = expr.slice("localEnv:".length);
      const colonIdx = rest.indexOf(":");
      if (colonIdx >= 0) {
        const varName = rest.slice(0, colonIdx);
        const defaultValue = rest.slice(colonIdx + 1);
        return ctx.localEnv[varName] ?? defaultValue;
      }
      return ctx.localEnv[rest] ?? "";
    }
    if (expr === "localWorkspaceFolder") return ctx.localWorkspaceFolder;
    if (expr === "localWorkspaceFolderBasename") return ctx.localWorkspaceFolderBasename;
    if (expr === "containerWorkspaceFolder") return ctx.containerWorkspaceFolder ?? "";
    return _match;
  });
}

function expandStringOrArray(
  value: string | string[] | undefined,
  ctx: VariableContext
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((s) => expandVariables(s, ctx));
  return expandVariables(value, ctx);
}

function expandMount(
  entry: DevcontainerMountEntry,
  ctx: VariableContext
): DevcontainerMountEntry {
  if (typeof entry === "string") return expandVariables(entry, ctx);
  return {
    ...entry,
    source: entry.source ? expandVariables(entry.source, ctx) : undefined,
    target: expandVariables(entry.target, ctx),
  };
}

export function expandConfigVariables(
  config: DevcontainerConfig,
  ctx: VariableContext
): DevcontainerConfig {
  return {
    ...config,
    postCreateCommand: expandStringOrArray(config.postCreateCommand, ctx),
    postStartCommand: expandStringOrArray(config.postStartCommand, ctx),
    mounts: config.mounts?.map((m) => expandMount(m, ctx)),
    runArgs: config.runArgs?.map((a) => expandVariables(a, ctx)),
  };
}

export function mountToVolumeArg(mount: DevcontainerMountEntry): {
  flag: string;
  value: string;
} {
  if (typeof mount === "string") return { flag: "-v", value: mount };

  const type = mount.type ?? "bind";
  if (type === "tmpfs") {
    return { flag: "--tmpfs", value: mount.target };
  }

  let arg = `${mount.source ?? ""}:${mount.target}`;
  if (mount.options) arg += `:${mount.options}`;
  return { flag: "-v", value: arg };
}

export function mountsToDockerArgs(mounts: DevcontainerMountEntry[]): string[] {
  const args: string[] = [];
  for (const m of mounts) {
    const { flag, value } = mountToVolumeArg(m);
    args.push(flag, value);
  }
  return args;
}
