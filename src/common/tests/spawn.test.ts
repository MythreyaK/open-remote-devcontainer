import { window, workspace } from "vscode";
import { describe, expect, test, vi } from "vitest";

import { spawn } from "../spawn";
import { ContainerInspectResult } from "../../engine/lifecycle";

function getEngine() {
    return "podman";
}

function getcwd() {
    return __dirname;
}

const jsonFormat = ["--format", "{{json .}}"];
const bashSleepCmd = ["bash", "-c", "trap 'exit 0' SIGINT SIGTERM; while true; do sleep 1; done"];

describe("cmd spawn tests", () => {
    const spy = vi.spyOn(window, "createOutputChannel");
    spy.mockReturnValue({
        info: vi.fn(), // console.log,
        warn: vi.fn(), // console.log,
        error: vi.fn(), // console.log,
    } as any);

    const log = window.createOutputChannel("Remote - Devcontainer (test)", { log: true });

    test("get engine version", async () => {
        const out = await spawn(getEngine(), ["version", ...jsonFormat], getcwd(), {}, log);
        // console.log(out);
        expect(out.exit).eq(0);
    });

    test("create and remove container", async () => {
        const create = await spawn(getEngine(), ["create", "hello-world"], getcwd(), {}, log);
        // console.log(create);

        const remove = await spawn(getEngine(), ["rm", create.stdout.trim()], getcwd(), {}, log);
        expect(create.exit).eq(0);
        expect(remove.exit).eq(0);
    });

    test("run and exec command", async () => {
        const create = await spawn(getEngine(), ["run", "--name", "turtles", "-d", "ubuntu:24.04", ...bashSleepCmd], getcwd(), {}, log);
        const containerId = create.stdout.trim();

        try {
            const exec = await spawn(getEngine(), ["exec", create.stdout.trim(), "cat", "/etc/os-release"], getcwd(), {}, log);
            expect(exec.stdout.trim().includes("Ubuntu 24.04")).toBe(true);
            expect(exec.exit).eq(0);

            const inspect = await spawn(getEngine(), ["inspect", containerId, ...jsonFormat], getcwd(), {}, log);
            expect(inspect.exit).eq(0);
            // console.log("DATA: ", inspect.stdout.trim());

            const inspectData = JSON.parse(inspect.stdout.trim()) as ContainerInspectResult;
            expect(inspectData.Id).eq(containerId);
            expect(inspectData.Name).eq("turtles");
            expect(inspectData.State.Running).eq(true);
        }
        finally {
            const stop = await spawn(getEngine(), ["stop", "turtles"], getcwd(), {}, log);
            expect(stop.exit).eq(0);

            const rm = await spawn(getEngine(), ["rm", "turtles"], getcwd(), {}, log);
            expect(rm.exit).eq(0);
        }
    });
});
