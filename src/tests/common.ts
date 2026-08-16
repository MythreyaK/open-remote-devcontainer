import * as vscode from "vscode";
import { window, workspace } from "vscode";
import { afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { runCmd } from "../common/cmd";
import { _initLog } from "../extension/log";
import { findDevcontainerJson } from "../extension/workspace";
import { parseDevcontainerFile } from "../parser/parser";
import { ContainerConfig } from "../engine/container";
import * as server from "../remote/installServer";

const DEBUG_TESTS: boolean = process.env.DEBUG_TESTS !== undefined
  && ["true", "on", "t", "1"].includes(process.env.DEBUG_TESTS.toLowerCase());
let cached: string | undefined;

export function getEngine() {
    if (process.env.SKIP_ENGINE_TESTS) { return undefined; }

    const runCheck = () => {
        const explicit = process.env.CONTAINER_ENGINE;
        if (explicit) {
            const res = spawnSync(explicit, ["version"], { stdio: "pipe", env: process.env });
            if (!res.error) { return explicit; }
            throw new Error(`CONTAINER_ENGINE="${explicit}" is set but not found on PATH`);
        }

        const engines = ["podman", "docker"];
        for (const engine of engines) {
            const res = spawnSync(engine, ["version"], { stdio: "pipe", env: process.env });
            if (!res.error) {
                return engine;
            }
        }
        return undefined;
    };

    if (!cached) { cached = runCheck(); }

    return cached;
}

export const ENGINE = getEngine();
export const jsonFormat = ["--format", "{{json .}}"];

export const TEST_CODIUM_INFO: server.ServerInfo = {
    version: "1.121.03429",
    commit: "824c4c46a288b839f13b24022655329c2aeb9f81",
    serverUrlTemplate: "https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-${os}-${arch}-1.121.03429.tar.gz",
};

export const initMocks = () => {
    const spyCreateOutput = vi.spyOn(window, "createOutputChannel");
    spyCreateOutput.mockReturnValue({
        info: DEBUG_TESTS ? console.log : vi.fn(),
        warn: DEBUG_TESTS ? console.log : vi.fn(),
        error: DEBUG_TESTS ? console.log : vi.fn(),
    } as any);

    const spySettings = vi.spyOn(workspace, "getConfiguration");
    spySettings.mockReturnValue({
        get: (key: string) => {
            const config: Record<string, string | undefined> = {
                dockerPath: ENGINE,
            };
            return config[key];
        },
    } as any);

    const spyProdsJson = vi.spyOn(server, "getProductJson");
    spyProdsJson.mockResolvedValue(TEST_CODIUM_INFO);

    (vscode as any).env = { remoteAuthority: undefined };

    _initLog("Remote - Devcontainer (tests)");
};

export function init() {
    if (!ENGINE) { throw new Error("No container engine (docker/podman) found. Cannot run integration tests."); }
    initMocks();
}

export function setupFixture(opts: { name: string, testDir: string }) {
    if (!ENGINE) {
        // called not from inside a test() but at describe-scope level, so can't throw
        // it'll be resolved correctly during actual runs
        // TODO: may be able to clean this up
        return { localWsf: opts.testDir, localWsfBasename: path.parse(opts.testDir).base, config: undefined as any };
    }
    const testDir = opts.testDir;

    if (!existsSync(testDir)) {
        throw new Error(`Test directory ${testDir} does not exist`);
    }

    const containerName: string = ContainerConfig.getContainerName(testDir);
    const devcJson = findDevcontainerJson(testDir);
    const config = parseDevcontainerFile(devcJson);

    afterAll(async () => {
        if (DEBUG_TESTS) { console.info(`Stopping and removing container ${containerName}`); }
        const proc1 = await runCmd(ENGINE, ["container", "stop", containerName], { cwd: testDir });
        const proc2 = await runCmd(ENGINE, ["container", "rm", containerName], { cwd: testDir });

        if (proc1.exit !== 0) { console.warn("Warning: Containers were not stopped cleanly. Maybe a bug?"); }
        if (proc2.exit !== 0) { console.warn("Warning: Containers were not removed cleanly. Maybe a bug?"); }

        if (proc1.exit !== 0 || proc2.exit !== 0) { await runCmd(ENGINE, ["container", "rm", "--force", containerName], { cwd: testDir }); }

        const stg1 = ContainerConfig._getStage1ImageName(testDir);
        const stg2 = ContainerConfig._getStage2ImageName(testDir);
        if (DEBUG_TESTS) { console.info(`Removing images [${stg1}, ${stg2}]`); }
        await runCmd(ENGINE, ["image", "rm", stg1, stg2], { cwd: testDir });
    });

    return { localWsf: testDir, localWsfBasename: path.parse(testDir).base, config: config };
}
