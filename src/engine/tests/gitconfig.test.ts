import { describe, expect, test } from "vitest";

import { getGitConfig } from "../lifecycle";
import { initMocks } from "../../tests/common";

initMocks();

describe("getGitConfig", () => {
    test("returns ~/.gitconfig and XDG path", () => {
        const env = { HOME: "/home/user" };

        expect(getGitConfig(env)).toEqual([
            "/home/user/.gitconfig",
            "/home/user/.config/git/config",
        ]);
    });

    test("uses XDG_CONFIG_HOME when set", () => {
        const env = { HOME: "/home/user", XDG_CONFIG_HOME: "/custom" };

        expect(getGitConfig(env)).toEqual([
            "/home/user/.gitconfig",
            "/custom/git/config",
        ]);
    });

    test("throws when HOME is missing", () => {
        expect(() => getGitConfig({})).toThrow("HOME env var not present");
    });
});
