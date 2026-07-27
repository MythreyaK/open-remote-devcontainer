import path from "node:path";
import { describe, expect, test } from "vitest";

import * as schema from "../../parser/schema";
import { ContainerConfig, interpolateVars, interpolateLocal, interpolateContainer } from "../container";

import { sanityCheck, withDefaults } from "./common";
import { initMocks } from "../../tests/common";

initMocks();

describe("config interpolation", () => {
    const localWsf = "/tmp/dir";
    const localWsfBase = path.parse(localWsf).base;
    const remoteWsf = "/workspaces/dir";
    const remoteWsfBase = path.parse("/workspaces/dir").base;
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    test("local workspace dir (sanity check)", () => {
        sanityCheck(localWsf, cfgPath);
    });

    describe("runArgs ordering", () => {
        test("internal extraArgs appear before user runArgs", () => {
            const cfg = withDefaults({
                image: "ubuntu:24.04",
                runArgs: ["--userns=auto"],
            });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            const args = cc.getRunCreateCmd(cfg.image, "foobar", { extraArgs: ["--userns=keep-id"] });
            const keepIdIdx = args.indexOf("--userns=keep-id");
            const autoIdx = args.indexOf("--userns=auto");
            expect(keepIdIdx).toBeGreaterThan(-1);
            expect(autoIdx).toBeGreaterThan(-1);
            expect(keepIdIdx).toBeLessThan(autoIdx);
        });

        test("user runArgs can override extraArgs (last one wins)", () => {
            const cfg = withDefaults({
                image: "ubuntu:24.04",
                runArgs: ["--userns=auto"],
            });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            const args = cc.getRunCreateCmd(cfg.image, "foobar", { extraArgs: ["--userns=keep-id"] });
            const allUserns = args.filter(a => a.startsWith("--userns="));
            expect(allUserns).toEqual(["--userns=keep-id", "--userns=auto"]);
        });
    });

    test("variable interpolation", () => {
        {
            const localWsf = "/home/user/Projects/codium";
            const remoteWsf = "/workspace/projects/codium";

            const tests = [
                { test: "PATH:${localWorkspaceFolder}", result: `PATH:${localWsf}` },
                { test: "DIR=${containerWorkspaceFolder}", result: `DIR=${remoteWsf}` },
                { test: "LOCAL_DIRNAME=${localWorkspaceFolderBasename}", result: "LOCAL_DIRNAME=codium" },
                { test: "REMOTE_DIRNAME=${containerWorkspaceFolderBasename}", result: "REMOTE_DIRNAME=codium" },
            ];

            for (const test of tests) {
                expect(interpolateVars(test.test, localWsf, remoteWsf)).eq(test.result);
            }
        }
    });

    describe("containerEnv interpolation", () => {
        test("localEnv and workspace vars are resolved", () => {
            const env = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
            const cfg = withDefaults({
                image: "ubuntu:24.04",
                containerEnv: {
                    PLAIN: "literal",
                    WITH_LOCAL_ENV: "${localEnv:HOME}/bin",
                    WITH_WSF: "${localWorkspaceFolder}",
                    WITH_REMOTE: "${containerWorkspaceFolder}",
                    COMBINED: "${localEnv:HOME}:${localWorkspaceFolder}",
                    WITH_DEFAULT: "${localEnv:MISSING:/fallback}",
                },
            });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, env);
            const resolved = cc.getResolvedContainerEnv();

            expect(resolved["PLAIN"]).toBe("literal");
            expect(resolved["WITH_LOCAL_ENV"]).toBe("/home/dev/bin");
            expect(resolved["WITH_WSF"]).toBe(localWsf);
            expect(resolved["WITH_REMOTE"]).toBe(remoteWsf);
            expect(resolved["COMBINED"]).toBe(`/home/dev:${localWsf}`);
            expect(resolved["WITH_DEFAULT"]).toBe("/fallback");
        });

        test("no containerEnv returns empty record", () => {
            const cfg = withDefaults({ image: "ubuntu:24.04" });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            expect(cc.getResolvedContainerEnv()).toStrictEqual({});
        });
    });

    test("localEnv and var interpolation", () => {
        const procEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/var/lib/snapd/snap/bin",
            TERM: "xterm-256color",
            SHELL: "/bin/bash",
            EMPTY: "",
        };

        {
            const tests = [
                { test: "${containerWorkspaceFolder}:${localEnv:PATH}", result: `${remoteWsf}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${localEnv:PATH}:${containerWorkspaceFolder}:${localEnv:PATH}", result: `${localWsf}:${procEnv.PATH}:${remoteWsf}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}", result: `${localWsf}:${remoteWsf}:/usr/bin:/opt/app` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}:${localEnv:PATH}", result: `${localWsf}:${remoteWsf}:/usr/bin:/opt/app:${procEnv.PATH}` },
                { test: "${localEnv:SHELL:/bin/sh}", result: "/bin/bash" },
                { test: "${localEnv:MYSHELL:/bin/sh}", result: "/bin/sh" },
                { test: "${localEnv:EMPTY}", result: "" },
                { test: "${localEnv:EMPTY:empty}", result: "" },
                { test: "${localEnv:HUMPTY:}", result: "" },
                { test: "${localEnv:HUMPTY:dumpty}", result: "dumpty" },
                {
                    test: "${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/fish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/bash:/bin/fish:${localWsf}:${localWsfBase}:${remoteWsf}:${remoteWsfBase}`,
                },
            ];

            for (const test of tests) {
                expect(interpolateLocal(test.test, localWsf, remoteWsf, procEnv)).eq(test.result);
            }
        }
    });

    test("localEnv, containerEnv, and var interpolation", () => {
        const localEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/var/lib/snapd/snap/bin",
            TERM: "xterm-256color",
            SHELL: "/bin/bash",
            HOME: "/home/username",
            LOC: "LOCAL",
            EMPTY: "",
        };
        const containerEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin",
            TERM: "xterm-256color",
            SHELL: "/bin/zsh",
            HOME: "/home/root",
            LOC: "REMOTE",
            EMPTY: "",
        };

        const remoteWsf = "/workdir/dir";
        const remoteWsfBase = "dir";

        {
            const tests = [
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}:${containerWorkspaceFolder}:${localEnv:PATH}",
                    result: `LOCAL:REMOTE:/workdir/dir:${localEnv.PATH}`,
                },
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}:${localEnv:PATH}:${containerEnv:PATH}",
                    result: `${localEnv.LOC}:${containerEnv.LOC}:${localEnv.PATH}:${containerEnv.PATH}`,
                },
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}${localWorkspaceFolder}:${containerWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolderBasename}",
                    result: `${localEnv.LOC}:${containerEnv.LOC}${localWsf}:${remoteWsf}:${localWsfBase}:${remoteWsfBase}`,
                },
                {
                    test: "${containerEnv:SHELL:/bin/sh}:${containerEnv:MYSHELL:/bin/fish}:${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/myfish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/zsh:/bin/fish:/bin/bash:/bin/myfish:${localWsf}:${localWsfBase}:${remoteWsf}:${remoteWsfBase}`,
                },
                { test: "${localEnv:EMPTY}", result: "" },
                { test: "${localEnv:EMPTY:empty}", result: "" },
                { test: "${localEnv:HUMPTY:}", result: "" },
                { test: "${localEnv:HUMPTY:dumpty}", result: "dumpty" },
                { test: "${containerEnv:EMPTY}", result: "" },
                { test: "${containerEnv:EMPTY:empty}", result: "" },
                { test: "${containerEnv:HUMPTY:}", result: "" },
                { test: "${containerEnv:HUMPTY:dumpty}", result: "dumpty" },
            ];

            for (const test of tests) {
                expect(interpolateContainer(test.test, localWsf, remoteWsf, localEnv, containerEnv)).eq(test.result);
            }
        }
    });

    describe("getResolvedRemoteEnv", () => {
        test("excludes null values", () => {
            const cfg = withDefaults({
                image: "ubuntu",
                remoteEnv: { KEEP: "yes", DROP: null, ALSO_KEEP: "yep" },
            });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            const resolved = cc.getResolvedRemoteEnv({});

            expect("KEEP" in resolved).toBe(true);
            expect("ALSO_KEEP" in resolved).toBe(true);
            expect("DROP" in resolved).toBe(false);
        });

        test("interpolates localEnv, containerEnv, and workspace vars", () => {
            const env = { HOME: "/home/dev" } as NodeJS.ProcessEnv;
            const containerProbe = { CONTAINER_VAR: "from-container" } as NodeJS.ProcessEnv;
            const cfg = withDefaults({
                image: "ubuntu",
                remoteEnv: {
                    PLAIN: "literal",
                    WITH_LOCAL: "${localEnv:HOME}/bin",
                    WITH_CONTAINER: "${containerEnv:CONTAINER_VAR}/data",
                    WITH_WSF: "${localWorkspaceFolder}",
                    WITH_REMOTE: "${containerWorkspaceFolder}",
                    WITH_DEFAULT: "${localEnv:MISSING:/fallback}",
                    COMBINED: "${localEnv:HOME}:${containerEnv:CONTAINER_VAR}:${containerWorkspaceFolder}",
                },
            });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, env);
            const resolved = cc.getResolvedRemoteEnv(containerProbe);

            expect(resolved["PLAIN"]).toBe("literal");
            expect(resolved["WITH_LOCAL"]).toBe("/home/dev/bin");
            expect(resolved["WITH_CONTAINER"]).toBe("from-container/data");
            expect(resolved["WITH_WSF"]).toBe(localWsf);
            expect(resolved["WITH_REMOTE"]).toBe(remoteWsf);
            expect(resolved["WITH_DEFAULT"]).toBe("/fallback");
            expect(resolved["COMBINED"]).toBe(`/home/dev:from-container:${remoteWsf}`);
        });

        test("returns empty record when no remoteEnv", () => {
            const cfg = withDefaults({ image: "ubuntu" });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            expect(cc.getResolvedRemoteEnv({})).toStrictEqual({});
        });
    });

    test("getUnsetRemoteEnvArgs returns empty when no nulls", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            remoteEnv: { A: "1", B: "2" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([]);
    });

    test("getUnsetRemoteEnvArgs returns empty when no remoteEnv", () => {
        const cfg = withDefaults({ image: "ubuntu" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([]);
    });

    test("getResolvedRemoteUser priority chain", () => {
        const base = withDefaults({ image: "ubuntu" });
        const cc1 = ContainerConfig.create(localWsf, cfgPath, base, {});
        expect(cc1.getResolvedRemoteUser("imguser")).toBe("imguser");
        expect(cc1.getResolvedRemoteUser(undefined)).toBe("root");

        const withRemote = withDefaults({ image: "ubuntu", remoteUser: "alice" });
        const cc2 = ContainerConfig.create(localWsf, cfgPath, withRemote, {});
        expect(cc2.getResolvedRemoteUser("imguser")).toBe("alice");
        expect(cc2.getResolvedRemoteUser(undefined)).toBe("alice");

        const withContainer = withDefaults({ image: "ubuntu", containerUser: "bob" });
        const cc3 = ContainerConfig.create(localWsf, cfgPath, withContainer, {});
        expect(cc3.getResolvedRemoteUser("imguser")).toBe("bob");
        expect(cc3.getResolvedRemoteUser(undefined)).toBe("bob");

        const withBoth = withDefaults({ image: "ubuntu", containerUser: "bob", remoteUser: "alice" });
        const cc4 = ContainerConfig.create(localWsf, cfgPath, withBoth, {});
        expect(cc4.getResolvedRemoteUser("imguser")).toBe("alice");
    });

    test("getConfigId is stable when non-id fields change", () => {
        // TODO: handle other fields as well
        const base = withDefaults({ image: "ubuntu", remoteUser: "dev" });
        const cc1 = ContainerConfig.create(localWsf, cfgPath, base, {});

        const variants: schema.ImageDevcontainer[] = [
            { ...base, pull: true },
            { ...base, userEnvProbe: "loginShell" },
        ];

        for (const cfg of variants) {
            expect(ContainerConfig.create(localWsf, cfgPath, cfg, {}).getConfigId()).eq(cc1.getConfigId());
        }
    });

    test("getConfigId changes when id-relevant fields change", () => {
        // TODO: handle other fields as well
        const base = withDefaults({ image: "ubuntu", remoteUser: "dev" });
        const baseId = ContainerConfig.create(localWsf, cfgPath, base, {}).getConfigId();

        const variants: schema.ImageDevcontainer[] = [
            { ...base, image: "debian:12" },
            { ...base, name: "different" },
            { ...base, runArgs: ["--privileged"] },
            { ...base, appPort: [8080] },
            { ...base, init: true },
            { ...base, privileged: true },
            { ...base, capAdd: ["SYS_PTRACE"] },
            { ...base, securityOpt: ["seccomp=unconfined"] },
            { ...base, overrideCommand: false },
            { ...base, initializeCommand: "echo init" },
            { ...base, onCreateCommand: "echo create" },
            { ...base, updateContentCommand: "echo update" },
            { ...base, postCreateCommand: "echo post" },
            { ...base, postStartCommand: "echo start" },
            { ...base, postAttachCommand: "echo attach" },
            { ...base, workspaceFolder: "/custom", workspaceMount: "source=/a,target=/custom" },
            { ...base, mounts: [{ type: "bind" as const, source: "/a", target: "/b" }] },
            { ...base, containerEnv: { FOO: "bar" } },
            { ...base, containerUser: "nobody" },
            { ...base, updateRemoteUserUID: false },
            { ...base, remoteEnv: { BAZ: "qux" } },
            { ...base, remoteUser: "alice" },
        ];

        for (const cfg of variants) {
            const id = ContainerConfig.create(localWsf, cfgPath, cfg, {}).getConfigId();
            expect(id, `expected configId to change for ${JSON.stringify(cfg)}`).not.eq(baseId);
        }
    });
});
