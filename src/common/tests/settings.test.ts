import { expect, test } from "vitest";

import { withDefaults, type Settings } from "../settings";
import { initMocks } from "../../tests/common";

initMocks();

// When you add a field to Settings, this fails to compile
const ALL_KEYS: Record<keyof Settings, true> = {
    dockerPath: true,
    extraArgs: true,
    defaultExtensions: true,
};

test("exhaustiveness: Settings field count", () => {
    expect(Object.keys(ALL_KEYS)).toHaveLength(3);
});

test("withDefaults: fills gaps, preserves provided", () => {
    expect(withDefaults({})).toStrictEqual({
        dockerPath: "docker",
        extraArgs: [],
        defaultExtensions: [],
    });
    expect(withDefaults({ dockerPath: "podman" })).toStrictEqual({
        dockerPath: "podman",
        extraArgs: [],
        defaultExtensions: [],
    });
    expect(withDefaults({ dockerPath: undefined })).toStrictEqual({
        dockerPath: "docker",
        extraArgs: [],
        defaultExtensions: [],
    });
});
