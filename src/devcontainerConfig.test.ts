import { describe, it, expect } from "vitest";
import {
  parseDevcontainerConfig,
  expandVariables,
  expandConfigVariables,
  mountToVolumeArg,
  mountsToDockerArgs,
  VariableContext,
} from "./devcontainerConfig";

const baseCtx: VariableContext = {
  localEnv: { HOME: "/home/user", PROJ: "myapp" },
  localWorkspaceFolder: "/home/user/projects/myapp",
  localWorkspaceFolderBasename: "myapp",
  containerWorkspaceFolder: "/workspace/myapp",
};

describe("parseDevcontainerConfig", () => {
  it("parses valid JSON5 with comments", () => {
    const raw = `{
      // base image
      "image": "node:22",
      "remoteUser": "dev",
    }`;
    const config = parseDevcontainerConfig(raw);
    expect(config.image).toBe("node:22");
    expect(config.remoteUser).toBe("dev");
  });

  it("returns undefined for missing optional fields", () => {
    const config = parseDevcontainerConfig("{}");
    expect(config.image).toBeUndefined();
    expect(config.mounts).toBeUndefined();
    expect(config.runArgs).toBeUndefined();
  });

  it("parses mounts with both string and object entries", () => {
    const raw = JSON.stringify({
      mounts: [
        "/host:/container:z",
        { source: "/a", target: "/b", type: "bind", options: "Z,ro" },
      ],
    });
    const config = parseDevcontainerConfig(raw);
    expect(config.mounts).toHaveLength(2);
    expect(config.mounts![0]).toBe("/host:/container:z");
    expect(config.mounts![1]).toEqual({
      source: "/a",
      target: "/b",
      type: "bind",
      options: "Z,ro",
    });
  });

  it("ignores unknown keys", () => {
    const raw = JSON.stringify({
      image: "ubuntu",
      features: { "ghcr.io/something": {} },
      customizations: { vscode: {} },
    });
    const config = parseDevcontainerConfig(raw);
    expect(config.image).toBe("ubuntu");
    expect(config.mounts).toBeUndefined();
  });

  it("parses runArgs", () => {
    const config = parseDevcontainerConfig(
      JSON.stringify({ runArgs: ["--privileged", "--cap-add=SYS_PTRACE"] })
    );
    expect(config.runArgs).toEqual(["--privileged", "--cap-add=SYS_PTRACE"]);
  });
});

describe("expandVariables", () => {
  it("expands localEnv variables", () => {
    expect(expandVariables("${localEnv:HOME}/work", baseCtx)).toBe(
      "/home/user/work"
    );
  });

  it("returns empty string for missing env var", () => {
    expect(expandVariables("${localEnv:MISSING}/x", baseCtx)).toBe("/x");
  });

  it("uses default value for missing env var", () => {
    expect(expandVariables("${localEnv:MISSING:/fallback}", baseCtx)).toBe(
      "/fallback"
    );
  });

  it("prefers env var over default", () => {
    expect(expandVariables("${localEnv:HOME:/fallback}", baseCtx)).toBe(
      "/home/user"
    );
  });

  it("expands localWorkspaceFolder", () => {
    expect(expandVariables("${localWorkspaceFolder}/src", baseCtx)).toBe(
      "/home/user/projects/myapp/src"
    );
  });

  it("expands localWorkspaceFolderBasename", () => {
    expect(expandVariables("img-${localWorkspaceFolderBasename}", baseCtx)).toBe(
      "img-myapp"
    );
  });

  it("expands containerWorkspaceFolder", () => {
    expect(expandVariables("${containerWorkspaceFolder}/data", baseCtx)).toBe(
      "/workspace/myapp/data"
    );
  });

  it("handles multiple variables in one string", () => {
    expect(
      expandVariables("${localEnv:HOME}/${localEnv:PROJ}", baseCtx)
    ).toBe("/home/user/myapp");
  });

  it("leaves unknown variables as-is", () => {
    expect(expandVariables("${remoteEnv:PATH}", baseCtx)).toBe(
      "${remoteEnv:PATH}"
    );
  });
});

describe("expandConfigVariables", () => {
  it("expands mount source and target", () => {
    const config = {
      mounts: [
        {
          source: "${localEnv:HOME}/work",
          target: "${localEnv:HOME}/work",
          type: "bind" as const,
          options: "z",
        },
      ],
    };
    const expanded = expandConfigVariables(config, baseCtx);
    const mount = expanded.mounts![0];
    expect(typeof mount).toBe("object");
    if (typeof mount === "object") {
      expect(mount.source).toBe("/home/user/work");
      expect(mount.target).toBe("/home/user/work");
      expect(mount.options).toBe("z");
    }
  });

  it("expands string mounts", () => {
    const config = { mounts: ["${localEnv:HOME}/a:/b:z"] };
    const expanded = expandConfigVariables(config, baseCtx);
    expect(expanded.mounts![0]).toBe("/home/user/a:/b:z");
  });

  it("expands postCreateCommand", () => {
    const config = { postCreateCommand: "cd ${localWorkspaceFolder} && make" };
    const expanded = expandConfigVariables(config, baseCtx);
    expect(expanded.postCreateCommand).toBe(
      "cd /home/user/projects/myapp && make"
    );
  });

  it("expands postStartCommand array", () => {
    const config = {
      postStartCommand: ["echo ${localEnv:HOME}", "echo ${localEnv:PROJ}"],
    };
    const expanded = expandConfigVariables(config, baseCtx);
    expect(expanded.postStartCommand).toEqual([
      "echo /home/user",
      "echo myapp",
    ]);
  });

  it("expands runArgs", () => {
    const config = { runArgs: ["--label=ws=${localWorkspaceFolderBasename}"] };
    const expanded = expandConfigVariables(config, baseCtx);
    expect(expanded.runArgs).toEqual(["--label=ws=myapp"]);
  });

  it("does not mutate the original config", () => {
    const config = {
      mounts: [{ source: "${localEnv:HOME}", target: "/mnt", type: "bind" as const }],
      runArgs: ["--label=${localEnv:PROJ}"],
    };
    const originalMountSource = (config.mounts[0] as any).source;
    expandConfigVariables(config, baseCtx);
    expect((config.mounts[0] as any).source).toBe(originalMountSource);
    expect(config.runArgs[0]).toBe("--label=${localEnv:PROJ}");
  });
});

describe("mountToVolumeArg", () => {
  it("converts bind mount with options", () => {
    const result = mountToVolumeArg({
      source: "/host/path",
      target: "/container/path",
      type: "bind",
      options: "z,ro",
    });
    expect(result).toEqual({
      flag: "-v",
      value: "/host/path:/container/path:z,ro",
    });
  });

  it("converts bind mount without options", () => {
    const result = mountToVolumeArg({
      source: "/a",
      target: "/b",
    });
    expect(result).toEqual({ flag: "-v", value: "/a:/b" });
  });

  it("defaults type to bind", () => {
    const result = mountToVolumeArg({ source: "/a", target: "/b" });
    expect(result.flag).toBe("-v");
  });

  it("handles tmpfs mount", () => {
    const result = mountToVolumeArg({ target: "/tmp", type: "tmpfs" });
    expect(result).toEqual({ flag: "--tmpfs", value: "/tmp" });
  });

  it("passes string mount through", () => {
    const result = mountToVolumeArg("/host:/container:Z");
    expect(result).toEqual({ flag: "-v", value: "/host:/container:Z" });
  });
});

describe("mountsToDockerArgs", () => {
  it("returns empty array for no mounts", () => {
    expect(mountsToDockerArgs([])).toEqual([]);
  });

  it("generates args for mixed mount types", () => {
    const args = mountsToDockerArgs([
      { source: "/a", target: "/b", options: "z" },
      { target: "/tmp", type: "tmpfs" },
      "/x:/y:ro",
    ]);
    expect(args).toEqual([
      "-v", "/a:/b:z",
      "--tmpfs", "/tmp",
      "-v", "/x:/y:ro",
    ]);
  });
});
