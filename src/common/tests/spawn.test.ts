import { describe, expect, test } from "vitest";

import { run } from "../cmd";
import { getLogSink } from "../../extension/log";
import { ContainerInspectResult } from "../../engine/lifecycle";

import { initMocks, jsonFormat, getMockSettings, getTestTimeout } from "../../tests/common";

const bashSleepCmd = ["bash", "-c", "trap 'exit 0' SIGINT SIGTERM; while true; do sleep 1; done"];

const SETTINGS = getMockSettings();
initMocks();

describe.skipIf(!SETTINGS.dockerPath)("cmd spawn tests", () => {
    const engine = SETTINGS.dockerPath;

    test("log is initialized", () => {
        expect(getLogSink()).toBeDefined();
    });

    test("env buildkit", async () => {
        const out = await run(["env"], {});
        expect(out.stdout).contains("BUILDKIT_PROGRESS=plain");
        expect(out.exit).eq(0);
    });

    test("stdin/stdout sanity", async () => {
        const out = await run(["cat"], { stdin: "HELLO\nWORLD" });
        expect(out.stdout).eq("HELLO\nWORLD");
        expect(out.exit).eq(0);
    });

    test("get engine version", async () => {
        const out = await run([engine, "version", ...jsonFormat], {});
        expect(out.exit).eq(0);
    });

    test("create and remove container", async () => {
        const create = await run([engine, "create", "hello-world"], {});

        const remove = await run([engine, "rm", create.stdout.trim()], {});
        expect(create.exit).eq(0);
        expect(remove.exit).eq(0);
    }, getTestTimeout(10));

    test("run and exec command", async () => {
        const create = await run([engine, "run", "--name", "turtles", "-d", "ubuntu:24.04", ...bashSleepCmd], {});
        const containerId = create.stdout.trim();

        try {
            const exec = await run([engine, "exec", create.stdout.trim(), "cat", "/etc/os-release"], {});
            expect(exec.stdout.trim()).toContain("Ubuntu 24.04");
            expect(exec.exit).eq(0);

            const inspect = await run([engine, "inspect", containerId, ...jsonFormat], {});
            expect(inspect.exit).eq(0);

            const inspectData = JSON.parse(inspect.stdout.trim()) as ContainerInspectResult;
            expect(inspectData.Id).eq(containerId);
            expect(inspectData.Name).matches(/\/?turtles/);
            expect(inspectData.State.Running).eq(true);
        }
        finally {
            const stop = await run([engine, "stop", "turtles"], {});
            expect(stop.exit).eq(0);

            const rm = await run([engine, "rm", "turtles"], {});
            expect(rm.exit).eq(0);
        }
    }, getTestTimeout(30));
});
