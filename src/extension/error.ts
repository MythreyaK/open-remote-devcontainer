import { getLogSink } from "./log";


export class ParseError extends Error {
    constructor(
        public readonly reason: string
    ) {
        getLogSink().error(reason);
        super(reason);
    }
};

export class SpawnError extends Error {
    constructor(
        public readonly reason: string
    ) {
        getLogSink().error(reason);
        super(reason);
    }
}

// better name?
export class ExtensionError extends Error {
    constructor(
        public readonly reason: string
    ) {
        getLogSink().error(reason);
        super(reason);
    }
}
