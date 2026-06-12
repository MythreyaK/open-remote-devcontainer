import * as schema from '../parser/schema';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { getLogSink } from '../extension/log';
import { ConfigError } from '../extension/error';

function interpolateEnv(value: string, env: Record<string, string>) {

}

function ensure(func: (() => boolean), msg: string) {
    if (!func()) { throw new ConfigError(`Invalid config: ${msg}`) };
}

interface WorkspaceMount {
    source: string,
    target: string,
};

export class ContainerConfig<T extends schema.Config = schema.Config> {
    public readonly cfg: T;
    public readonly workspacePath: string;

    private constructor(cfg: T, workspacePath: string) {
        this.cfg = cfg;
        this.workspacePath = path.resolve(workspacePath);

        // normalize mount
    }

    static create<T extends schema.Config>(cfg: T, workspacePath: string, skipValidation: boolean = false): ContainerConfig<T> {
        if (!skipValidation && !this.validate(cfg, workspacePath)) throw new ConfigError("Invalid config");
        return new ContainerConfig(cfg, workspacePath);
    }

    static validate(cfg: schema.Config, workspacePath: string) {
        // TODO: validation?
        ensure(() => { return existsSync(workspacePath) },
            `Invalid workspace folder '${workspacePath}'`);

        // const mounts = this.getWorkspaceMount();
        // ensure(() => {
        //     return existsSync(path.resolve(mounts.source));
        // }, `Invalid mount source '${mounts.source}'`);
        return true;
    }

    public isImageBased(): this is ContainerConfig<schema.ImageDevcontainer> {
        return schema.isImageBased(this.cfg)
    }

    public isDockerfileBased(): this is ContainerConfig<schema.DockerfileDevcontainer> {
        return schema.isDockerfileBased(this.cfg)
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
        ];
    }

    public getCreateArgs(imageName: string): string[] {
        return [
            "create",
            ...this.addContainerUser(),
            ...this.addAppPorts(),
            ...this.addMounts(),
            ...this.addWorkspaceMount(),
            ...this.addContainerEnv(),
            ...this.addRunArgs(),
            ...this.addCaps(),
            ...this.addSecurityOpts(),
            this.cfg.privileged ? "--privileged" : "",
            this.cfg.init ? "--init" : "",
            imageName,
        ].filter(Boolean);
    }

    public getImageName(this: ContainerConfig<schema.DockerfileDevcontainer>): string {
        // TODO: resolve symlinks?
        // const safeImgName = this.workspacePath.replaceAll('/[^a-z0-9.-]', '-');
        const idHash = crypto
            .createHash('sha256', { encoding: 'utf-8' })
            .update(this.workspacePath)
            .digest()
            .toString()
            .slice(16);

        getLogSink().info(`Image name from workspace '${this.workspacePath}' : '${idHash}'`);
        return `codium-devcontainer-${idHash}`;
    }

    public getExecArgs(): string[] {
        return [
            ...this.addRemoteUser(),
            ...this.addRemoteEnv(),
        ];
    }

    public getUserEnvProbeArgs(): string[] {
        switch (this.cfg.userEnvProbe) {
            case 'none': return [];
            case 'loginShell': return [this.getShell(), "-l"];
            case 'interactiveShell': return [this.getShell(), "-i"];
            case 'loginInteractiveShell': return [this.getShell(), "-il"];
        }
        return [];
    }

    private getBuildArgs(this: ContainerConfig<schema.DockerfileDevcontainer>): string[] {
        if (schema.isDockerfileBased(this.cfg)) {
            const args = this.cfg.build.args ?? [];
            return Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
        }
        return [];
    }

    private addAppPorts(): string[] {
        if (!this.cfg.appPort) { return []; }
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
        if (this.cfg.containerUser) { return ["-u", `${this.cfg.containerUser}:${this.cfg.containerUser}`]; }
        else { return []; } // uses container's default USER, "" is removed
    }

    private addRemoteUser(): string[] {
        if (this.cfg.remoteUser) { return ["-u", `${this.cfg.remoteUser}:${this.cfg.remoteUser}`]; }
        else { return this.addContainerUser(); }
    }

    private addSecurityOpts(): string[] {
        if (this.cfg.securityOpt) { return this.cfg.securityOpt.flatMap(s => ["--security-opt", s]); }
        else { return []; }
    }

    private addCaps(): string[] {
        if (this.cfg.capAdd) { return this.cfg.capAdd.flatMap(c => ["--cap-add", c]); }
        else { return []; }
    }

    private addRunArgs(): string[] {
        if (this.cfg.runArgs) {
            return this.cfg.runArgs;
        }
        else { return []; }
    }

    private getWorkspaceMount(): WorkspaceMount {
        const wsMount = this.cfg.workspaceMount;
        const wsFolder = this.cfg.workspaceFolder;

        if (wsFolder && wsMount) {
            return {
                source: wsFolder,
                target: wsMount
            };
        }
        else {
            return {
                source: this.workspacePath,
                target: `/workspace/${wsFolder}`,
            };
        }
    }

    private addWorkspaceMount(): string[] {
        const mountInfo = this.getWorkspaceMount();
        return ["-v", `${mountInfo.source}:${mountInfo.target}`];
    }

    private addMounts(): string[] {
        const ret: string[] = [];

        if (this.cfg.mounts) {
            for (const mount of this.cfg.mounts) {
                if (typeof mount === "string") {
                    ret.push("-v", mount);
                }
                else if (mount.type === "bind") {
                    if (!mount.source) { throw new ConfigError("Bind mount requires both source and target"); }
                    if (mount.options) { ret.push("-v", `${mount.source}:${mount.target}:${mount.options}`); }
                    else { ret.push("-v", `${mount.source}:${mount.target}`); }
                } else {
                    let mnt = "";
                    // TODO: This is order-dependent. Cleanup later?
                    if (mount.source) { mnt += `${mount.source}:`; }
                    mnt += mount.target;
                    if (mount.options) { mnt += `:${mount.options}`; }
                    ret.push("-v", mnt);
                }
            }
        }

        return ret;
    }

    private addRemoteEnv(): string[] {
        const ret: string[] = [];

        for (const [k, v] of Object.entries(this.cfg.remoteEnv ?? {})) {
            if (v === null) {
                // TODO: can't unset env from here ... part of lifecycle script?
                /* ret.push("--env", k); */
            }
            else {
                ret.push("--env", `${k}=${v}`);
            }
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

    private getRunInBash(args: string[]): string[] {
        return [this.getShell(), ...args];
    }
}
