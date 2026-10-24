/**
 * Basic script that launchs the codium server and ensures
 * that it is running. Once the server exits after an idle
 * timeout, this process gets notified via wait, and sends
 * SIGINT or SIGTERM to pid 1, so that the container this
 * is in can stop, based on `shutdownAction`.
 *
 * For this to work, both this script and PID 1 must be
 * started as the same user (usually `remoteUser`)
 */

import { exit, kill } from "node:process";
import { setTimeout } from "node:timers/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { ChildProcess, spawn, execSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

const CliOptsDefn: ParseArgsOptionsConfig = {
    daemon: { type: "boolean", short: "d" },
    config: { type: "string", short: "c" },
};

export interface ServerLaunchConfig {
    host: string,
    port: string,
    serverDir: string,
    serverCommit: string,
    extensions: string[],
    connectionToken: string,
    shutdownAction: "none" | "stopContainer",
};

export const MAX_RETRY = 3;
export const DAEMON_NAME = "codium-daemon-monitor";

export async function main(opts: { daemon: boolean, config: ServerLaunchConfig }) {
    if (opts.daemon) {
        await spawnServerDaemon(opts.config);
        return;
    }
    else {
        // check if server is already running only in the parent proc
        const alreadyRunning = await checkServerRunning(opts.config);
        if (alreadyRunning === true) {
            exit(0);
        }
        else {
            // server not healthy. kill old daemon and wait for it to release unlock the lockfile
            console.log(`INSTALL_SCRIPT_INFO: [PID${process.pid}]: Server is oopsie? Killing old procs ...`);
            if (!killStaleProcs(opts.config)) {
                console.error("INSTALL_SCRIPT_ERROR: killStaleProcs failed to clean up all stale processes");
            }
        }

        // "fork", parent exits after status check
        // play heavy metal, demonize the child process
        // in the "fork"-ed child, spawn codium-server
        // new parent waits on the new grandchild. When codium exits, send SIGINT to pid 1
        await parentProc(opts.config);
        return;
    }
}

async function parentProc(config: ServerLaunchConfig) {
    // parent process, spawn the child
    const child = spawn(process.execPath, [
        ...process.execArgv,
        process.argv[1],
        "--daemon",
        ...process.argv.slice(2),
        // config is in argv slice
    ], {
        argv0: DAEMON_NAME,
        stdio: "ignore",
        detached: true,
    });

    console.log(`INSTALL_SCRIPT_INFO: [PID${process.pid}]: Spawning daemon-child ...`);
    const pid = await new Promise<number>((resolve, reject) => {
        child.on("spawn", () => {
            if (child.pid) {
                resolve(child.pid); return;
            }
            else {
                reject(new Error("Child.pid was undefined")); return;
            }
        });
        child.on("error", (err: Error) => {
            console.error(`INSTALL_SCRIPT_ERROR: [PID${process.pid}]: ${fmtErr(err)}`);
            reject(err);
        });
    });

    console.log(`INSTALL_SCRIPT_INFO: [PID${process.pid}] Spawned daemon-child with PID ${pid}`);

    // wait for HTTP check
    const serverHash = await (async () => {
        // yar extension(s) so fat ... 30 seconds
        for (let i = 0; i < 15; ++i) {
            await setTimeout(2000);
            try {
                return await fetchServerHash(config.host, config.port);
            }
            catch (e: unknown) {
                console.warn(`INSTALL_SCRIPT_WARN: [PID${process.pid}] Connect attempt ${i} failed: ${e instanceof Error ? e.message : fmtErr(e)}`);
            }
        }

        return undefined;
    })();

    if (!serverHash) {
        console.error(`INSTALL_SCRIPT_ERROR: [PID${process.pid}] server health-check failed, killing PID ${pid}`);
        try {
            tryKill(-pid, "SIGINT");
            await setTimeout(500);
            if (tryKill(-pid, 0) && tryKill(-pid, "SIGKILL")) {}
        }
        catch (e: unknown) {
            console.warn(`INSTALL_SCRIPT_WARN: [PID${process.pid}]: process ${DAEMON_NAME} ${pid} gone (Err: ${fmtErr(e)})`);
        }
        exit(-1);
    }
    else {
        console.log(`INSTALL_SCRIPT_INFO: [PID${process.pid}]: SERVER_HASH[[${serverHash}]]`);
        exit(0);
    }
}

async function spawnServerDaemon(config: ServerLaunchConfig) {
    const paths = getPaths(config);
    const logFd = openSync(paths.logFile, "a");

    // lock the daemon ... lockfile, as long as we're alive
    // when this daemon dies, hodlLock dies and releases the deamon lockfile
    const lockFile = `${config.serverDir}/daemon.lock`;
    const hodlLock = spawn("flock", [lockFile, "cat"], {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
    });

    process.on("exit", () => {
        writeSync(logFd, `${DAEMON_NAME} cleaning up and exiting\n`);
        try { hodlLock.kill("SIGKILL"); }
        catch {}
        closeSync(logFd);
    });

    // child process, spawn the server, and in the parent, wait for the server to exit
    const serverMonitor = new ServerManager(config, logFd);

    let signalled = false;
    process.on("SIGINT", () => {
        signalled = true;
        writeSync(logFd, `${DAEMON_NAME}:[PID${process.pid}]: Got SIGINT, sending SIGINT to server. Will wait 2 sec before SIGKILL...\n`);
        serverMonitor.dispose().catch((e: unknown) => {
            writeSync(logFd, `${DAEMON_NAME}:[PID${process.pid}]: Failed to dispose server: ${JSON.stringify(e)}\n`);
        });
        exit(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    for (let i = 0; i < MAX_RETRY && !signalled; ++i) {
        const status = await serverMonitor.tryStartServer();

        if (status.code === 0) {
            // server exit ok, meaning it ran fine and is exiting after timeout, send SIGINT to pid 1
            await serverMonitor.dispose();

            if (config.shutdownAction === "stopContainer") {
                // kill(1, "SIGINT"); // goodbye cruel world
                // TODO: not yet, apparently
                // ensure we don't have bugs that kills the container before enabling this
                // TODO: check for interactive sessions before sending SIGINT to PID 1
                // ll -A /dev/pts/ | grep -v ptmx should show interactive sessions
                // add a 'stopContainerNonInteractive' or should it be the default?
            }

            exit(0);
        }
        else {
            serverMonitor.error(`INSTALL_SCRIPT_ERROR: [PID${process.pid}] Failed to start server: Exit code / signal: ${status.code} / ${status.signal}`);
            serverMonitor.info(`INSTALL_SCRIPT_INFO: [PID${process.pid}] Attempt ${i + 1} of ${MAX_RETRY} ...`);
            await serverMonitor.dispose();
        }
    }

    // retry failed
    // TODO: add this once we're sure it's working correctly
    // if (config.shutdownAction === "stopContainer") {
    //     kill(1, "SIGINT");
    // }

    exit(-1);
}

interface ExitStatus {
    code: number | null,
    signal: NodeJS.Signals | null,
};

class ServerManager {
    private readonly cfg: ServerLaunchConfig;
    private readonly logfd: number;
    private proc: ChildProcess | undefined;

    constructor(cfg: ServerLaunchConfig, logFd: number) {
        this.cfg = cfg;
        this.logfd = logFd;
    }

    public info(...msg: string[]) {
        writeSync(this.logfd, `INFO[PID${process.pid}]: ${msg.join(", ")}\n`);
    }

    public warn(...msg: string[]) {
        writeSync(this.logfd, `WARN[PID${process.pid}]: ${msg.join(", ")}\n`);
    }

    public error(...msg: string[]) {
        writeSync(this.logfd, `ERROR[PID${process.pid}]: ${msg.join(", ")}\n`);
    }

    public async tryStartServer(): Promise<ExitStatus> {
        const extensArgs = this.cfg.extensions
            .flatMap(e => ["--install-extension", e]);

        const paths = getPaths(this.cfg);
        const tokenFile = paths.tokenFile;
        writeFileSync(tokenFile, this.cfg.connectionToken, { mode: 0o600 });

        // spawn codium server
        const serverCmd: string[] = [
            `${this.cfg.serverDir}/bin/${this.cfg.serverCommit}/bin/codium-server`,
            "--start-server",
            "--host", this.cfg.host,
            "--port", this.cfg.port,
            "--server-data-dir", this.cfg.serverDir,
            "--connection-token-file", tokenFile,
            "--enable-remote-auto-shutdown",
            "--accept-server-license-terms",
            "--telemetry-level", "off",
            ...(extensArgs),
        ];

        this.info("------------ Starting server ------------");

        const codiumServer = spawn(serverCmd[0], serverCmd.slice(1), {
            stdio: ["ignore", this.logfd, this.logfd],
            detached: true,
        });

        await new Promise<number>((resolve, reject) => {
            codiumServer.on("spawn", () => {
                const pid = codiumServer.pid;
                if (pid) { resolve(pid); }
                else { reject(new Error("Could not fetch PID on spawn")); }
            });
        });

        this.proc = codiumServer;

        const status = await new Promise<ExitStatus>((resolve, _) => {
            codiumServer.on("exit", (exitCode: number | null, sig: NodeJS.Signals | null) => {
                tryUnlinkSync(paths.tokenFile);
                if (exitCode === 0) {
                    this.info(`[PID${process.pid}]: codium server exited with code ${exitCode} / signal ${sig}`);
                    resolve({ code: exitCode, signal: null }); return;
                }
                else {
                    this.error(`[PID${process.pid}]: codium server exited with code ${exitCode} / signal ${sig}`);
                    resolve({ code: exitCode, signal: sig }); return;
                }
            });
        });

        this.info(`[PID${process.pid}]: Server exit: ${fmtErr(status)}`);

        return status;
    }

    public async killServer() {
        if (!this.proc || !this.proc.pid) { return; }
        const proc = this.proc;
        const pid = proc.pid;

        if (!pid) { return true; }

        if (pid && tryKill(pid, 0) && tryKill(pid, "SIGINT")) {
            await setTimeout(1000);
            if (tryKill(pid, 0)) {
                await setTimeout(2500);
                tryKill(pid, "SIGKILL"); // BFG moment
            }
        }

        return true;
    }

    public async dispose() {
        await this.killServer();
    }
}

if ("MAIN" in process.env) {
    const args = (() => {
        const parsed = (() => {
            return parseArgs({
                args: process.argv.slice(2), // [ node, script, ...args ]
                options: CliOptsDefn,
            }).values;
        })();

        const env = process.env;

        if (!env.HOME) {
            throw new Error("HOME env var not set!");
        }

        const config = parsed.config as string;

        if (!config) {
            throw new Error("config flag not set!");
        }

        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const ret = JSON.parse(Buffer.from(config, "hex").toString("utf-8"));
        if (ret.shutdownAction !== "stopContainer" && ret.shutdownAction !== "none") {
            throw new Error(`Invalid shutdownAction: '${ret.shutdownAction}'`);
        }
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

        return { daemon: parsed.daemon ?? false, config: ret as ServerLaunchConfig };
    })();

    // @ts-expect-error ts(1309): runs as ESM at runtime
    await main(args);
}

// utils

async function fetchServerHash(host: string, port: string): Promise<string> {
    const req = await fetch(`http://${host}:${port}/version`);
    if (req.status === 200) {
        return (await req.text()).trim();
    }
    else {
        throw new Error(`fetch failed: code ${req.status}`);
    }
}

async function checkServerRunning(config: ServerLaunchConfig): Promise<boolean | undefined> {
    try {
        const hash = await fetchServerHash(config.host, config.port);
        if (hash === config.serverCommit) {
            console.log(`INSTALL_SCRIPT_INFO: [PID:${process.pid}] Server already running ...`);

            try {
                if (!daemonAlive(config)) {
                    console.log(`INSTALL_SCRIPT_WARN: [PID:${process.pid}] Server running without a daemon`);
                    // daemon slain, but daemon-spawn exists ... better call doomguy
                    return undefined;
                }

                // daemon exists, see if we can reuse the token
                const token = readFileSync(getPaths(config).tokenFile, { encoding: "utf-8" }).trim();

                if (token.length !== 36) {
                    console.log(`INSTALL_SCRIPT_ERROR: [PID:${process.pid}] Bad token [[token:${token}]] length, attempting to clean and restart server`);
                    return undefined;
                }

                // we know it's the same token because the lock ordering means manual tampering is the only way
                // a token file can change after the server starts with a token file
                console.log(`INSTALL_SCRIPT_INFO: [PID:${process.pid}] Server already running with [[token:${token}]]`);
                return true;
            }
            catch (e: unknown) {
                console.log(`INSTALL_SCRIPT_WARN: [PID:${process.pid}] Error in attempting to detect server state: ${fmtErr(e)}`);
                return undefined;
            }
        }

        // curl works, but not same hash? clean and restart just to be sure
        return undefined;
    }
    catch (e: unknown) {
        console.warn(`INSTALL_SCRIPT_WARN: Maybe server isn't running (Err: ${fmtErr(e)})? Starting server ...`);
        return false;
    }
}

function killStaleProcs(config: ServerLaunchConfig) {
    const lockFile = `${config.serverDir}/daemon.lock`;

    const sigAndWait = (signal: NodeJS.Signals | number) => {
        execSync(`pgrep -f -- '${DAEMON_NAME}.*--d[a]emon' | xargs -I{} kill -${signal} -- -{} || true`);

        // because codium shell wrapper doesn't propagate signal to the node / codium server
        execSync(`pgrep -f -- '--[h]ost ${config.host} --port ${config.port}' | xargs -I{} kill -${signal} -- -{} || true`);

        try {
            execSync(`timeout 10 flock "${lockFile}" -c true`, { timeout: 15000 });
            return true;
        }
        catch (e: unknown) {
            console.warn(`INSTALL_SCRIPT_WARN: [PID${process.pid}]: Old daemon did not exit in 10s (${fmtErr(e)}) with sig ${signal}`);
            return false;
        }
    };

    if (!sigAndWait("SIGINT")) {
        sigAndWait("SIGKILL"); // rip and tear
    }

    try {
        execSync(`timeout 2 flock "${lockFile}" -c true`, { timeout: 5000 });
        return true;
    }
    catch (e: unknown) {
        console.warn(`INSTALL_SCRIPT_ERROR: daemon.lock isn't free to lock after attempting to clean up stale processes ${fmtErr(e)}. This is probably a bug.`);
        return false;
    }
}

// daemon.lock is held by the daemon's hodlLock for its entire lifetime
// we get deamon lock = other daemons be dead
function daemonAlive(config: ServerLaunchConfig): boolean {
    try {
        execSync(`flock -n "${config.serverDir}/daemon.lock" -c true`);
        return false;
    }
    catch {
        return true;
    }
}

function getPaths(config: ServerLaunchConfig) {
    return {
        logFile: `${config.serverDir}/${config.serverCommit}.log`,
        tokenFile: `${config.serverDir}/${config.serverCommit}.token`,
    };
}

function tryUnlinkSync(path: string) {
    try { unlinkSync(path); }
    catch (_: unknown) { void (_); }
}

function tryKill(pid: number, sig: number | NodeJS.Signals) {
    try {
        kill(pid, sig);
        return true;
    }
    catch (_: unknown) {
        void (_);
        return false;
    }
};

function fmtErr(e: unknown): string {
    if (e instanceof Error) {
        return e.stack ?? e.message;
    }
    else {
        return `unknown error: ${JSON.stringify(e)}`;
    }
}
