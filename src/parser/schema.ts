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

export type Cmd = z.infer<typeof _cmd>;

export const BuildOptions = z.object({
    target: z.optional(minString),
    args: z.optional(z.record(minString, z.string())),
    cacheFrom: z.optional(oneOf([
        minString,
        z.array(minString),
    ])),
    options: z._default(z.optional(z.array(z.string())), []),
});

export const NonComposeBase_z = z.object({
    appPort: z.optional(oneOf([
        minString,
        z.number(),
        z.array(_stringOrNumber),
    ])),
    runArgs: z._default(z.optional(z.array(z.string())), []),
    shutdownAction: z._default(z.optional(ShutdownAction), "stopContainer"),
    overrideCommand: z._default(z.optional(z.boolean()), true),
    workspaceFolder: z.optional(minString),
    workspaceMount: z.optional(z.string()),
});

export const ImageContainer_z = z.object({
    image: minString,
    pull: z.optional(z.boolean()),
});

const DockerfileBuild_z = z.object({
    build: allOf(
        z.object({
            dockerfile: minString,
            context: z._default(z.optional(z.string()), "."),
        }),
        BuildOptions,
    ),
});

const _DockerfileContainer_z = oneOf([
    DockerfileBuild_z,
    allOf(
        z.object({
            dockerFile: minString,
            context: z._default(z.optional(z.string()), "."),
        }),
        z.object({
            build: z.optional(BuildOptions),
        }),
    ),
]);

// always use buid: {...} syntax, by moving dockerFile and context inside
type DockerfileContainer = z.infer<typeof _DockerfileContainer_z>;
export const DockerfileContainer_z = z.pipe(_DockerfileContainer_z, z.transform<DockerfileContainer>((e) => {
    if ("dockerFile" in e) {
        const ret: DockerfileContainer = {
            build: {
                dockerfile: e.dockerFile,
                context: e.context,
                options: [],
                ...e.build,
            },
        };
        return ret;
    }
    return e;
}));

// key=value values can be null
const _envPairsNullable_z = z.record(z.string(), z.nullable(z.string()));
const _envPairs = z.record(z.string(), z.string());

export type RemoteEnv = z.infer<typeof _envPairsNullable_z>;

export const customizations_z = z.object({
    vscode: z.optional(z.object({
        extensions: z.optional(z.array(z.string())),
    })),
});

export type Customizations = z.infer<typeof customizations_z>;

export const DevcontainerCommon_z = z.object({
    name: z.optional(minString),
    // features : Features,
    forwardPorts: z._default(z.optional(z.array(_stringOrNumber)), []),
    mounts: z.optional(z.array(oneOf([
        Mount_z,
        minString,
    ]))),
    updateRemoteUserUID: z._default(z.optional(z.boolean()), true),
    init: z._default(z.optional(z.boolean()), false),
    privileged: z._default(z.optional(z.boolean()), false),
    capAdd: z._default(z.optional(z.array(minString)), []),
    securityOpt: z._default(z.optional(z.array(minString)), []),
    remoteEnv: z.optional(_envPairsNullable_z),
    containerEnv: z.optional(_envPairs),
    remoteUser: z.optional(minString),
    containerUser: z.optional(minString),
    initializeCommand: z.optional(oneOf([z.string(), z.array(z.string())])),
    onCreateCommand: z.optional(_cmd),
    updateContentCommand: z.optional(_cmd),
    postCreateCommand: z.optional(_cmd),
    postStartCommand: z.optional(_cmd),
    postAttachCommand: z.optional(_cmd),
    userEnvProbe: z._default(z.optional(EnvProbe), "loginInteractiveShell"),
    customizations: z.optional(customizations_z),
});

const _rawcheckbase_z = z.unknown().check((c) => {
    const val = c.value as Record<string, unknown>;

    // check if both build and image are specified
    if (("build" in val || "dockerFile" in val) && "image" in val) {
        c.issues.push({
            code: "custom",
            input: c.value,
            message: "One of 'image' or 'dockerfile' must be specified, not both.",
        });
    }
});

// ------------ container spec ------------
export const DevcontainerConfig_z = allOf(DevcontainerCommon_z, NonComposeBase_z);
export type DevcontainerCommon = z.infer<typeof DevcontainerConfig_z>;
// this transforms so build always exists
export type DockerfileDevcontainer = z.infer<typeof DockerfileBuild_z> & z.infer<typeof DevcontainerConfig_z>;

// ------------ image spec ------------
export type ImageDevcontainer = z.infer<typeof ImageContainer_z> & z.infer<typeof DevcontainerConfig_z>;

// ------------ full schema spec ------------
export const ConfigSchemaBase = z.pipe(
    _rawcheckbase_z,
    allOf(oneOf([ImageContainer_z, DockerfileContainer_z]), DevcontainerConfig_z),
);

export const ConfigSchema = ConfigSchemaBase.check(postparseCheck);
export type Config = z.infer<typeof ConfigSchema>;

// ------------ parsing utils ------------

function postparseCheck(c: z.core.ParsePayload<z.infer<typeof ConfigSchemaBase>>) {
    const val = c.value;
    // spec claims both workspaceFolder and workspaceMount must be set, or both must be unset
    // defaults handled in ContainerConfig

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
}

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
