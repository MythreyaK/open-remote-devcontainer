import { getLogSink } from "./log";

class DevcontainerError extends Error {
    constructor(name: string, public readonly reason: string) {
        super(reason);
        this.name = name;
        getLogSink().error(`${name}: ${reason}`);
    }
}

export class InternalError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
        this.name = "InternalError";
        getLogSink().error(`InternalError: ${reason}. This is probably a bug, please report!`);
    }
}

export class ParseError extends DevcontainerError {
    constructor(reason: string) { super("ParseError", reason); }
}

export class ConfigError extends DevcontainerError {
    constructor(reason: string) { super("ConfigError", reason); }
}

export class SpawnError extends DevcontainerError {
    constructor(reason: string) { super("SpawnError", reason); }
}

export class EngineError extends DevcontainerError {
    constructor(reason: string) { super("EngineError", reason); }
}

export class InstallError extends DevcontainerError {
    constructor(reason: string) { super("InstallError", reason); }
}
