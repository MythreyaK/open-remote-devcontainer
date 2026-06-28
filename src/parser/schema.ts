import { z } from "zod/mini";

const oneOf = z.union;
const allOf = z.intersection;
const minString = z.string().check(z.minLength(1));

export const BindMount = z.object({
    type: z.literal("bind"),
    source: minString,
    target: minString,
    options: z.optional(minString),
});

export const VolumeMount = z.object({
    type: z.literal("volume"),
    source: z.optional(minString),
    target: minString,
    options: z.optional(minString),
});

export const Mount_z = z.discriminatedUnion("type", [
    BindMount,
    VolumeMount,
]);

export type Mount = z.infer<typeof Mount_z>;

export const EnvProbe = z.enum([
    "none",
    "loginShell",
    "loginInteractiveShell",
    "interactiveShell",
]);

export const ShutdownAction = z.enum([
    "none",
    "stopContainer",
]);

const _stringOrNumber = oneOf([
    z.string(),
    z.number(),
]);
const _cmd = oneOf([
    z.string(),
    z.array(z.string()),
    z.record(
        z.string(),
        oneOf([
            z.string(),
            z.array(z.string()),
        ]),
    ),
]);

export const BuildOptions = z.object({
    target: z.optional(minString),
    args: z.optional(z.record(minString, z.string())),
    cacheFrom: z.optional(oneOf([
        minString,
        z.array(minString),
    ])),
    options: z.optional(z.array(z.string())),
});

export const NonComposeBase_z = z.object({
    appPort: z.optional(oneOf([
        minString,
        z.number(),
        z.array(_stringOrNumber),
    ])),
    runArgs: z.optional(z.array(z.string())),
    shutdownAction: z.optional(ShutdownAction),
    overrideCommand: z.optional(z.boolean()),
    workspaceFolder: z.optional(minString),
    workspaceMount: z.optional(minString),
});

export const ImageContainer_z = z.object({
    image: minString,
    pull: z.optional(z.boolean()),
});

const DockerfileBuild_ZodBase = z.object({
    build: allOf(
        z.object({
            dockerfile: minString,
            context: z.optional(z.string()),
        }),
        BuildOptions,
    ),
});

const _DockerfileContainer_ZodBase = oneOf([
    DockerfileBuild_ZodBase,
    allOf(
        z.object({
            dockerFile: minString,
            context: z.optional(z.string()),
        }),
        z.object({
            build: z.optional(BuildOptions),
        }),
    ),
]);

// always use buid: {...} syntax, by moving dockerFile and context inside
type DockerfileContainer = z.infer<typeof _DockerfileContainer_ZodBase>;
export const DockerfileContainer_z = z.pipe(_DockerfileContainer_ZodBase, z.transform<DockerfileContainer>((e) => {
    if ("dockerFile" in e) {
        const ret: DockerfileContainer = {
            build: {
                dockerfile: e.dockerFile,
                context: e.context,
                ...e.build,
            },
        };
        return ret;
    }
    return e;
}));

// key=value values can be null
const _envPairsNullable = z.record(z.string(), z.nullable(z.string()));
const _envPairs = z.record(z.string(), z.string());

export const DevcontainerCommon_z = z.object({
    name: z.optional(minString),
    // features : Features,
    forwardPorts: z.optional(z.array(_stringOrNumber)),
    mounts: z.optional(z.array(oneOf([
        Mount_z,
        minString,
    ]))),
    updateRemoteUserUID: z.optional(z.boolean()),
    init: z.optional(z.boolean()),
    privileged: z.optional(z.boolean()),
    capAdd: z.optional(z.array(minString)),
    securityOpt: z.optional(z.array(minString)),
    remoteEnv: z.optional(_envPairsNullable),
    containerEnv: z.optional(_envPairs),
    remoteUser: z.optional(minString),
    containerUser: z.optional(minString),
    initializeCommand: z.optional(_cmd),
    onCreateCommand: z.optional(_cmd),
    updateContentCommand: z.optional(_cmd),
    postCreateCommand: z.optional(_cmd),
    postStartCommand: z.optional(_cmd),
    postAttachCommand: z.optional(_cmd),
    userEnvProbe: z.optional(EnvProbe),
});

export const DevcontainerConfig = allOf(DevcontainerCommon_z, NonComposeBase_z);
export type DevcontainerCommon = z.infer<typeof DevcontainerConfig>;

const ConfigSchemaBase = allOf(oneOf([ImageContainer_z, DockerfileContainer_z]), DevcontainerConfig);
export const ConfigSchema = ConfigSchemaBase.check((c) => {
    const val = c.value;
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    const hasMount = (val.workspaceMount !== undefined)
      && (val.workspaceMount !== null);
    const hasFolder = (val.workspaceFolder !== undefined)
      && (val.workspaceFolder !== null);
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    // TODO: relax this requirement, and set mount to /workspace if unset?
    if (hasMount !== hasFolder) {
        c.issues.push({
            code: "custom",
            input: val,
            message: "Both workspaceFolder and workspaceMount must be set, or both must be unset",
        });
    }

    if (val.workspaceMount) {
        const targets = extractWorkspaceMount(val.workspaceMount);

        if (targets.length === 0) {
            c.issues.push({
                code: "custom",
                input: val.workspaceMount,
                message: "Could not detect a 'target=...' mount in workspaceMount",
            });
        }

        if (targets.length > 1) {
            c.issues.push({
                code: "custom",
                input: val.workspaceMount,
                message: "Detected multiple mount targets in key workspaceMount. Use 'mounts' for the rest",
            });
        }
    }
});

export type Config = z.infer<typeof ConfigSchema>;

export type ImageDevcontainer = z.infer<typeof ImageContainer_z> & z.infer<typeof DevcontainerConfig>;

// this transforms so build always exists
export type DockerfileDevcontainer = z.infer<typeof DockerfileBuild_ZodBase> & z.infer<typeof DevcontainerConfig>;

export function isImageBased(config: Config): config is ImageDevcontainer {
    return "image" in config;
}

export function isDockerfileBased(config: Config): config is DockerfileDevcontainer {
    return "build" in config && config.build !== undefined && "dockerfile" in config.build;
}

export function extractMountTarget(mnt: string) {
    const matches = mnt.split(",");

    const targets: string[] = (() => {
        const tgt: string[] = [];
        for (const match of matches) {
            if (match.startsWith("target=")) {
                tgt.push(match.replace("target=", ""));
            }
        }
        return tgt;
    })();

    return targets;
}

export function extractMountSource(mnt: string) {
    const matches = mnt.split(",");

    const targets: string[] = (() => {
        const tgt: string[] = [];
        for (const match of matches) {
            if (match.startsWith("source=")) {
                tgt.push(match.replace("source=", ""));
            }
        }
        return tgt;
    })();

    return targets;
}

export function extractWorkspaceMount(mnt: string) {
    return extractMountTarget(mnt);
}
