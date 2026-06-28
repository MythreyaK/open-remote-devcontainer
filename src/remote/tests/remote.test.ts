import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";

import * as install from "../installServer";

function countSubstring(from: string, item: string) {
    return from.split(item).length - 1;
}

describe("Install script", () => {
    test("string replacement tests / no env + no ext", async () => {
        const info: install.ScriptInstallInfo = {
            port: 6543,
            extensions: [],
            remoteEnvs: {},
            connectionToken: "0xf00ba4",
            downloadTemplateUrl: "https://localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}.tar.gz",
            codiumVersion: "1.2.345",
            forceReinstall: false,
        };

        const script = await fs.readFile(install.INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
        const updatedScript = install.updateScript(script, info, true);

        expect(countSubstring(updatedScript, "export")).eq(0);
        expect(updatedScript.includes("0xf00ba4")).toBe(true);
        expect(updatedScript.includes("--install-extension")).toBe(false);
        expect(updatedScript.includes('CODIUM_FORCE_REINSTALL_SERVER="false"')).toBe(true);
        expect(updatedScript.includes('CODIUM_NEW_INSTALL_VERSION="1.2.345"')).toBe(true);
        expect(updatedScript.includes('CODIUM_SERVER_LISTEN_PORT="6543"')).toBe(true);
        expect(updatedScript.includes("localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}")).toBe(true);

    // await fs.writeFile("out.sh", updatedScript, { encoding: 'utf-8', mode: 0o700 });
    });

    test("string replacement tests / env + ext", async () => {
        const info: install.ScriptInstallInfo = {
            port: 6543,
            extensions: ["pub1.ext1", "pub2.ext1"],
            remoteEnvs: { ENV1: "VAL1", ENV2: "VAL2" },
            connectionToken: "0xf00ba4",
            downloadTemplateUrl: "https://localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}.tar.gz",
            codiumVersion: "1.2.345",
            forceReinstall: false,
        };

        const script = await fs.readFile(install.INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
        const updatedScript = install.updateScript(script, info, true);

        expect(countSubstring(updatedScript, "export")).eq(2);
        expect(updatedScript.includes("0xf00ba4")).toBe(true);
        expect(updatedScript.includes("--install-extension pub1.ext1 --install-extension pub2.ext1")).toBe(true);
        expect(updatedScript.includes('CODIUM_FORCE_REINSTALL_SERVER="false"')).toBe(true);
        expect(updatedScript.includes('CODIUM_NEW_INSTALL_VERSION="1.2.345"')).toBe(true);
        expect(updatedScript.includes('CODIUM_SERVER_LISTEN_PORT="6543"')).toBe(true);
        expect(updatedScript.includes("localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}")).toBe(true);

    // await fs.writeFile("out.sh", updatedScript, { encoding: 'utf-8', mode: 0o700 });
    });
});
