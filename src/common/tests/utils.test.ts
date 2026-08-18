import { describe, expect, test } from "vitest";

import { parseEnv } from "../utils";

function nullJoin(items: string[]): string {
    return items.map(e => `${e}\0`).join("");
}

describe("parseEnv", () => {
    test("sanity check nullJoin", () => {
        expect(nullJoin([])).toBe("");

        expect(nullJoin(["A=B"])).toBe("A=B\0");
        expect(nullJoin(["A=B", "C=D"])).toBe("A=B\0C=D\0");

        expect(nullJoin(
            [
                "A=B=C",
                "C=D12=E:F",
                "PATH=/A:/ABC",
            ]))
            .toBe("A=B=C\0C=D12=E:F\0PATH=/A:/ABC\0");

        // nullchar string '\0' followed by digits is an octal escape in JS string literals
        // e.g. "FOO\0123" is not a "FOO" + null byte + "123". It's FOO + octal 012 (newline) + "3"
        // nullJoin avoids this trap
        const digitAfterNull = nullJoin(["A=1", "123=bad"]);
        expect(digitAfterNull.split("\0")).toStrictEqual(["A=1", "123=bad", ""]);
        expect(digitAfterNull).not.eq("A=1\x0a3=bad\0");
    });

    test("null-separated env output", () => {
        const input = [
            "EMPTYNOEQ1",
            "HOME=/home/user",
            "PATH=/usr/bin:/bin",
            "EMPTYNOEQ2",
            "TERM=xterm",
            "EMPTY=",
            "EMPTYNOEQ3",
        ];
        const result = parseEnv(nullJoin(input));

        expect(result.HOME).eq("/home/user");
        expect(result.PATH).eq("/usr/bin:/bin");
        expect(result.TERM).eq("xterm");
        expect(result.EMPTY).eq("");
        expect(Object.entries(result)).toHaveLength(4);
    });

    test("values containing '='", () => {
        const input = [
            "FORMULA=a=b=c",
            "NORMAL=val",
        ];
        const result = parseEnv(nullJoin(input));

        expect(result.FORMULA).eq("a=b=c");
        expect(result.NORMAL).eq("val");
    });

    test("skips entries without '='", () => {
        const input = [
            "GOOD=val",
            "never gonna give you up",
            "noSpaceGarbage",
            "ALSO_GOOD=ok",
        ];
        const result = parseEnv(nullJoin(input));

        expect(result.GOOD).eq("val");
        expect(result.ALSO_GOOD).eq("ok");
        expect(Object.keys(result)).toHaveLength(2);
    });

    test("skips entries with invalid env var keys", () => {
        const input = [
            "To run a command as administrator=ignored",
            "PATH=/usr/bin",
            "123BAD=no",
        ];
        const result = parseEnv(nullJoin(input));

        expect(result.PATH).eq("/usr/bin");
        expect(Object.keys(result)).toHaveLength(1);
    });

    test("handles shell noise prepended to env output", () => {
        const noise = 'To run a command as administrator (user "root"), use "sudo <command>".\nSee "man sudo_root" for details.\n\n';
        const envs = [
            "PWD=/home/ubuntu",
            "HOME=/home/ubuntu",
            "SHELL=/bin/bash",
        ];
        const input = noise + nullJoin(envs);
        const result = parseEnv(input);

        expect(result.PWD).toBeUndefined();
        expect(result.HOME).eq("/home/ubuntu");
        expect(result.SHELL).eq("/bin/bash");
    });

    test("handles empty input", () => {
        expect(Object.keys(parseEnv("")).length).eq(0);
        expect(Object.keys(parseEnv("\0")).length).eq(0);
    });

    test("accepts underscore-prefixed keys", () => {
        const input = [
            "_PRIVATE=secret",
            "__double=val",
            "_=last_cmd",
        ];
        const result = parseEnv(nullJoin(input));

        expect(result._PRIVATE).eq("secret");
        expect(result.__double).eq("val");
        expect(result._).eq("last_cmd");
    });
});
