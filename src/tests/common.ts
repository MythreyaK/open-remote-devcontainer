import * as vscode from "vscode";
import { window } from "vscode";
import { afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { run } from "../common/cmd";
import { _initLog } from "../extension/log";
import { findDevcontainerJson } from "../extension/workspace";
import { parseDevcontainer } from "../parser/parser";
import { ContainerConfig } from "../engine/container";
import { Config } from "../parser/schema";
import { Settings } from "../extension/settings";
import * as utils from "../common/utils";

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

export const jsonFormat = ["--format", "{{json .}}"];

export const TEST_CODIUM_INFO: utils.ProductJson = {
    applicationName: "codium",
    dataFolderName: ".vscode-oss",
    serverDataFolderName: ".vscode-oss",
    sharedDataFolderName: ".vscode-oss-shared",
    version: "1.121.03429",
    commit: "824c4c46a288b839f13b24022655329c2aeb9f81",
    serverDownloadUrlTemplate: "https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-${os}-${arch}-1.121.03429.tar.gz",
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
export function initMocks() {
    // const engine = getEngine();
    const spyCreateOutput = vi.spyOn(window, "createOutputChannel");
    spyCreateOutput.mockReturnValue({
        debug: DEBUG_TESTS ? console.log : vi.fn(),
        trace: DEBUG_TESTS ? console.log : vi.fn(),
        info: DEBUG_TESTS ? console.log : vi.fn(),
        warn: DEBUG_TESTS ? console.log : vi.fn(),
        error: DEBUG_TESTS ? console.log : vi.fn(),
    } as any);

    // const config: Record<string, string | string[] | undefined> = {
    //     "dev.containers.dockerPath": engine,
    //     "dev.containers.extraArgs": [],
    //     "dev.containers.defaultExtensions": [],
    // };

    // const spySettings = vi.spyOn(workspace, "getConfiguration");
    // spySettings.mockImplementation((section?: string) => ({
    //     get: (key: string) => config[section ? `${section}.${key}` : key],
    //     has: (key: string) => (section ? `${section}.${key}` : key) in config,
    //     inspect: () => undefined,
    //     update: vi.fn(),
    // }));

    const spyProdsJson = vi.spyOn(utils, "getProductJson");
    spyProdsJson.mockResolvedValue(TEST_CODIUM_INFO);

    (vscode as any).env = { remoteAuthority: undefined };

    _initLog("Remote - Devcontainer (tests)");
};

export function getMockSettings(): Settings {
    return {
        dockerPath: getEngine() ?? "",
        extraArgs: [],
        defaultExtensions: [],
    };
}

export async function setupFixture(opts: { name: string, testDir: string }): Promise<{ localWsf: string, localWsfBasename: string, config: Config }> {
    const engine = getEngine();
    if (!engine) {
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
    const devcJson = await findDevcontainerJson(vscode.Uri.file(testDir));
    const config = await parseDevcontainer(devcJson);

    afterAll(async () => {
        if (DEBUG_TESTS) { console.info(`Stopping and removing container ${containerName}`); }
        const proc1 = await run([engine, "container", "stop", containerName], { cwd: testDir });
        const proc2 = await run([engine, "container", "rm", containerName], { cwd: testDir });

        if (proc1.exit !== 0) { console.warn("Warning: Containers were not stopped cleanly. Maybe a bug?"); }
        if (proc2.exit !== 0) { console.warn("Warning: Containers were not removed cleanly. Maybe a bug?"); }

        if (proc1.exit !== 0 || proc2.exit !== 0) { await run([engine, "container", "rm", "--force", containerName], { cwd: testDir }); }

        const stg1 = ContainerConfig._getStage1ImageName(testDir);
        const stg2 = ContainerConfig._getStage2ImageName(testDir);
        if (DEBUG_TESTS) { console.info(`Removing images [${stg1}, ${stg2}]`); }
        await run([engine, "image", "rm", stg1, stg2], { cwd: testDir });
    });

    return { localWsf: testDir, localWsfBasename: path.parse(testDir).base, config: config };
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
