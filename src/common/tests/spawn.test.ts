import { window } from "vscode";
import { describe, expect, test, vi } from "vitest";

import { spawn } from "../spawn";
import { getLogSink } from "../../extension/log";
import { ContainerInspectResult } from "../../engine/lifecycle";

import { jsonFormat, initMocks, ENGINE } from "../../tests/common";

function getcwd() {
    return __dirname;
}

const bashSleepCmd = ["bash", "-c", "trap 'exit 0' SIGINT SIGTERM; while true; do sleep 1; done"];

initMocks();

describe.skipIf(!ENGINE)("cmd spawn tests", () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const engine = ENGINE!;

    const log = getLogSink();

    test("get engine version", async () => {
        const out = await spawn(engine, ["version", ...jsonFormat], getcwd(), {}, log);
        expect(out.exit).eq(0);
    });

    test("create and remove container", async () => {
        const create = await spawn(engine, ["create", "hello-world"], getcwd(), {}, log);

        const remove = await spawn(engine, ["rm", create.stdout.trim()], getcwd(), {}, log);
        expect(create.exit).eq(0);
        expect(remove.exit).eq(0);
    });

    test("run and exec command", async () => {
        const create = await spawn(engine, ["run", "--name", "turtles", "-d", "ubuntu:24.04", ...bashSleepCmd], getcwd(), {}, log);
        const containerId = create.stdout.trim();

        try {
            const exec = await spawn(engine, ["exec", create.stdout.trim(), "cat", "/etc/os-release"], getcwd(), {}, log);
            expect(exec.stdout.trim().includes("Ubuntu 24.04")).toBe(true);
            expect(exec.exit).eq(0);

            const inspect = await spawn(engine, ["inspect", containerId, ...jsonFormat], getcwd(), {}, log);
            expect(inspect.exit).eq(0);

            const inspectData = JSON.parse(inspect.stdout.trim()) as ContainerInspectResult;
            expect(inspectData.Id).eq(containerId);
            expect(inspectData.Name).eq("turtles");
            expect(inspectData.State.Running).eq(true);
        }
        finally {
            const stop = await spawn(engine, ["stop", "turtles"], getcwd(), {}, log);
            expect(stop.exit).eq(0);

            const rm = await spawn(engine, ["rm", "turtles"], getcwd(), {}, log);
            expect(rm.exit).eq(0);
        }
    });
});
