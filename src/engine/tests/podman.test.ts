import { describe, expect, test } from "vitest";

import { ContainerConfig, ContainerEngine } from "../container";

import { withDefaults } from "./common";
import { initMocks } from "../../tests/common";

initMocks();

describe("podman userns=keep-id", () => {
    const localWsf = "/tmp/dir";
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    test("podman + non-root: adds --userns=keep-id", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
        expect(args).toContain("--userns=keep-id");
    });

    test("podman + root: no --userns=keep-id", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "root" });
        expect(args).not.toContain("--userns=keep-id");
    });

    test("podman + non-root + --uidmap in runArgs skips internal --userns", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", runArgs: ["--uidmap=0:0:1"] });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
        expect(args).not.toContain("--userns=keep-id");
    });

    test("podman + non-root + --gidmap in runArgs skips internal --userns", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", runArgs: ["--gidmap=0:0:1"] });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
        expect(args).not.toContain("--userns=keep-id");
    });

    test("podman + non-root + --userns=auto in runArgs skips internal --userns", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", runArgs: ["--userns=auto"] });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
        expect(args).not.toContain("--userns=keep-id");
    });

    test("podman + non-root + unrelated runArgs: still adds --userns=keep-id", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", runArgs: ["--device", "/dev/kfd", "--pid", "host"] });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
        const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
        expect(args).toContain("--userns=keep-id");
    });

    test("docker: no --userns=keep-id regardless of remoteUser", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.docker });
        {
            const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "ubuntu" });
            expect(args).not.toContain("--userns=keep-id");
        }
        {
            const args = cc.getRunCreateCmd(cfg.image, "foobar", { remoteUser: "root" });
            expect(args).not.toContain("--userns=keep-id");
        }
    });

    describe("relabel (SELinux)", () => {
        test("podman: inferred mount gets relabel=shared", () => {
            const cfg = withDefaults({ image: "ubuntu:24.04" });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.podman });
            const args = cc.getRunCreateCmd(cfg.image, "foobar").join(" ");
            expect(args).includes(` --mount source=${localWsf},target=/workspaces/dir,type=bind,relabel=shared `);
        });

        test("docker: inferred mount has no relabel", () => {
            const cfg = withDefaults({ image: "ubuntu:24.04" });
            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine: ContainerEngine.docker });
            const args = cc.getRunCreateCmd(cfg.image, "foobar").join(" ");
            expect(args).includes(` --mount source=${localWsf},target=/workspaces/dir,type=bind `);
            expect(args).not.includes("relabel");
        });

        test("user-provided mount is not modified regardless of engine", () => {
            const userMount = `source=${localWsf},target=/custom/dir,type=bind,consistency=cached`;
            const cfg = withDefaults({
                image: "ubuntu:24.04",
                workspaceMount: userMount,
                workspaceFolder: "/custom/dir",
            });
            for (const engine of [ContainerEngine.podman, ContainerEngine.docker]) {
                const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {}, { engine });
                const args = cc.getRunCreateCmd(cfg.image, "foobar").join(" ");
                expect(args).includes(` --mount ${userMount} `);
                expect(args).not.includes("relabel");
            }
        });
    });
});
