import { getLogSink } from "../../extension/log";
import * as localCtx from "./localCtx";
import { ExecCtx } from "./execCtx";

let EXEC_CTX: ExecCtx | undefined;
let callCount: number = 0;

export function setExecCtx(ctx: ExecCtx) {
    EXEC_CTX = ctx;
}

export function getExecCtx(): ExecCtx {
    callCount++;

    getLogSink().debug(`getExecCtx: ${callCount.toString().padStart(4, "0")}`);

    if (!EXEC_CTX) {
        EXEC_CTX = new localCtx.LocalExecCtx();
    }
    return EXEC_CTX;
}
