import { setTimeout } from "node:timers/promises";
import { describe, expect, test, beforeEach } from "vitest";
import * as vscode from "vscode";

import { getExtensionKey, getLocalWsfExtensionKey, transientIntentStore } from "../globalState";
import { EXTENSION_ID } from "../constants";
import { initMocks } from "../../tests/common";

initMocks();

// getLocalWsfExtensionKey → getLocalWorkspaceFolder → vscode.env / vscode.workspace
(vscode as any).env = { remoteAuthority: undefined };
Object.defineProperty(vscode.workspace, "workspaceFolders", {
    value: [{ uri: { fsPath: "/tmp/test-ws" } }],
    writable: true,
});

function mockExtensionContext(): vscode.ExtensionContext {
    const store = new Map<string, unknown>();
    return {
        globalState: {
            get: (key: string) => store.get(key),
            update: (key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); },
        },
    } as unknown as vscode.ExtensionContext;
}

describe("globalState", () => {
    test("getExtensionKey prefixes with extension id", () => {
        expect(getExtensionKey("foo")).toBe(`${EXTENSION_ID}.foo`);
    });

    test("getLocalWsfExtensionKey includes workspace hash", () => {
        const key = getLocalWsfExtensionKey("mykey");
        expect(key).toMatch(new RegExp(`^${EXTENSION_ID}\\.[a-f0-9]{8}\\.mykey$`));
    });

    describe("transientIntentStore", () => {
        let ctx: vscode.ExtensionContext;

        beforeEach(() => {
            ctx = mockExtensionContext();
        });

        test("set then get returns stored value", () => {
            const store = transientIntentStore<string>("test-key", 10);
            store.set(ctx, "hello");
            expect(store.get(ctx)).toBe("hello");
        });

        test("get clears stored value (one-shot read)", () => {
            const store = transientIntentStore<string>("test-key", 10);
            store.set(ctx, "hello");
            expect(store.get(ctx)).toBe("hello");
            expect(store.get(ctx)).toBeUndefined();
        });

        test("get returns undefined when nothing stored", () => {
            const store = transientIntentStore<string>("test-key", 10);
            expect(store.get(ctx)).toBeUndefined();
        });

        test("timeout is in seconds", async () => {
            const store = transientIntentStore<string>("test-key", 2);
            store.set(ctx, "hello");

            await setTimeout(1000);
            expect(store.get(ctx)).toBe("hello");

            store.set(ctx, "hello");
            await setTimeout(2500);
            expect(store.get(ctx)).toBeUndefined();
        });

        test("stores complex objects", () => {
            const store = transientIntentStore<{ noCache: boolean, rebuild: boolean }>("opts", 10);
            const val = { noCache: true, rebuild: false };
            store.set(ctx, val);
            expect(store.get(ctx)).toStrictEqual(val);
        });

        test("separate keys are independent", () => {
            const store1 = transientIntentStore<string>("key1", 10);
            const store2 = transientIntentStore<string>("key2", 10);
            store1.set(ctx, "val1");
            store2.set(ctx, "val2");
            expect(store1.get(ctx)).toBe("val1");
            expect(store2.get(ctx)).toBe("val2");
        });
    });
});
