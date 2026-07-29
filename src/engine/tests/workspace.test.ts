import { describe, expect, test } from "vitest";

import { ContainerConfig } from "../container";

import { withDefaults } from "./common";
import { initMocks } from "../../tests/common";

initMocks();

describe("workspace mounts", () => {
    const localWsf = "/tmp/dir";
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    const commonCfg = withDefaults({
        name: "test",
        image: "ubuntu:24.04",
    });

    test("neither set: defaults", () => {
        const cfg = commonCfg;
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});

        expect(cc.isImageBased()).toBe(true);
        const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");

        expect(cc.getRemoteMountDir()).eq("/workspaces/dir");
        expect(cc.cfg.workspaceFolder).toBeUndefined();
        expect(cc.cfg.workspaceMount).toBeUndefined();
        expect(createArgs.join(" ")).includes(`--mount source=${localWsf},target=/workspaces/dir,type=bind`);
    });

    test("both set: passthrough", () => {
        for (const dir of ["/custom/dir", "/custom/dir/subdir"]) {
            const cfg = withDefaults({
                ...commonCfg,
                workspaceFolder: dir,
                workspaceMount: "source=${localWorkspaceFolder}/sub-folder,target=/custom/dir,type=bind,consistency=cached",
            });

            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});

            expect(cc.cfg.workspaceFolder).eq(dir);
            expect(cc.getRemoteMountDir()).eq("/custom/dir");

            expect(cc.isImageBased()).toBe(true);
            const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");

            expect(cfg.workspaceMount).toBeDefined();
            expect(createArgs.join(" "))
                .contains(` --mount ${cfg.workspaceMount?.replace("${localWorkspaceFolder}", localWsf)} `)
                .not.contains("${localWorkspaceFolder}")
                .not.contains("/custom/dir/subdir");
        }
    });

    test("only workspaceFolder: infer mount", () => {
        const cfg = withDefaults({
            ...commonCfg,
            workspaceFolder: "/workspaces/myproject/src",
        });

        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});

        expect(cc.isImageBased()).toBe(true);
        expect(cc.cfg.workspaceFolder).eq("/workspaces/myproject/src");
        expect(cc.cfg.workspaceMount).toBeUndefined();
        expect(cc.getRemoteMountDir()).eq("/workspaces/dir");
    });

    test("only workspaceFolder: monorepo subfolder", () => {
        const cfg = withDefaults({
            ...commonCfg,
            workspaceFolder: "/workspaces/dir/frontend",
        });

        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});

        expect(cc.isImageBased()).toBe(true);
        expect(cc.cfg.workspaceFolder).eq("/workspaces/dir/frontend");
        expect(cc.cfg.workspaceMount).toBeUndefined();
        expect(cc.getRemoteMountDir()).eq("/workspaces/dir");
        expect(cc.getRunCreateCmd(cfg.image, "foobar").join(" "))
            .not.contains(cfg.workspaceFolder);
    });

    test("only workspaceMount: infer folder", () => {
        const cfg = withDefaults({
            ...commonCfg,
            workspaceMount: "source=${localWorkspaceFolder}/sub-folder,target=/workspaces/dir,type=bind,consistency=cached",
        });

        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});

        expect(cc.cfg.workspaceFolder).toBeUndefined();
        expect(cc.getRemoteMountDir()).eq("/workspaces/dir");

        expect(cc.isImageBased()).toBe(true);
        const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");
        expect(createArgs)
            .contains(`${cfg.workspaceMount?.replace("${localWorkspaceFolder}", localWsf)}`)
            .not.contains("${localWorkspaceFolder}");
    });

    test("empty workspaceMount: schema parse works", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", workspaceMount: "" });
        expect(cfg.workspaceMount).toBe("");
    });

    test("empty workspaceMount: skips mount in getRunCreateCmd()", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", workspaceMount: "" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const cmd = cc.getRunCreateCmd(cfg.image, "tmp");

        expect(cc.getRemoteMountDir()).toBe("/workspaces/dir");
        expect(cmd).not.toContain("--mount");
    });

    test("empty workspaceMount: default workspaceFolder", () => {
        const cfg = withDefaults({ image: "ubuntu:24.04", workspaceMount: "" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const cmd = cc.getRunCreateCmd(cfg.image, "tmp");

        expect(cc.getRemoteMountDir()).toBe("/workspaces/dir");
        expect(cmd).not.toContain("--mount");
    });

    test("empty workspaceMount: explicit workspaceFolder", () => {
        const cfg = withDefaults({
            image: "ubuntu:24.04",
            workspaceMount: "",
            workspaceFolder: "/home/user/workspace",
        });

        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const cmd = cc.getRunCreateCmd(cfg.image, "tmp");

        expect(cc.getRemoteMountDir()).toBe("/home/user/workspace");
        expect(cmd).not.toContain("--mount");
    });

    test("empty workspaceMount: configId is not same as unspecified", () => {
        const cfg_a = withDefaults({ image: "ubuntu:24.04", workspaceMount: "" });
        const cc_a = ContainerConfig.create(localWsf, cfgPath, cfg_a);

        const cfg_b = withDefaults({ image: "ubuntu:24.04" });
        const cc_b = ContainerConfig.create(localWsf, cfgPath, cfg_b);

        expect(cc_a.getConfigId()).not.eq(cc_b.getConfigId());
    });
});
