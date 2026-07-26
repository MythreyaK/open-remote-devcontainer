import * as path from "node:path";
import * as crypto from "node:crypto";

import * as schema from "../parser/schema";
import { ConfigError, InternalError, ParseError } from "../extension/error";
import { HostUserInfo } from "../common/utils";
import { EXTENSION_ID } from "../common/constants";
import { getWorkspaceId } from "../extension/workspace";

export interface ExecOpts {
    tty?: boolean,
    withRemoteEnv?: boolean,
};

export enum LifecycleCmd {
    onCreate = "onCreate",
    updateContent = "updateContent",
    postCreate = "postCreate",
    postStart = "postStart",
    postAttach = "postAttachCommand",
}

interface InferredWorkspace {
    remoteWorkspace: string,
    workspaceMount: string,
};

export class ContainerConfig<T extends schema.Config = schema.Config> {
    public readonly cfg: T;
    public readonly workspaceFolder: string;
    private readonly cfgPath: string;
    private readonly localEnv: NodeJS.ProcessEnv;

    private constructor(workspaceFolder: string, cfgPath: string, cfg: T, localEnv: NodeJS.ProcessEnv) {
        this.cfg = cfg;
        this.workspaceFolder = workspaceFolder;
        this.cfgPath = cfgPath;
        this.localEnv = localEnv;

        // TODO: normalize mount

        const { remoteWorkspace, workspaceMount } = ContainerConfig.getDefaultWorkspaceMount(this.cfg, this.workspaceFolder);
        this.cfg.workspaceFolder = remoteWorkspace;
        this.cfg.workspaceMount = workspaceMount;
    }

    public static getDefaultWorkspaceMount(cfg: schema.Config, localWsf: string): InferredWorkspace {
        // if one of workspaceFolder and workspaceMount or neither are set, use
        // defaults or infer the other
        const wsMount = cfg.workspaceMount;
        const remoteWsFolder = cfg.workspaceFolder;

        if (remoteWsFolder && !wsMount) {
            // remote location could be a subfolder of the standard mount
            // so don't update workspaceMount or workspaceFolder
            const wsBasename = path.parse(localWsf).base;
            return {
                remoteWorkspace: remoteWsFolder,
                workspaceMount: `source=${localWsf},target=/workspaces/${wsBasename},type=bind`,
            };
        }
        else if (wsMount && !remoteWsFolder) {
            const remoteWsf = schema.extractWorkspaceMount(wsMount);
            if (remoteWsf.length !== 1) {
                throw new ParseError("Invalid schema: expected exactly one source and target in workspaceMount");
            }
            return {
                remoteWorkspace: remoteWsf[0],
                workspaceMount: wsMount,
            };
        }
        else if (wsMount && remoteWsFolder) {
            return {
                workspaceMount: wsMount,
                remoteWorkspace: remoteWsFolder,
            };
        }
        else {
            const wsBasename = path.parse(localWsf).base;
            return {
                remoteWorkspace: `/workspaces/${wsBasename}`,
                workspaceMount: `source=${localWsf},target=/workspaces/${wsBasename},type=bind`,
            };
        }
    }

    static create<T extends schema.Config>(workspacePath: string, cfgPath: string, cfg: T, localEnv: NodeJS.ProcessEnv = process.env): ContainerConfig<T> {
        return new ContainerConfig(workspacePath, cfgPath, cfg, localEnv);
    }

    public isImageBased(): this is ContainerConfig<schema.ImageDevcontainer> {
        return schema.isImageBased(this.cfg);
    }

    public isDockerfileBased(): this is ContainerConfig<schema.DockerfileDevcontainer> {
        return schema.isDockerfileBased(this.cfg);
    }

    public getBuildCmd(this: ContainerConfig<schema.DockerfileDevcontainer>, opts: { noCache: boolean } = { noCache: false }): string[] {
        return [
            "build",
            ...(opts.noCache ? ["--pull", "--no-cache"] : this.getCacheFromArgs()),
            ...this.getBuildArgs(),
            "-t", this.getStage1ImageName(),
            "-f", this.getResolvedDockerfilePath(),
            ...(this.cfg.build.target ? ["--target", this.cfg.build.target] : []),
            ...this.cfg.build.options,
            this.getResolvedBuildcontextDir(),
        ].filter(Boolean)
            .map(e => interpolateLocal(e, this.workspaceFolder, this.getRemoteMountDir(), this.localEnv));
    }

    public getStage2BuildCmd(hostUserInfo: HostUserInfo, imgUser: string | undefined, opts: { noCache: boolean } = { noCache: false }): string[] {
        return [
            "build",
            // stage2 source is always local, so no --pull here
            ...(opts.noCache ? ["--no-cache"] : []),
            ...this.getStage2BuildArgs(hostUserInfo, imgUser),
            ...this.addLabels(),
            "-t", this.getStage2ImageName(),
            "-f", path.join(__dirname, "Dockerfile"),
            this.workspaceFolder,
        ].filter(Boolean);
    }

    public getRunCreateCmd(imageName: string, containerName: string, opts: { relabel?: boolean, extraArgs?: string[] }): string[] {
        // TODO: handle overrideCmd
        return [
            "run",
            "-d",
            "--name",
            containerName,
            ...this.addContainerUser(),
            ...this.addAppPorts(),
            ...this.addMounts(),
            ...this.addWorkspaceMount(opts.relabel ?? true),
            ...this.addContainerEnv(),
            ...this.addCaps(),
            ...this.addSecurityOpts(),
            ...this.addLabels(),
            ...(this.cfg.privileged ? ["--privileged"] : []),
            ...(this.cfg.init ? ["--init"] : []),
            ...this.addRunArgs(opts.extraArgs ?? []),
            "--entrypoint",
            this.getShell(),
            imageName,
            //
            "-c",
            'trap "echo Got signal, exiting...; exit 0" SIGINT SIGTERM; while sleep 60 & wait $! ; do : ; done',
        ].filter(Boolean)
            .map(e => interpolateLocal(e, this.workspaceFolder, this.getRemoteMountDir(), this.localEnv));
    }

    public getConfigLabel(): string {
        return `${EXTENSION_ID}.configId=${this.getConfigId()}`;
    }

    static getWorkspaceIdLabel(workspace: string): string {
        return `${EXTENSION_ID}.workspaceId=${getWorkspaceId(workspace)}`;
    }

    public getContainerName(): string {
        return ContainerConfig.getContainerName(this.workspaceFolder);
    }

    public getStage1ImageName(this: ContainerConfig<schema.DockerfileDevcontainer>): string {
        // TODO: resolve symlinks?
        // const safeImgName = this.workspacePath.replaceAll('/[^a-z0-9.-]', '-');
        return ContainerConfig._getStage1ImageName(this.workspaceFolder);
    }

    public getStage2ImageName(): string {
        return ContainerConfig._getStage2ImageName(this.workspaceFolder);
    }

    public addLabels(): string[] {
        return [
            "--label", this.getConfigLabel(),
            "--label", ContainerConfig.getWorkspaceIdLabel(this.workspaceFolder),
        ];
    }

    public getExecArgs(containerId: string, remoteEnvProbe: NodeJS.ProcessEnv, opts: ExecOpts = { tty: false, withRemoteEnv: true }): string[] {
        return [
            "exec",
            ...this.addRemoteUser(),
            ...(opts.withRemoteEnv ? this.addRemoteEnv(remoteEnvProbe) : []),
            (opts.tty ? "-t" : ""),
            containerId,
            ...(opts.withRemoteEnv ? this.getUnsetRemoteEnvArgs() : []),
        ].filter(Boolean);
    }

    public getUserEnvProbeArgs(): string[] {
        switch (this.cfg.userEnvProbe) {
            case "none": return [this.getShell()];
            case "loginShell": return [this.getShell(), "-l"];
            case "interactiveShell": return [this.getShell(), "-i"];
            case "loginInteractiveShell": return [this.getShell(), "-il"];
        }
        return [this.getShell(), "-il"];
    }

    public getResolvedRemoteUser(imageUser: string | undefined) {
        return this.cfg.remoteUser
          ?? this.cfg.containerUser
          ?? imageUser
          ?? "root";
    }

    public getResolvedBuildcontextDir(this: ContainerConfig<schema.DockerfileDevcontainer>): string {
        const cfgDir = path.dirname(this.cfgPath);
        const ret = interpolateLocal(this.cfg.build.context, this.workspaceFolder, this.getRemoteMountDir(), this.localEnv);
        return path.resolve(cfgDir, ret);
    }

    public getResolvedDockerfilePath(this: ContainerConfig<schema.DockerfileDevcontainer>): string {
        const cfgDir = path.dirname(this.cfgPath);
        const ret = interpolateLocal(this.cfg.build.dockerfile, this.workspaceFolder, this.getRemoteMountDir(), this.localEnv);
        return path.resolve(cfgDir, ret);
    }

    private getCacheFromArgs(this: ContainerConfig<schema.DockerfileDevcontainer>): string[] {
        const cf = this.cfg.build.cacheFrom;
        if (!cf) { return []; }
        const images = Array.isArray(cf) ? cf : [cf];
        return images.flatMap(img => ["--cache-from", img]);
    }

    private getBuildArgs(this: ContainerConfig<schema.DockerfileDevcontainer>): string[] {
        if (schema.isDockerfileBased(this.cfg)) {
            const args = this.cfg.build.args ?? {};
            return Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
        }
        return [];
    }

    private getStage2BuildArgs(hostUserInfo: HostUserInfo, imageUser: string | undefined): string[] {
        const imageName = (() => {
            if (this.isImageBased()) { return this.cfg.image; }
            else if (this.isDockerfileBased()) { return this.getStage1ImageName(); }
            else {
                throw new InternalError("getStage2BuildArgs: Unhandled image-name branch");
            }
        })();

        // priority order
        const username = this.getResolvedRemoteUser(imageUser);

        return [
            "--build-arg", `UPDATE_REMOTE_UID=${this.cfg.updateRemoteUserUID}`,
            "--build-arg", `BASE_IMAGE=${imageName}`,
            "--build-arg", `HOST_UID=${hostUserInfo.uid}`,
            "--build-arg", `HOST_GID=${hostUserInfo.gid}`,
            "--build-arg", `HOST_USERNAME=${username}`,
        ];
    }

    private addAppPorts(): string[] {
        if (!this.cfg.appPort) {
            return [];
        }

        const ret: string[] = [];
        if (Array.isArray(this.cfg.appPort)) {
            for (const port of this.cfg.appPort) {
                ret.push("-p", `${port}`);
            }
        }
        else {
            ret.push("-p", `${this.cfg.appPort}`);
        }

        return ret;
    }

    private addContainerUser(): string[] {
        if (this.cfg.containerUser) { return ["-u", this.cfg.containerUser]; }
        else { return []; /* uses container's default USER, empty items are filtered */ }
    }

    private addRemoteUser(): string[] {
        if (this.cfg.remoteUser) { return ["-u", this.cfg.remoteUser]; }
        else { return this.addContainerUser(); }
    }

    private addSecurityOpts(): string[] {
        return this.cfg.securityOpt.flatMap(s => ["--security-opt", s]);
    }

    private addCaps(): string[] {
        return this.cfg.capAdd.flatMap(c => ["--cap-add", c]);
    }

    private addRunArgs(extraArgs: string[]): string[] {
        return [...extraArgs, ...this.cfg.runArgs];
    }

    public getRemoteMountDir(): string {
        if (!this.cfg.workspaceMount) { throw new InternalError("getDefaultWorkspaceMount should've set defaults."); }
        return schema.extractWorkspaceMount(this.cfg.workspaceMount)[0];
    }

    private addWorkspaceMount(relabel: boolean): string[] {
        if (!this.cfg.workspaceMount) { throw new InternalError("getDefaultWorkspaceMount should've set defaults."); }
        return ["--mount", `${this.cfg.workspaceMount}${relabel ? ",relabel=shared" : ""}`];
    }

    private addMounts(): string[] {
        const ret: string[] = [];

        if (this.cfg.mounts) {
            for (const mount of this.cfg.mounts) {
                if (typeof mount === "string") {
                    ret.push("--mount", mount);
                }
                else if (mount.type === "bind") {
                    if (!mount.source) {
                        throw new ConfigError("Bind mount requires both source and target");
                    }
                    if (mount.options) {
                        ret.push("-v", `${mount.source}:${mount.target}:${mount.options}`);
                    }
                    else {
                        ret.push("-v", `${mount.source}:${mount.target}`);
                    }
                }
                else {
                    let mnt = "";
                    // TODO: This is order-dependent. Cleanup later?
                    if (mount.source) {
                        mnt += `${mount.source}:`;
                    }

                    mnt += mount.target;
                    if (mount.options) {
                        mnt += `:${mount.options}`;
                    }
                    ret.push("-v", mnt);
                }
            }
        }

        return ret;
    }

    public getResolvedRemoteEnv(remoteEnvsProbe: NodeJS.ProcessEnv): Record<string, string> {
        const ret: Record<string, string> = {};

        for (const [k, v] of Object.entries(this.cfg.remoteEnv ?? {})) {
            if (v === null) {
                // TODO: can't unset env from here ... part of lifecycle script?
                /* ret.push("--env", k); */
            }
            else {
                ret[k] = interpolateContainer(v, this.workspaceFolder, this.getRemoteMountDir(), this.localEnv, remoteEnvsProbe);
            }
        }
        return ret;
    }

    /**
     *
     * @returns env -u ENV1 -u ENV2 for all ENVs that have undefined / null values
     *          To be used with docker exec <container> env -u ENV ... <cmd>
     */
    public getUnsetRemoteEnvArgs(): string[] {
        const unsetEnvs = Object.entries(this.cfg.remoteEnv ?? {})
            .filter(([_, v]) => v === null)
            .flatMap(([k, _]) => ["-u", k]);

        if (unsetEnvs.length > 0) { return ["env", ...unsetEnvs]; }
        else { return []; }
    }

    private addRemoteEnv(remoteEnvsProbe: NodeJS.ProcessEnv): string[] {
        const ret: string[] = [];

        for (const [k, v] of Object.entries(this.getResolvedRemoteEnv(remoteEnvsProbe))) {
            ret.push("--env", `${k}=${v}`);
        }
        return ret;
    }

    private addContainerEnv(): string[] {
        const ret: string[] = [];

        for (const [k, v] of Object.entries(this.cfg.containerEnv ?? {})) {
            ret.push("--env", `${k}=${v}`);
        }
        return ret;
    }

    private getShell(): string {
        // TODO: supporrt other shells
        return "bash";
    }

    // private getRunInBash(args: string[]): string[] {
    //     return [this.getShell(), ...args];
    // }

    // reference: https://containers.dev/implementors/json_reference/
    public getConfigId(): string {
        const items = JSON.stringify([
            // image / build
            "image" in this.cfg ? this.cfg.image : "",
            "build" in this.cfg ? this.cfg.build : "",

            // container creation
            this.cfg.name ?? "",
            this.cfg.runArgs,
            this.cfg.workspaceFolder ?? "",
            this.cfg.workspaceMount ?? "",
            this.cfg.mounts ?? "",
            this.cfg.containerEnv ?? "",
            this.cfg.containerUser ?? "",
            this.cfg.updateRemoteUserUID,
            this.cfg.overrideCommand,
            this.cfg.init,
            this.cfg.privileged,
            this.cfg.capAdd,
            this.cfg.securityOpt,
            this.cfg.appPort ?? "",

            // lifecycle
            this.cfg.initializeCommand ?? "",
            this.cfg.onCreateCommand ?? "",
            this.cfg.updateContentCommand ?? "",
            this.cfg.postCreateCommand ?? "",
            this.cfg.postStartCommand ?? "",
            this.cfg.postAttachCommand ?? "",

            // session (reconnect-only, but still part of config identity)
            this.cfg.remoteEnv ?? "",
            this.cfg.remoteUser ?? "",

            // not yet supported
            // this.cfg.features ?? "",
            // this.cfg.overrideFeatureInstallOrder ?? "",
            // this.cfg.hostRequirements ?? "",
            // this.cfg.waitFor ?? "",
            // this.cfg.portsAttributes ?? "",
            // this.cfg.otherPortsAttributes ?? "",
        ]);

        return crypto
            .createHash("sha256")
            .update(items)
            .digest("hex")
            .slice(0, 16);
    }

    public getInitializeCmd(): string[] | undefined {
        const cmd = this.cfg.initializeCommand;
        if (!cmd || cmd.length === 0) { return undefined; }
        else {
            if (typeof cmd === "string") { return ["/bin/sh", "-c", cmd]; }
            else if (Array.isArray(cmd)) { return cmd; }
        }

        return undefined;
    }

    public getLifecycleCmd(cmdType: LifecycleCmd): Record<string, string[]> {
        const cmd = (() => {
            switch (cmdType) {
                case LifecycleCmd.onCreate: return this.cfg.onCreateCommand;
                case LifecycleCmd.updateContent: return this.cfg.updateContentCommand;
                case LifecycleCmd.postCreate: return this.cfg.postCreateCommand;
                case LifecycleCmd.postStart: return this.cfg.postStartCommand;
                case LifecycleCmd.postAttach: return this.cfg.postAttachCommand;
            }
        })();

        return ContainerConfig.normalizeLifecycleCmd(cmd);
    }

    static normalizeLifecycleCmd(args: schema.Cmd | undefined): Record<string, string[]> {
        if (!args || (Array.isArray(args) && args.length === 0)) { return {}; }

        if (typeof args === "string") {
            return { string: ["/bin/sh", "-c", args] };
        }
        else if (Array.isArray(args)) {
            return { array: args };
        }
        else {
            const entries = Object.entries(args);
            const mapped = entries.map(([k, v]) =>
                // get a [key, transformed(value)] so that we
                // can pair them back again in the end with fromEntries
                [
                    k,
                    Object.values(this.normalizeLifecycleCmd(v))[0],
                ],
            );
            return Object.fromEntries(mapped) as Record<string, string[]>;
        }
    }

    public static getNameId(wsf: string): string {
        return `codium-devcontainer-${getWorkspaceId(wsf)}`;
    }

    public static getContainerName(wsf: string): string {
        return ContainerConfig.getNameId(wsf);
    }

    /**
     *
     * Only for use in tests. Not to be used directly
     */
    public static _getStage1ImageName(wsf: string): string {
        return ContainerConfig.getNameId(wsf);
    }

    /**
     *
     * Only for use in tests. Not to be used directly
     */
    public static _getStage2ImageName(wsf: string): string {
        return `${ContainerConfig._getStage1ImageName(wsf)}-uid`;
    }
}

export function interpolateLocal(val: string, localWorkspace: string, remoteWorkspace: string, localEnv: NodeJS.ProcessEnv) {
    const varsRemoved = interpolateVars(val, localWorkspace, remoteWorkspace);
    return interpolateEnv(varsRemoved, localEnv, "localEnv");
}

export function interpolateContainer(val: string, localWorkspace: string, remoteWorkspace: string, localEnv: NodeJS.ProcessEnv, remoteEnv: NodeJS.ProcessEnv) {
    const varsRemoved = interpolateVars(val, localWorkspace, remoteWorkspace);
    const localEnvRemoved = interpolateEnv(varsRemoved, localEnv, "localEnv");
    const remoteEnvRemoved = interpolateEnv(localEnvRemoved, remoteEnv, "containerEnv");
    return remoteEnvRemoved;
}

export function interpolateVars(val: string, localWorkspace: string, remoteWorkspace: string) {
    const localWorkspaceBasename = path.parse(localWorkspace).base;
    const remoteWorkspaceBasename = path.parse(remoteWorkspace).base;

    return val
        .replaceAll("${localWorkspaceFolder}", localWorkspace)
        .replaceAll("${containerWorkspaceFolder}", remoteWorkspace)
        .replaceAll("${localWorkspaceFolderBasename}", localWorkspaceBasename)
        .replaceAll("${containerWorkspaceFolderBasename}", remoteWorkspaceBasename);
}

export function interpolateEnv(envStr: string, procEnv: NodeJS.ProcessEnv, envHook: string) {
    const regExp = new RegExp(`\\$\{${envHook}:([^}]+)}`, "g");
    const matches = Array.from(envStr.matchAll(regExp));

    let ret = envStr;
    for (const match of matches) {
        const [varName, defaultValue, ...rest] = match[1].split(":");

        if (varName in procEnv) {
            ret = ret.replaceAll(match[0], procEnv[varName] ?? "");
        }
        else {
            const varValue = [defaultValue, ...rest].join(":");
            ret = ret.replaceAll(match[0], varValue);
        }
    }
    return ret;
}
