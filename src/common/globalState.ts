import * as vscode from "vscode";

import { EXTENSION_ID } from "./constants";
import { getLocalWorkspaceFolder, getWorkspaceId } from "../extension/workspace";
import { getLogSink } from "../extension/log";
import { BuildOpts } from "../engine/lifecycle";

export function getExtensionKey(key: string) {
    return `${EXTENSION_ID}.${key}`;
}

export function getLocalWsfExtensionKey(key: string) {
    const wsfId = getWorkspaceId(getLocalWorkspaceFolder().toString(true));
    return `${EXTENSION_ID}.${wsfId.slice(0, 8)}.${key}`;
}

export function setGlobalState(ctx: vscode.ExtensionContext, key: string, val: unknown) {
    getLogSink().info(`setGlobalState: '${key}': ${JSON.stringify(val)}`);
    ctx.globalState.update(getExtensionKey(key), val);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getGlobalState<T>(ctx: vscode.ExtensionContext, key: string): T | undefined {
    const ret = ctx.globalState.get<T>(getExtensionKey(key));
    getLogSink().info(`getGlobalState: '${key}': ${JSON.stringify(ret)}`);
    return ret;
}

export function setLocalWsfGlobalState(ctx: vscode.ExtensionContext, key: string, val: unknown) {
    getLogSink().info(`setLocalWsfGlobalState: '${key}': ${JSON.stringify(val)}`);
    ctx.globalState.update(getLocalWsfExtensionKey(key), val);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getLocalWsfGlobalState<T>(ctx: vscode.ExtensionContext, key: string): T | undefined {
    const ret = ctx.globalState.get<T>(getLocalWsfExtensionKey(key));
    getLogSink().info(`getLocalWsfGlobalState: '${key}': ${JSON.stringify(ret)}`);
    return ret;
}

interface DataStore<T> {
    data: T | undefined,
    expires: number,
};

/**
 *
 * @param key Data to store
 * @param timeout Timeout in seconds. undefined is returned if timeout expires
 * @returns T or undefined
 */
export function transientIntentStore<T>(key: string, timeout: number = 10) {
    return {
        get(ctx: vscode.ExtensionContext): T | undefined {
            getLogSink().info(`Calling IntentStore ${key}.get()`);

            const retrieved = getLocalWsfGlobalState<DataStore<T>>(ctx, key);
            getLogSink().info(`Calling IntentStore ${key}.get() => ${JSON.stringify(retrieved)}`);
            setLocalWsfGlobalState(ctx, key, undefined);

            if (retrieved && retrieved.expires > Date.now()) {
                return retrieved.data;
            }
            else {
                return undefined;
            }
        },
        set(ctx: vscode.ExtensionContext, val: T) {
            getLogSink().info(`Calling IntentStore ${key}.set(${JSON.stringify(val)})`);

            const data: DataStore<T> = {
                data: val,
                expires: Date.now() + (timeout * 1000),
            };

            setLocalWsfGlobalState(ctx, key, data);
        },
    };
}

export const BuildOptIntent = transientIntentStore<BuildOpts>("BuildOpts");
