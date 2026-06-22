import { window, workspace } from "vscode";
import { afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { runCmd } from "../common/cmd";
import { initLog } from "../extension/log";
import { ContainerState } from "../engine/lifecycle";
import { findDevcontainerJson } from "../extension/workspace";
import { parseDevcontainerFile } from "../parser/parser";
import * as server from "../remote/installServer";

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

export const init = () => {
    const spyCreateOutput = vi.spyOn(window, "createOutputChannel");
    spyCreateOutput.mockReturnValue({
        // info: console.log,
        // warn: console.log,
        // error: console.log,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
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

    initLog("Remote - Devcontainer (tests)");
};

export function setupFixture(opts: { name: string, testDir: string }) {
    const testDir = opts.testDir;

    if (!existsSync(testDir)) {
        throw new Error(`Test directory ${testDir} does not exist`);
    }

    const containerName: string = ContainerState.getContainerName(testDir);
    const devcJson = findDevcontainerJson(testDir);
    const config = parseDevcontainerFile(devcJson);

    afterAll(async () => {
        console.log(`Stopping and removing container ${containerName}`);
        const proc1 = await runCmd(ENGINE!, ["container", "stop", containerName], testDir, {});
        const proc2 = await runCmd(ENGINE!, ["container", "rm", containerName], testDir, {});

        if (proc1.exit !== 0) { console.log("Warning: Containers were not stopped cleanly. Maybe a bug?"); }
        if (proc2.exit !== 0) { console.log("Warning: Containers were not removed cleanly. Maybe a bug?"); }

        if (proc1.exit !== 0 || proc2.exit !== 0) { await runCmd(ENGINE!, ["container", "rm", "--force", containerName], testDir, {}); }
    });

    return { localWsf: testDir, localWsfBasename: path.parse(testDir).base, config: config };
}
