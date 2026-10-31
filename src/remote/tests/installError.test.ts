import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { formatInstallError, InstallScriptError, INSTALL_SCRIPT_LOCATION } from "../installServer";

import { initMocks } from "../../tests/common";

initMocks();

describe("formatInstallError", () => {
    test("uses INSTALL_SCRIPT_ERROR lines and the EXITCODE name", () => {
        const stdout = [
            "INSTALL_SCRIPT_INFO: Install lock acquired",
            "INSTALL_SCRIPT_ERROR: codium-daemon-monitor exited with code 1",
            "INSTALL_SCRIPT_ERROR:   SyntaxError: The requested module 'node:util' does not provide an export named 'X'",
            "EXIT[[CODIUM_ARCH:x64]]",
            "EXITCODE[[CODE:14]]",
        ].join("\n");

        const msg = formatInstallError({ exit: 4, stdout, stderr: "" });
        expect(msg).toContain("SERVER_INSTALL_FAILED (exit 14)");
        expect(msg).toContain("codium-daemon-monitor exited with code 1");
        expect(msg).toContain("SyntaxError");
        // noise stays out of the error
        expect(msg).not.toContain("EXIT[[");
        expect(msg).not.toContain("Install lock acquired");
    });

    test("no error lines: falls back to stderr", () => {
        const msg = formatInstallError({ exit: 127, stdout: "INSTALL_SCRIPT_INFO: hi", stderr: "bash: curl: command not found\n" });
        expect(msg).toContain("UNKNOWN (exit 127)");
        expect(msg).toContain("bash: curl: command not found");
    });

    test("no error lines and no stderr: falls back to the stdout tail", () => {
        const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\nEXITCODE[[CODE:17]]";
        const msg = formatInstallError({ exit: 17, stdout, stderr: "" });
        expect(msg).toContain("INSTALL_LOCK_TIMEOUT (exit 17)");
        expect(msg).toContain("EXITCODE[[CODE:17]]");
        expect(msg).not.toContain("line 0\n");
    });

    test("empty output is detected", () => {
        expect(formatInstallError({ exit: 1, stdout: "", stderr: "" })).toContain("Empty output from installScript");
    });

    test("EXITCODE in output wins over the process exit code", () => {
        const msg = formatInstallError({ exit: 1, stdout: "INSTALL_SCRIPT_ERROR: x\nEXITCODE[[CODE:13]]", stderr: "" });
        expect(msg).toContain("SERVER_DOWNLOAD_FAILED (exit 13)");
    });

    test("never throws on garbage", () => {
        expect(() => formatInstallError({ exit: -1, stdout: "EXITCODE[[CODE:]]\n\0\0", stderr: "\u001b[31m" })).not.toThrow();
    });
});

test("INSTALL_EXIT_CODES matches installServer.sh", () => {
    const fromEnum = Object.fromEntries(
        Object.entries(InstallScriptError)
            .filter(([_, v]) => typeof v === "number"));

    const script = readFileSync(INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
    const fromScript = Object.fromEntries(
        Array.from(script.matchAll(/^([A-Z_]+)=(\d+)$/gm)).map(m => [m[1], Number(m[2])]),
    );

    expect(fromScript).toStrictEqual(fromEnum);
});
