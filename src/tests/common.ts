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

const DEBUG_TESTS = process.env.DEBUG_TESTS;
let cached: string | undefined;

export function getEngine() {
    const runCheck = () => {
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
        info: DEBUG_TESTS !== undefined ? console.log : vi.fn(),
        warn: DEBUG_TESTS !== undefined ? console.log : vi.fn(),
        error: DEBUG_TESTS !== undefined ? console.log : vi.fn(),
    } as any);

    const spySettings = vi.spyOn(workspace, "getConfiguration");
    spySettings.mockReturnValue({
        get: (key: string) => {
            const config: Record<string, string | undefined> = {
                engine: ENGINE,
            };
            return config[key];
        },
    } as any);

    const spyProdsJson = vi.spyOn(server, "getProductJson");
    spyProdsJson.mockResolvedValue(TEST_CODIUM_INFO);

    (vscode as any).env = { remoteAuthority: undefined };

    _initLog("Remote - Devcontainer (tests)");
};

export const init = () => {
    if (!ENGINE) { throw new Error("Expected engine to be defined. Did you forget to skip-if a test?"); }

    initMocks();
};

export function setupFixture(opts: { name: string, testDir: string }) {
    if (!ENGINE) { throw new Error("Expected engine to be defined. Did you forget to skip-if a test?"); }
    const testDir = opts.testDir;

    if (!existsSync(testDir)) {
        throw new Error(`Test directory ${testDir} does not exist`);
    }

    const containerName: string = ContainerConfig.getContainerName(testDir);
    const devcJson = findDevcontainerJson(testDir);
    const config = parseDevcontainerFile(devcJson);

    afterAll(async () => {
        if (DEBUG_TESTS) { console.info(`Stopping and removing container ${containerName}`); }
        const proc1 = await runCmd(ENGINE, ["container", "stop", containerName], testDir, {});
        const proc2 = await runCmd(ENGINE, ["container", "rm", containerName], testDir, {});

        if (proc1.exit !== 0) { console.warn("Warning: Containers were not stopped cleanly. Maybe a bug?"); }
        if (proc2.exit !== 0) { console.warn("Warning: Containers were not removed cleanly. Maybe a bug?"); }

        if (proc1.exit !== 0 || proc2.exit !== 0) { await runCmd(ENGINE, ["container", "rm", "--force", containerName], testDir, {}); }

        const stg1 = ContainerConfig._getStage1ImageName(testDir);
        const stg2 = ContainerConfig._getStage2ImageName(testDir);
        if (DEBUG_TESTS) { console.info(`Removing images [${stg1}, ${stg2}]`); }
        await runCmd(ENGINE, ["image", "rm", stg1, stg2], testDir, {});
    });

    return { localWsf: testDir, localWsfBasename: path.parse(testDir).base, config: config };
}
