import { describe, expect, test } from "vitest";

import { ContainerConfig } from "../container";

import { withDefaults, sanityCheck } from "./common";
import { initMocks } from "../../tests/common";

initMocks();

describe("context and dockerfile resolution", () => {
    const cases: {
        label: string,
        cfgPath: string,
        localEnv: NodeJS.ProcessEnv,
        dockerfile: string,
        context: string | undefined,
        expectedCtx: string,
        expectedDockerfile: string,
    }[] = [
        {
            label: "implicit context, relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "implicit context, nested relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "docker/Dockerfile.dev",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/docker/Dockerfile.dev",
        },
        {
            label: "context '..' (parent), relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "..",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "context '..' (parent), dockerfile also '..'",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "../Dockerfile",
            context: "..",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "explicit context '.', same as implicit",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: ".",
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "explicit relative context subdir",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "build",
            expectedCtx: "/tmp/dir/.devcontainer/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "absolute context, relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "/opt/build",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "absolute dockerfile, implicit context",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "/opt/Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/opt/Dockerfile",
        },
        {
            label: "both absolute",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "/opt/Dockerfile",
            context: "/opt/build",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/opt/Dockerfile",
        },
        {
            label: "flat devcontainer.json, implicit context",
            cfgPath: "/tmp/dir/.devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "flat devcontainer.json, context '.devcontainer'",
            cfgPath: "/tmp/dir/.devcontainer.json",
            localEnv: {},
            dockerfile: ".devcontainer/Dockerfile",
            context: ".devcontainer",
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        // --- variable interpolation cases ---
        {
            label: "context uses ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "${localWorkspaceFolder}",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "context uses ${localWorkspaceFolderBasename}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "../${localWorkspaceFolderBasename}",
            expectedCtx: "/tmp/dir/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "dockerfile uses ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "${localWorkspaceFolder}/Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "context uses ${localEnv:VAR}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: { BUILD_DIR: "/opt/build" },
            dockerfile: "Dockerfile",
            context: "${localEnv:BUILD_DIR}",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "${localEnv:VAR} with default, var exists",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: { CTX: "custom" },
            dockerfile: "Dockerfile",
            context: "${localEnv:CTX:fallback}",
            expectedCtx: "/tmp/dir/.devcontainer/custom",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "${localEnv:VAR} with default, var missing",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "${localEnv:CTX:fallback}",
            expectedCtx: "/tmp/dir/.devcontainer/fallback",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "both use ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "${localWorkspaceFolder}/.devcontainer/Dockerfile",
            context: "${localWorkspaceFolder}",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
    ];

    const localWsf = "/tmp/dir";

    for (const c of cases) {
        const cfg = withDefaults({
            build: {
                dockerfile: c.dockerfile,
                ...(c.context !== undefined ? { context: c.context } : {}),
            },
        });

        test(`test: ${c.label}`, () => {
            sanityCheck(localWsf, c.cfgPath);
            const cc = ContainerConfig.create(localWsf, c.cfgPath, cfg, c.localEnv);
            expect(cc.getResolvedBuildcontextDir(), c.label).toBe(c.expectedCtx);
            expect(cc.getResolvedDockerfilePath(), c.label).toBe(c.expectedDockerfile);
        });
    }
});
