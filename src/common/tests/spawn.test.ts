import { describe, expect, test } from "vitest";

import { spawn } from "../spawn";
import { getLogSink } from "../../extension/log";
import { ContainerInspectResult } from "../../engine/lifecycle";

import { initMocks, jsonFormat, getMockSettings } from "../../tests/common";

function getcwd() {
    return __dirname;
}

function opts() {
    return { cwd: getcwd(), env: {}, log: getLogSink() };
}

const bashSleepCmd = ["bash", "-c", "trap 'exit 0' SIGINT SIGTERM; while true; do sleep 1; done"];

const SETTINGS = getMockSettings();
initMocks();

describe.skipIf(!SETTINGS.dockerPath)("cmd spawn tests", () => {
    const engine = SETTINGS.dockerPath;

    test("log is initialized", () => {
        expect(getLogSink()).toBeDefined();
    });

    test("env buildkit", async () => {
        const out = await spawn("env", [], opts());
        expect(out.stdout).contains("BUILDKIT_PROGRESS=plain");
        expect(out.exit).eq(0);
    });

    test("get engine version", async () => {
        const out = await spawn(engine, ["version", ...jsonFormat], opts());
        expect(out.exit).eq(0);
    });

    test("create and remove container", async () => {
        const create = await spawn(engine, ["create", "hello-world"], opts());

        const remove = await spawn(engine, ["rm", create.stdout.trim()], opts());
        expect(create.exit).eq(0);
        expect(remove.exit).eq(0);
    }, 10_000);

    test("run and exec command", async () => {
        const create = await spawn(engine, ["run", "--name", "turtles", "-d", "ubuntu:24.04", ...bashSleepCmd], opts());
        const containerId = create.stdout.trim();

        try {
            const exec = await spawn(engine, ["exec", create.stdout.trim(), "cat", "/etc/os-release"], opts());
            expect(exec.stdout.trim()).toContain("Ubuntu 24.04");
            expect(exec.exit).eq(0);

            const inspect = await spawn(engine, ["inspect", containerId, ...jsonFormat], opts());
            expect(inspect.exit).eq(0);

            const inspectData = JSON.parse(inspect.stdout.trim()) as ContainerInspectResult;
            expect(inspectData.Id).eq(containerId);
            expect(inspectData.Name).matches(/\/?turtles/);
            expect(inspectData.State.Running).eq(true);
        }
        finally {
            const stop = await spawn(engine, ["stop", "turtles"], opts());
            expect(stop.exit).eq(0);

            const rm = await spawn(engine, ["rm", "turtles"], opts());
            expect(rm.exit).eq(0);
        }
    }, 30_000);
});
