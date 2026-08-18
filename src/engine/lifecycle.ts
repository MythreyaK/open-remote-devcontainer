import path from "node:path";

import { run } from "../common/cmd";
import { getLogSink } from "../extension/log";
import { formatCmdErr } from "../common/spawn";
import { parseEnv, getHostUserInfo } from "../common/utils";
import { ContainerConfig, ContainerEngine, LifecycleCmd } from "./container";
import { EngineError, InstallError, InternalError } from "../extension/error";
import { NotificationLevel, showNotification } from "../extension/workspace";

import * as settings from "../extension/settings";
import * as server from "../remote/installServer";
import { EXTENSION_ID, DEVCONTAINER_SERVER_LISTEN_PORT } from "../common/constants";
const UUID_TOKEN_LEN = 36;

const jsonFormat = ["--format", "{{json .}}"];

export const STAGE2_INFO_MSG_REGEX = /{{DEVCONTAINER_STAGE2 INFO: (.*?)}}/g;
export const STAGE2_WARN_MSG_REGEX = /{{DEVCONTAINER_STAGE2 WARNING: (.*?)}}/g;
export const STAGE2_ERR_MSG_REGEX = /{{DEVCONTAINER_STAGE2 ERROR: (.*?)}}/g;

export interface ContainerInspectResult {
    Id: string,
    Name: string,
    State: {
        Status: "created" | "running" | "paused" | "stopped" | "exited",
        Running: boolean,
    },
    Mounts: {
        Type: string,
        Source: string,
        Destination: string,
        Driver: string,
        Mode: string,
        Options: string[],
        RW: boolean,
        Propagation: "shared" | "slave" | "private" | "unbindable" | "rshared" | "rslave" | "runbindable" | "rprivate",
    }[],
};

export interface ImageInspectResult {
    Id: string,
    Name: string,
    User: string | undefined,
};

export enum BuildOpts {
    Default = "default",
    Rebuild = "rebuild",
    RebuildNoCache = "rebuildNoCache",
};

export class ContainerState {
    private readonly workspaceFolder: string;
    private readonly cc: ContainerConfig;
    private readonly buildOpts: BuildOpts;

    private remoteEnvProbe: Record<string, string> = {};
    // private imageId: string;

    private constructor(workspaceFolder: string, cc: ContainerConfig, opts: BuildOpts = BuildOpts.Default) {
        this.workspaceFolder = path.resolve(workspaceFolder);
        this.cc = cc;
        this.buildOpts = opts;
    }

    public static async create(workspaceFolder: string, cc: ContainerConfig, opts: BuildOpts = BuildOpts.Default): Promise<ContainerState> {
        getLogSink().info(`Using compat/convenience options for '${cc.engine}'`);
        // mmm more spaghetti ... TODO: could use some cleanup
        const ret = new ContainerState(workspaceFolder, cc, opts);
        await ret.runInitializeCmd();

        if (opts !== BuildOpts.Default) {
            getLogSink().info(`'${opts}' requested ...`);
            await ret.tryStopContainer();
            await ret.removeContainer();
        }

        const containerExists = await ret.tryContainerInspect(ret.getContainerName());
        let containerId: string | undefined;

        if (opts !== BuildOpts.Default && containerExists !== undefined) {
            throw new EngineError(`Failed to stop and remove container: ${containerExists.Id}`);
        }

        let lifecycleCmds = true;
        if (containerExists === undefined) {
            containerId = await ret.createContainer();

            if (!await ret.isRunning()) {
                throw new Error(`Could not start container ${ret.getContainerName()}`);
            }

            ret.remoteEnvProbe = await ret.getContainerEnv();
            lifecycleCmds &&= await ret.runLifecycleCmd(LifecycleCmd.onCreate)
              && await ret.runLifecycleCmd(LifecycleCmd.updateContent)
              && await ret.runLifecycleCmd(LifecycleCmd.postCreate)
              && await ret.runLifecycleCmd(LifecycleCmd.postStart);
        }
        else if (!containerExists.State.Running) {
            containerId = await ret.startContainer();
            lifecycleCmds &&= await ret.runLifecycleCmd(LifecycleCmd.postStart);
        }
        else {
            containerId = containerExists.Id;
        }

        if (!containerId) {
            throw new Error("Could not start container. Check logs");
        }

        ret.remoteEnvProbe = await ret.getContainerEnv();
        return ret;
    }

    private async runInitializeCmd() {
        const cmd = this.cc.getInitializeCmd();
        if (!cmd) { return; }

        getLogSink().info(`InitializeCmd[host]: Executing cmd [${cmd.join(", ")}]`);
        const res = await run([
            ...cmd,
        ], { cwd: this.workspaceFolder });

        if (res.exit === 0) {
            getLogSink().info(`InitializeCmd[host]: OK :: ${formatCmdErr(res)}`);
        }
        else {
            getLogSink().info(`InitializeCmd[host]: ERROR :: ${formatCmdErr(res)}`);
        }
    }

    private async runLifecycleCmd(cmdType: LifecycleCmd) {
        const cname = this.getContainerName();
        const cmds = Object.entries(this.cc.getLifecycleCmd(cmdType));

        const results = await Promise.allSettled(
            cmds
                .map(([name, cmd]) => {
                    getLogSink().info(`LifecycleCmd: ${cmdType}[${cname}]: Executing '${name}' cmd [${cmd.join(", ")}]`);

                    // TODO: run in bash as a single exec instead? Might lose per-pid error reporting
                    return run([
                        ...settings.getEngineCmd(),
                        ...this.cc.getExecArgs(cname, this.remoteEnvProbe),
                        ...cmd,
                    ], { cwd: this.workspaceFolder });
                }));

        let allOk = true;
        for (let i = 0; i < results.length; ++i) {
            const cmdName = cmds[i][0];
            const res = results[i];

            if (res.status === "fulfilled") {
                const val = res.value;
                allOk &&= (val.exit === 0);
                getLogSink().info(`LifecycleCmd: ${cmdType}[${cname}]: OK: '${cmdName}' returned ${val.exit}`);
            }
            else {
                allOk &&= false;
                getLogSink().error(`LifecycleCmd: ${cmdType}[${cname}]: ERROR: '${cmdName}' failed to execute: ${res.reason}`);
            }
        }
        getLogSink().info(`LifecycleCmd: ${cmdType}[${cname}] status: allOk=${allOk}`);
        return allOk;
    }

    public getConfig(): ContainerConfig {
        return this.cc;
    }

    public async getContainerId(): Promise<string> {
        const ret = await this.inspectContainer(this.getContainerName());
        return ret.Id;
    }

    public getContainerName(): string {
        return this.cc.getContainerName();
    }

    private async createContainer() {
        const { image, remoteUser } = await this.buildFinalImage();
        return await this.runCreate(image, remoteUser);
    }

    private async buildFinalImage(): Promise<{ image: string, remoteUser: string }> {
        let stage1Image: string | undefined;

        if (this.cc.isDockerfileBased()) {
            const name = await this.buildUserImage();
            stage1Image = name;
        }
        else if (this.cc.isImageBased()) {
            stage1Image = this.cc.cfg.image;

            // ensure image exists
            const img = await this.tryInspectImage(stage1Image);

            if (!img || this.buildOpts !== BuildOpts.Default) {
                // attempt to pull image
                const imageHash = await (async () => {
                    getLogSink().warn(`Image '${stage1Image}' does not exist or noCache specified, attempting to pull ...`);
                    const pullRes = await run([
                        ...settings.getEngineCmd(),
                        "pull",
                        stage1Image,
                    ], { cwd: this.workspaceFolder });

                    if (pullRes.exit !== 0) {
                        throw new EngineError(`Failed to pull image ${stage1Image}. Image '${stage1Image}' does not exist on host :: ${formatCmdErr(pullRes)}`);
                    }
                    // pull was successful, image hash is whatever pull has
                    return pullRes.stdout.trim();
                })();
                getLogSink().info(`Pulled image '${stage1Image}' (${imageHash})`);
            }
        }
        else {
            throw new InternalError("ContainerConfig isn't dockerfile or image based");
        }

        getLogSink().info(`Building stage2 image from ${stage1Image}`);

        return await this.buildStage2(stage1Image);
    }

    private async getEffectiveUser(stage1Image: string): Promise<{ imageUser: string | undefined, remoteUser: string }> {
        const imgUser = await run([
            ...settings.getEngineCmd(),
            "image",
            "inspect",
            stage1Image,
            ...jsonFormat,
        ], { cwd: this.workspaceFolder });

        if (imgUser.exit !== 0) {
            throw new EngineError(`Could not query ${stage1Image} User field. ${formatCmdErr(imgUser)}`);
        }

        const imageUser = (() => {
            const parsed = fixDockerImageInspect(this.cc.engine, imgUser.stdout.trim());
            if (!parsed.User) { return undefined; }
            else { return parsed.User; }
        })();

        const remoteUser = this.cc.getResolvedRemoteUser(imageUser);
        return { imageUser, remoteUser };
    }

    private async buildStage2(stage1Image: string): Promise<{ image: string, remoteUser: string }> {
        const { imageUser, remoteUser } = await this.getEffectiveUser(stage1Image);

        if (remoteUser === "root") {
            const msg = "Warning: remote user not specified, using 'root'. This may cause permission issues.";
            getLogSink().warn(msg);
            showNotification(NotificationLevel.Warning, msg);
        }

        const hostUserInfo = await getHostUserInfo(this.workspaceFolder);
        const ret = await run([
            ...settings.getEngineCmd(),
            ...this.cc.getStage2BuildCmd(hostUserInfo, imageUser, { noCache: this.buildOpts === BuildOpts.RebuildNoCache }),
        ], { cwd: this.workspaceFolder });

        if (ret.exit !== 0) {
            // docker and podman output differs, some to stdout, some to stderr
            const output = ret.stdout.trim() + ret.stderr.trim();
            const errMsg = Array.from(output.matchAll(STAGE2_ERR_MSG_REGEX));
            getLogSink().error(JSON.stringify(errMsg));
            if (errMsg.length !== 1 || errMsg[0].length < 2) {
                throw new Error(`Could not build stage2 image with unknown error :: ${formatCmdErr(ret)}`);
            }
            else {
                throw new EngineError(`Could not build stage2 image: ${errMsg[0][1]}`);
            }
        }
        else {
            return { image: this.cc.getStage2ImageName(), remoteUser };
        }
    }

    public async isRunning(): Promise<boolean> {
        const ret = await this.inspectContainer(this.getContainerName());
        return ret.State.Running;
    }

    private async startContainer(): Promise<string> {
        const ret = await run([
            ...settings.getEngineCmd(),
            "start",
            this.getContainerName(),
        ], { cwd: this.workspaceFolder });

        if (ret.exit !== 0) {
            throw new EngineError(`Failed to start container :: ${formatCmdErr(ret)}`);
        }
        else {
            return ret.stdout.trim();
        }
    }

    public async tryStopContainer(opts: { force: boolean } = { force: false }) {
        const ret = await run([
            ...settings.getEngineCmd(),
            "stop",
            ...(opts.force ? ["-t", "1"] : []),
            this.getContainerName(),
        ], { cwd: this.workspaceFolder });
        return ret;
    }

    public async stopContainer(opts: { force: boolean } = { force: false }) {
        const ret = await this.tryStopContainer(opts);

        if (ret.exit !== 0) {
            throw new EngineError(`Could not stop container :: ${formatCmdErr(ret)}`);
        }

        return ret.stdout.trim();
    }

    public async removeContainer() {
        const ret = await this.tryRemoveContainer();
        if (ret.exit !== 0) {
            getLogSink().error(`Could not remove container ${ret.exit}: ${ret.stderr.trim()}, forcing ...`);
            const fRet = await this.tryRemoveContainer({ force: true });
            return fRet.stdout.trim();
        }
        else {
            return ret.stdout.trim();
        }
    }

    public async tryRemoveContainer(opts: { force: boolean } = { force: false }) {
        const ret = await run([
            ...settings.getEngineCmd(),
            "rm",
            ...(opts.force ? ["--force"] : []),
            this.getContainerName(),
        ], { cwd: this.workspaceFolder });
        return ret;
    }

    private async inspectContainer(identifier: string): Promise<ContainerInspectResult> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "container",
                "inspect",
                identifier,
                ...jsonFormat,
            ], { cwd: this.workspaceFolder },
        );

        if (res.exit !== 0) {
            throw new EngineError(`Could not inspect container '${identifier}' :: ${formatCmdErr(res)}`);
        }
        else {
            return JSON.parse(res.stdout.trim()) as ContainerInspectResult;
        }
    }

    private async tryInspectImage(identifier: string): Promise<ImageInspectResult | undefined> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "image",
                "inspect",
                identifier,
                ...jsonFormat,
            ], { cwd: this.workspaceFolder },
        );

        if (res.exit !== 0) {
            return undefined;
        }
        else {
            return fixDockerImageInspect(this.cc.engine, res.stdout.trim());
        }
    }

    public async tryContainerInspect(identifier: string): Promise<ContainerInspectResult | undefined> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "container",
                "inspect",
                identifier,
                ...jsonFormat,
            ], { cwd: this.workspaceFolder },
        );

        if (res.exit !== 0) {
            return undefined;
        }
        else {
            return JSON.parse(res.stdout.trim()) as ContainerInspectResult;
        }
    }

    /**
     * Container must be running before calling this. Throws otherwise.
     *
     * @returns Connection token that is used for authenticating with server.
     */
    public async getConnectionToken(): Promise<string> {
        const checkExists = await this.tryContainerInspect(this.getContainerName());
        if (checkExists !== undefined && checkExists.State.Running) {
            // TODO: token in tempdir?
            const token = await run([
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                "bash",
                "-c",
                "cat ${HOME}/.vscode-oss-devcontainer/token",
            ], { cwd: this.workspaceFolder });

            if (token.exit !== 0 || token.stdout.trim().length !== UUID_TOKEN_LEN) {
                // TODO: reinstall server? force-restart with new token?
                throw new InstallError(`Could not query token in container [stdout:${token.stdout.trim()}] [stderr:${token.stderr.trim()}]`);
            }
            return token.stdout.trim();
        }
        else {
            throw new Error(`Container ${this.getContainerName()} does not exist or is not running: (state: ${JSON.stringify(checkExists?.State)})`);
        }
    }

    private async runCreate(imageName: string, remoteUser: string): Promise<string> {
        const createRes = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getRunCreateCmd(imageName, this.getContainerName(), {
                    extraArgs: [
                        "-p", `${DEVCONTAINER_SERVER_LISTEN_PORT}`,
                    ],
                    remoteUser: remoteUser,
                }),
            ], { cwd: this.workspaceFolder },
        );

        if (createRes.exit !== 0) {
            throw new EngineError(
                `Failed to start ${this.getContainerName()}:\n`
                + `stdout: ${createRes.stdout.trim()}\n`
                + `stderr: ${createRes.stderr.trim()}\n`,
            );
        }
        else {
            getLogSink().info(`Started container ${this.getContainerName()} from image ${imageName}`);
        }

        return createRes.stdout.trim();
    }

    public async getContainerEnv(): Promise<Record<string, string>> {
        const out = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), {}, { tty: true, withRemoteEnv: false }),
                ...this.cc.getUserEnvProbeArgs(),
                "-c",
                "env -0",
            ], { cwd: this.workspaceFolder });

        if (out.exit === 0) {
            const containerEnvs: Record<string, string> = parseEnv(out.stdout);
            return containerEnvs;
        }
        else { throw new EngineError(`Could not run exec to probe container environment :: ${formatCmdErr(out)}`); }
    }

    public getImageHash(name: string) {
        return run(
            [
                ...settings.getEngineCmd(),
                "image",
                "inspect",
                name,
                ...jsonFormat,
            ], { cwd: this.workspaceFolder },
        );
    }

    private async buildUserImage(): Promise<string> {
        if (!this.cc.isDockerfileBased()) { throw new Error("Expected dockerfile-based config"); }

        const ret = await run([
            ...settings.getEngineCmd(),
            ...this.cc.getBuildCmd({ noCache: this.buildOpts === BuildOpts.RebuildNoCache }),
        ], { cwd: this.workspaceFolder });

        if (ret.exit !== 0) {
            throw new EngineError(`Could not build stage1 image :: ${formatCmdErr(ret)}`);
        }
        else {
            // docker and podman output differs, some to stdout, some to stderr
            const output = ret.stdout.trim() + ret.stderr.trim();

            // expect image name to be in the generated name output
            if (!output.includes(this.cc.getStage1ImageName())) {
                throw new InternalError(`Expected image name to be in build tag output. Tag: '${output}' vs ${this.cc.getStage1ImageName()}`);
            }
            return this.cc.getStage1ImageName();
        }
    }

    public engineExec(cmdArgs: string[]) {
        return run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                ...cmdArgs,
            ], { cwd: this.workspaceFolder },
        );
    }

    public async installServer(extensionList: string[] = [], forceReinstall: boolean = false) {
        if (!await this.isRunning()) {
            await this.startContainer();
            if (!await this.isRunning()) {
                throw new Error("Failed to start container. Check logs");
            }
        }

        // TODO: let users customize the URL
        const prodJson = await (async () => {
            const pj = await server.getProductJson();
            pj.serverUrlTemplate = pj.serverUrlTemplate
                .replace("${os}", "${CODIUM_OS_PLATFORM}")
                .replace("${arch}", "${CODIUM_ARCH}");
            return pj;
        })();

        let token: string | undefined;

        try {
            token = await this.getConnectionToken();
        }
        catch {
            getLogSink().warn("Could not query existing token. Perhaps a fresh install? Using a new token");
            forceReinstall = true;
            token = crypto.randomUUID();
        }

        const info: server.ScriptInstallInfo = {
            port: DEVCONTAINER_SERVER_LISTEN_PORT,
            extensions: extensionList,
            downloadTemplateUrl: prodJson.serverUrlTemplate,
            codiumVersion: prodJson.version,
            connectionToken: token,
            forceReinstall: forceReinstall,
        };

        const scriptData = await server.generateInstallScript(info, true);

        const installExecResult = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe, { interactive: true }),
                "bash",
            ],
            {
                cwd: this.workspaceFolder,
                stdin: scriptData,
            },
        );

        if (installExecResult.exit !== 0) {
            const err = getInstallError(installExecResult.stdout.trim());
            throw new InstallError(`Install script to container ${this.getContainerName()} failed with code ${installExecResult.exit}: Error: ${err}`);
        }

        const hostPort = await this.getHostmappedPort();

        return { host: "127.0.0.1", port: Number(hostPort), result: installExecResult };
    }

    private async getHostmappedPort() {
        const portCmdRes = await run([
            ...settings.getEngineCmd(),
            "port",
            this.getContainerName(),
            `${DEVCONTAINER_SERVER_LISTEN_PORT}`,
        ], { cwd: this.workspaceFolder });

        if (portCmdRes.exit !== 0) {
            throw new EngineError(`Failed to query host port :: ${formatCmdErr(portCmdRes)}`);
        }
        else {
            const allParts = portCmdRes.stdout.trim().split(":");
            const port = allParts.at(-1);
            if (port === undefined) {
                throw new InternalError(`Could not extract port from '${portCmdRes.stdout}'.`);
            }
            else {
                return port;
            }
        }
    }

    public async dispose() {
        // TODO: handle shutdown in installServer.sh
    }
}

function getInstallError(data: string) {
    const errMsgMatches = Array.from(data.matchAll(/^INSTALL_SCRIPT_ERROR:(.*)$/gm));
    const errCodeMatches = Array.from(data.matchAll(/^EXITCODE\[\[(.*)\]\]$/gm));

    if (errCodeMatches.length === 0 || errMsgMatches.length === 0) {
        throw new InstallError(`Could not extract error message from\n'${data}'`);
    }
    else {
        // TODO: error matching
        // const errMsg = errMsgMatches[0][1];
        // const errCode = errCodeMatches[0][1];
        // return `${errCode}${errMsg}`;
        return data;
    }
}

function fixDockerImageInspect(engine: ContainerEngine, json: string): ImageInspectResult {
    interface DockerImageInspectResult {
        Config: {
            User: string,
        },
    }

    const data = JSON.parse(json.trim()) as unknown;
    const parsed = data as ImageInspectResult;
    if (engine === ContainerEngine.docker) {
        parsed.User = (data as DockerImageInspectResult).Config.User;
    }
    return parsed;
}

/**
 *
 * @param workspaceFolder
 * @returns `undefined` if container doesn't exist. `true`/`false` if exists
 */
export async function queryContainerConfigId(workspaceFolder: string): Promise<string | undefined> {
    const containerName = ContainerConfig.getContainerName(workspaceFolder);
    const labelKey = `${EXTENSION_ID}.configId`;

    const res = await run([
        ...settings.getEngineCmd(),
        "container", "inspect", containerName,
        "--format", `{{index .Config.Labels "${labelKey}"}}`,
    ], { cwd: workspaceFolder });

    if (res.exit !== 0) { return undefined; }

    const id = res.stdout.trim();
    return id.length > 0 ? id : undefined;
}
