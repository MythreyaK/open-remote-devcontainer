import { z } from "zod/mini";

const oneOf = z.union;
const allOf = z.intersection;

export const BindMount = z.object({
    type: z.literal("bind"),
    source: z.string(),
    target: z.string(),
    options: z.optional(z.string()),
});

export const VolumeMount = z.object({
    type: z.literal("volume"),
    source: z.optional(z.string()),
    target: z.string(),
    options: z.optional(z.string()),
});

export const Mount = z.discriminatedUnion("type", [
  BindMount,
  VolumeMount,
]);

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
        ])
    ),
]);

export const BuildOptions = z.object({
    target: z.optional(z.string()),
    args: z.optional(z.record(z.string(), z.string())),
    cacheFrom: z.optional(oneOf([
        z.string(),
        z.array(z.string()),
    ])),
    options: z.optional(z.array(z.string())),
});

export const NonComposeBase = z.object({
    appPort: z.optional(oneOf([
        z.string(),
        z.number(),
        z.array(_stringOrNumber),
    ])),
    runArgs: z.optional(z.array(z.string())),
    shutdownAction: z.optional(ShutdownAction),
    overrideCommand: z.optional(z.boolean()),
    workspaceFolder: z.optional(z.string()),
    workspaceMount: z.optional(z.string()),
});

export const ImageContainer = z.object({
    image: z.string()
});

export const DockerfileContainer = oneOf([
    z.object({
        build: allOf(
            z.object({
                dockerfile: z.string(),
                context: z.optional(z.string()),
            }),
            BuildOptions,
        ),
    }),
    allOf(
        z.object({
            dockerFile: z.string(),
            context: z.optional(z.string()),
        }),
        z.object({
            build: z.optional(BuildOptions),
        })
    )
]);

// key=value values can be null
const _envPairsNullable = z.record(z.string(), z.nullable(z.string()));
const _envPairs = z.record(z.string(), z.string());

export const DevcontainerCommon = z.object({
    name: z.optional(z.string()),
    // features : Features,
    forwardPorts: z.optional(z.array(_stringOrNumber)),
    mounts: z.optional(z.array(oneOf([
        Mount,
        z.string(),
    ]))),
    updateRemoteUserUID: z.optional(z.boolean()),
    init: z.optional(z.boolean()),
    privileged: z.optional(z.boolean()),
    capAdd: z.optional(z.array(z.string())),
    securityOpt: z.optional(z.array(z.string())),
    remoteEnv: z.optional(_envPairsNullable),
    containerEnv: z.optional(_envPairs),
    remoteUser: z.optional(z.string()),
    containerUser: z.optional(z.string()),
    initializeCommand: z.optional(_cmd),
    onCreateCommand: z.optional(_cmd),
    updateContentCommand: z.optional(_cmd),
    postCreateCommand: z.optional(_cmd),
    postStartCommand: z.optional(_cmd),
    postAttachCommand: z.optional(_cmd),
    userEnvProbe: z.optional(EnvProbe),
});

export const DevcontainerConfig = allOf(DevcontainerCommon, NonComposeBase);

const ConfigSchemaBase = allOf(oneOf([ImageContainer, DockerfileContainer]), DevcontainerConfig);
export const ConfigSchema = ConfigSchemaBase.check((c) => {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    const hasMount = (c.value.workspaceMount !== undefined)
        && (c.value.workspaceMount !== null)
        && (c.value.workspaceMount !== "");
    const hasFolder = (c.value.workspaceFolder !== undefined)
        && (c.value.workspaceFolder !== null)
        && (c.value.workspaceFolder !== "");
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    if (hasMount !== hasFolder) {
        c.issues.push({
            code: "custom",
            input: c.value,
            message: "Both workspaceFolder and workspaceMount must be set, or both must be unset",
        });
    }
});

export type Config = z.infer<typeof ConfigSchema>;
