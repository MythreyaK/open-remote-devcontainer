import { getLogSink } from "./log";

class DevcontainerError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
        this.name = new.target.name;
        getLogSink().error(`${this.name}: ${reason}`);
    }
}

export class InternalError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
        this.name = new.target.name;
        getLogSink().error(`${this.name}: ${reason}. This is probably a bug, please report!`);
    }
}

export class ParseError extends DevcontainerError {}
export class ConfigError extends DevcontainerError {}
export class SpawnError extends DevcontainerError {}
export class EngineError extends DevcontainerError {}
export class InstallError extends DevcontainerError {}
