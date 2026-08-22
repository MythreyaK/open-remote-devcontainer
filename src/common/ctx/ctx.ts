import * as localCtx from "./localCtx";
import { RunCtx } from "./runctx";

let RUNCTX: RunCtx | undefined;

export function setRunCtx(ctx: RunCtx) {
    RUNCTX = ctx;
}

export function getRunCtx(): RunCtx {
    if (!RUNCTX) {
        RUNCTX = new localCtx.LocalRunCtx();
    }
    return RUNCTX;
}
