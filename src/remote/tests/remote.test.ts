import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";

import * as install from "../installServer";
import * as resolver from "../resolver";

import { init } from "../../tests/common";

init();

function countSubstring(from: string, item: string) {
    return from.split(item).length - 1;
}

function mangleCasing(str: string) {
    // this operates on hex-strings, so spread is fine
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    return [...str].map(c => Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()).join("");
}

function filterNumbers(str: string) {
    // this operates on hex-strings, so spread is fine
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    return [...str].filter(c => (c < "0" || c > "9")).join("");
}

function toAuthority(str: string) {
    return `${resolver.AUTHORITY_BASE}+${str}`;
}

const testString = "6e6556455220674f4e6e61206749566520596f552055702c204e4576655220676f4e4e61206c657420794f7520646f776e2c204e4556457220474f6e6e612072754e2041524f556e6420614e642064457365727420796f75";
const MaxIter = 100;

describe("fixtures", () => {
    test("filterNumbers", () => {
        expect(filterNumbers("03fO0oBaR993472")).eq("fOoBaR");
    });

    test("toAuthority", () => {
        expect(toAuthority("abc")).eq(resolver.AUTHORITY_BASE + "+" + "abc");
    });

    test("mangleCasing", () => {
        let counter = 0;
        for (let z = 0; z < MaxIter && counter < 10; ++z) {
            const mangled = mangleCasing(testString);
            counter += filterNumbers(mangled) !== filterNumbers(testString) ? 1 : 0;

            expect(resolver.decodeRemoteAuthority(toAuthority(mangled)))
                .eq(resolver.decodeRemoteAuthority(toAuthority(testString)));
        }

        expect(counter).eq(10);
    });
});

describe("remote authority", () => {
    const localWsf = "/home/user/workdir";

    test("encode generates all lower-case", () => {
        const encoded = resolver.encodeRemoteAuthority(localWsf);
        expect(encoded.toLowerCase()).eq(encoded);
    });

    test("encode starts with remote authority", () => {
        const encoded = resolver.encodeRemoteAuthority(localWsf);
        expect(encoded.startsWith(resolver.AUTHORITY_BASE)).eq(true);
    });

    test("encode/decode roundtrip", () => {
        const encoded = resolver.encodeRemoteAuthority(localWsf);
        const decoded = resolver.decodeRemoteAuthority(encoded);
        expect(localWsf).eq(decoded);
    });

    test("encode/decode roundtrip (unicode)", () => {
        const localWsf = "/home/君の名は";
        const encoded = resolver.encodeRemoteAuthority(localWsf);
        expect(resolver.decodeRemoteAuthority(encoded)).eq(localWsf);
    });

    test("encode/decode preserves encode's input casing", () => {
        const encodedA = resolver.encodeRemoteAuthority("aaAaa");
        const encodedB = resolver.encodeRemoteAuthority("aaaaa");
        expect(resolver.decodeRemoteAuthority(encodedA)).not.eq(resolver.decodeRemoteAuthority(encodedB));
    });

    test("encode/decode roundtrip with mangled casing", () => {
        const workspaces = [
            localWsf,
            "/home/君の名は",
        ];

        for (const wsf of workspaces) {
            const encoded = resolver.encodeRemoteAuthority(wsf);
            const authorityPrefix = `${resolver.AUTHORITY_BASE}+`;

            const encodedWsf = encoded.slice(authorityPrefix.length, encoded.length);

            const items = [
                toAuthority(encodedWsf.toUpperCase()),
                toAuthority(encodedWsf.toLowerCase()),
            ];

            let counter = 0;
            for (let z = 0; z < MaxIter && counter < 10; ++z) {
                const mangled = mangleCasing(encodedWsf);
                items.push(toAuthority(mangled));
                counter += (filterNumbers(mangled) !== filterNumbers(encodedWsf)) ? 1 : 0;
            }

            expect(counter).eq(10);

            for (const item of items) {
                const decoded = resolver.decodeRemoteAuthority(item);
                expect(wsf).eq(decoded);
            }
        }
    });
});

describe("Install script", () => {
    test("string replacement tests / no env + no ext", async () => {
        const info: install.ScriptInstallInfo = {
            port: 6543,
            extensions: [],
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
            connectionToken: "0xf00ba4",
            downloadTemplateUrl: "https://localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}.tar.gz",
            codiumVersion: "1.2.345",
            forceReinstall: false,
        };

        const script = await fs.readFile(install.INSTALL_SCRIPT_LOCATION, { encoding: "utf-8" });
        const updatedScript = install.updateScript(script, info, true);

        expect(updatedScript.includes("0xf00ba4")).toBe(true);
        expect(updatedScript.includes("--install-extension pub1.ext1 --install-extension pub2.ext1")).toBe(true);
        expect(updatedScript.includes('CODIUM_FORCE_REINSTALL_SERVER="false"')).toBe(true);
        expect(updatedScript.includes('CODIUM_NEW_INSTALL_VERSION="1.2.345"')).toBe(true);
        expect(updatedScript.includes('CODIUM_SERVER_LISTEN_PORT="6543"')).toBe(true);
        expect(updatedScript.includes("localhost/${CODIUM_OS_PLATFORM}-${CODIUM_ARCH}")).toBe(true);

        // await fs.writeFile("out.sh", updatedScript, { encoding: 'utf-8', mode: 0o700 });
    });
});
