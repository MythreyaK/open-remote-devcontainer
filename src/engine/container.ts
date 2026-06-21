import * as path from "node:path";
import * as crypto from "node:crypto";

import * as schema from "../parser/schema";
import { getLogSink } from "../extension/log";
import { ConfigError } from "../extension/error";

export interface ExecOpts {
    tty?: boolean,
    withRemoteEnv?: boolean,
};

export class ContainerConfig<T extends schema.Config = schema.Config> {
    public readonly cfg: T;
    public readonly workspacePath: string;
    private readonly localEnv: NodeJS.ProcessEnv;

    private constructor(cfg: T, workspacePath: string, localEnv: NodeJS.ProcessEnv) {
        this.cfg = cfg;
        this.workspacePath = path.resolve(workspacePath);
        this.localEnv = localEnv;
    // normalize mount
    }

    static create<T extends schema.Config>(workspacePath: string, cfg: T, localEnv: NodeJS.ProcessEnv = process.env): ContainerConfig<T> {
        return new ContainerConfig(cfg, workspacePath, localEnv);
    }

    public isImageBased(): this is ContainerConfig<schema.ImageDevcontainer> {
        return schema.isImageBased(this.cfg);
    }

    public isDockerfileBased(): this is ContainerConfig<schema.DockerfileDevcontainer> {
        return schema.isDockerfileBased(this.cfg);
    }

    // TODO: handle cacheFrom
    public getBuildCmd(this: ContainerConfig<schema.DockerfileDevcontainer>): string[] {
        return [
            "build",
            ...this.getBuildArgs(),
            "-t", this.getImageName(),
            "-f", this.cfg.build.dockerfile,
            ...(this.cfg.build.target ? ["--target", this.cfg.build.target] : []),
            ...(this.cfg.build.options ? this.cfg.build.options : []),
            this.cfg.build.context ?? this.workspacePath,
        ].filter(Boolean)
            .map(e => interpolateLocal(e, this.workspacePath, this.getRemoteMountDir(), this.localEnv));
    }

    public getRunCreateCmd(imageName: string, containerName: string, extraArgs: string[] = []): string[] {
    // TODO: handle overrideCmd
        return [
            "run",
            "-d",
            "--name",
            containerName,
            ...this.addContainerUser(),
            ...this.addAppPorts(),
            ...this.addMounts(),
            ...this.addWorkspaceMount(),
            ...this.addContainerEnv(),
            ...this.addRunArgs(),
            ...this.addCaps(),
            ...this.addSecurityOpts(),
            ...extraArgs,
            this.cfg.privileged ? "--privileged" : "",
            this.cfg.init ? "--init" : "",
            "--entrypoint",
            this.getShell(),
            imageName,
            //
            "-c",
            'trap "echo Got signal, exiting...; exit 0" SIGINT SIGTERM; while sleep 60 & wait $! ; do : ; done',
        ].filter(Boolean)
            .map(e => interpolateLocal(e, this.workspacePath, this.getRemoteMountDir(), this.localEnv));
    }

    public getImageName(this: ContainerConfig<schema.DockerfileDevcontainer>): string {
    // TODO: resolve symlinks?
    // const safeImgName = this.workspacePath.replaceAll('/[^a-z0-9.-]', '-');
        const idHash = crypto
            .createHash("sha256")
            .update(this.workspacePath)
            .digest("hex")
            .slice(0, 8);

        getLogSink().info(`Image name from workspace '${this.workspacePath}' : '${idHash}'`);
        return `codium-devcontainer-${idHash}`;
    }

    public getExecArgs(containerId: string, containerEnvs: NodeJS.ProcessEnv, opts: ExecOpts = { tty: false, withRemoteEnv: true }): string[] {
        return [
            "exec",
            ...this.addRemoteUser(),
            ...(opts.withRemoteEnv ? this.addRemoteEnv(containerEnvs) : []),
            (opts.tty ? "-t" : ""),
            containerId,
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

    private getBuildArgs(this: ContainerConfig<schema.DockerfileDevcontainer>): string[] {
        if (schema.isDockerfileBased(this.cfg)) {
            const args = this.cfg.build.args ?? [];
            return Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
        }
        return [];
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
        if (this.cfg.containerUser) {
            return ["-u", `${this.cfg.containerUser}:${this.cfg.containerUser}`];
        }
        else {
            // uses container's default USER, "" is removed
            return [];
        }
    }

    private addRemoteUser(): string[] {
        if (this.cfg.remoteUser) {
            return ["-u", `${this.cfg.remoteUser}:${this.cfg.remoteUser}`];
        }
        else {
            return this.addContainerUser();
        }
    }

    private addSecurityOpts(): string[] {
        if (this.cfg.securityOpt) {
            return this.cfg.securityOpt.flatMap(s => ["--security-opt", s]);
        }
        else {
            return [];
        }
    }

    private addCaps(): string[] {
        if (this.cfg.capAdd) {
            return this.cfg.capAdd.flatMap(c => ["--cap-add", c]);
        }
        else {
            return [];
        }
    }

    private addRunArgs(): string[] {
        if (this.cfg.runArgs) {
            return this.cfg.runArgs;
        }
        else {
            return [];
        }
    }

    public getRemoteMountDir(): string {
        if (this.cfg.workspaceMount) {
            return schema.extractWorkspaceMount(this.cfg.workspaceMount)[0];
        }
        else {
            const basename = path.parse(this.workspacePath).base;
            return `/workspace/${basename}`;
        }
    }

    private addWorkspaceMount(): string[] {
        if (this.cfg.workspaceMount) {
            return ["--mount", this.cfg.workspaceMount];
        }
        else {
            return ["-v", `${this.workspacePath}:${this.getRemoteMountDir()}`];
        }
    }

    private addMounts(): string[] {
        const ret: string[] = [];

        if (this.cfg.mounts) {
            for (const mount of this.cfg.mounts) {
                if (typeof mount === "string") {
                    ret.push("-v", mount);
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

    public getResolvedRemoteEnv(containerEnvsProbe: NodeJS.ProcessEnv): Record<string, string> {
        const ret: Record<string, string> = {};

        for (const [k, v] of Object.entries(this.cfg.remoteEnv ?? {})) {
            if (v === null) {
                // TODO: can't unset env from here ... part of lifecycle script?
                /* ret.push("--env", k); */
            }
            else {
                ret[k] = interpolateContainer(v, this.workspacePath, this.getRemoteMountDir(), this.localEnv, containerEnvsProbe);
            }
        }
        return ret;
    }

    private addRemoteEnv(containerEnvsProbe: NodeJS.ProcessEnv): string[] {
        const ret: string[] = [];

        for (const [k, v] of Object.entries(this.getResolvedRemoteEnv(containerEnvsProbe))) {
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
            this.cfg.name ?? "",
            this.cfg.runArgs ?? "",
            this.cfg.initializeCommand ?? "",
            this.cfg.onCreateCommand ?? "",
            this.cfg.updateContentCommand ?? "",
            this.cfg.postCreateCommand ?? "",
            this.cfg.postStartCommand ?? "",
            this.cfg.postAttachCommand ?? "",
            this.cfg.workspaceFolder ?? "",
            this.cfg.workspaceMount ?? "",
            this.cfg.mounts ?? "",
            this.cfg.containerEnv ?? "",
            this.cfg.remoteEnv ?? "",
            this.cfg.containerUser ?? "",
            this.cfg.remoteUser ?? "",
            // this.cfg.customizatios
        ]);

        return crypto
            .createHash("sha256")
            .update(items)
            .digest("hex");
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
