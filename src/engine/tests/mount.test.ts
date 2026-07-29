import { describe, expect, test } from "vitest";

import { ContainerConfig } from "../container";

import { withDefaults } from "./common";
import { initMocks } from "../../tests/common";

initMocks();

describe("mounts", () => {
    const localWsf = "/tmp/dir";
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    test("bind with options appends options suffix", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            mounts: [{ type: "bind" as const, source: "/a", target: "/b", options: "ro,z" }],
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("-v /a:/b:ro,z");
    });

    test("volume with source and options", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            mounts: [{ type: "volume" as const, source: "mydata", target: "/data", options: "nocopy" }],
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("-v mydata:/data:nocopy");
    });

    test("volume without source omits source prefix", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            mounts: [{ type: "volume" as const, target: "/data" }],
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("-v /data");
        expect(args).not.includes("-v :/data");
    });

    test("volume mount without source produces no undefined in args", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            mounts: [{ type: "volume" as const, target: "/data" }],
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("-v /data");
        expect(args).not.includes("undefined");
    });
});
