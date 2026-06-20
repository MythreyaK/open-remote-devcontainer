import { getLogSink } from "./log";

export class ParseError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
};

// better name?
export class ConfigError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
}

export class SpawnError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
}

// better name?
export class EngineError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
}

// better name?
export class InstallError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
}

// better name?
export class InternalError extends Error {
    constructor(
        public readonly reason: string,
    ) {
        super(reason);
        getLogSink().error(reason);
    }
}
