import * as crypto from "crypto";
import * as vscode from "vscode";
import { getVSCodeServerConfig } from "./serverConfig";
import { getContainerBinary, getContainerExtraArgs, runContainerCommandCapture } from "./devcontainerCore";


export const SERVER_PORT = 65120;

export interface ServerInstallConfig {
  scriptId: string;
  version: string;
  commit: string;
  quality: string;
  release: string;
  serverApplicationName: string;
  serverDataFolderName: string;
  downloadUrlTemplate: string;
  connectionToken: string;
  serverPort: number;
  extensionIds: string[];
  envVariables: string[];
}

export interface ServerInstallResult {
  exitCode: number;
  port: number;
  connectionToken: string;
  logFile: string;
  arch: string;
  platform: string;
  dataFolder: string;
  scriptOutput?: string;
}

export interface ContainerRun {
  run(
    containerName: string,
    command: string[]
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

export class ServerInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerInstallError";
  }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = "https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz";


export function parseInstallOutput(
  stdout: string,
  scriptId: string
): Record<string, string> | undefined {
  const startMarker = `${scriptId}: start`;
  const endMarker = `${scriptId}: end`;

  const startIdx = stdout.indexOf(startMarker);
  if (startIdx < 0) return undefined;

  const endIdx = stdout.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx < 0) return undefined;

  const block = stdout.substring(startIdx + startMarker.length, endIdx);
  const result: Record<string, string> = {};

  for (const line of block.split(/\r?\n/)) {
    const eqIdx = line.indexOf("==");
    if (eqIdx < 0) continue;
    const key = line.substring(0, eqIdx).trim();
    if (!key) continue;
    const rest = line.substring(eqIdx + 2);
    const endEqIdx = rest.indexOf("==");
    const value = endEqIdx >= 0 ? rest.substring(0, endEqIdx) : rest;
    result[key] = value;
  }

  return result;
}

export function extractServerResult(
  raw: Record<string, string>
): ServerInstallResult {
  const exitCode = parseInt(raw.exitCode ?? "", 10);
  if (exitCode !== 0) {
    const details = Object.entries(raw)
      .filter(([k]) => k !== "exitCode")
      .map(([k, v]) => `  ${k}=${v}`)
      .join("\n");
    throw new ServerInstallError(
      `Server install script failed with exit code ${raw.exitCode}\n${details}`
    );
  }

  const port = parseInt(raw.listeningOn ?? "", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new ServerInstallError(
      `Invalid port from server: "${raw.listeningOn}"`
    );
  }

  const connectionToken = raw.connectionToken ?? "";
  if (!connectionToken) {
    throw new ServerInstallError("No connection token returned by server");
  }

  return {
    exitCode,
    port,
    connectionToken,
    logFile: raw.logFile ?? "",
    arch: raw.arch ?? "",
    platform: raw.platform ?? "",
    dataFolder: "",
  };
}

export async function installServerInContainer(
  containerName: string,
  config: ServerInstallConfig,
  executor: ContainerRun
): Promise<ServerInstallResult> {
  const script = generateBashInstallScript(config);

  const { stdout, stderr, code } = await executor.run(containerName, [
    "bash",
    "-c",
    script,
  ]);

  if (code !== 0 && !stdout.includes(`${config.scriptId}: start`)) {
    throw new ServerInstallError(
      `Container exec failed (exit ${code}): ${stderr.slice(0, 500)}`
    );
  }

  const parsed = parseInstallOutput(stdout, config.scriptId);
  if (!parsed) {
    throw new ServerInstallError(
      `Could not parse server install output — missing markers in stdout.\n${stdout.slice(-1000)}`
    );
  }

  // Capture script output before the markers for debugging
  const markerIdx = stdout.indexOf(`${config.scriptId}: start`);
  const prelude = markerIdx > 0 ? stdout.substring(0, markerIdx).trim() : "";

  let result: ServerInstallResult;
  try {
    result = extractServerResult(parsed);
  } catch (e) {
    if (prelude) {
      (e as Error).message += `\nScript output:\n${prelude}`;
    }
    throw e;
  }

  if (prelude) {
    result.scriptOutput = prelude;
  }
  return result;
}

export function makeContainerExec(): ContainerRun {
  return {
    run(containerName, command) {
      return runContainerCommandCapture(["exec", containerName, ...command]);
    },
  };
}

async function execServerCapture(
  execServer: vscode.ExecServer,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawned = await execServer.spawn(command, args);
  let stdout = "";
  let stderr = "";
  spawned.stdout.onDidReceiveMessage((data) => { stdout += Buffer.from(data).toString(); });
  spawned.stderr.onDidReceiveMessage((data) => { stderr += Buffer.from(data).toString(); });
  const exit = await spawned.onExit;
  return { stdout, stderr, code: exit.status };
}

export function makeRemoteContainerExec(execServer: vscode.ExecServer): ContainerRun {
  const bin = getContainerBinary();
  const extra = getContainerExtraArgs();
  return {
    run(containerName, command) {
      return execServerCapture(execServer, bin, [...extra, "exec", containerName, ...command]);
    },
  };
}

export async function getRemoteMappedPort(
  execServer: vscode.ExecServer,
  containerName: string,
  containerPort: number
): Promise<number> {
  const bin = getContainerBinary();
  const extra = getContainerExtraArgs();
  const result = await execServerCapture(execServer, bin, [
    ...extra, "port", containerName, `${containerPort}/tcp`
  ]);
  if (result.code !== 0) {
    throw new ServerInstallError(
      `Could not get port mapping for ${containerName}: ${result.stderr.trim()}`
    );
  }
  const match = result.stdout.trim().match(/:(\d+)$/m);
  if (!match) {
    throw new ServerInstallError(
      `No port mapping found for ${containerPort}/tcp on ${containerName}`
    );
  }
  return Number(match[1]);
}

export async function installServer(
  containerName: string,
  executor?: ContainerRun
): Promise<ServerInstallResult> {
  const serverConfig = await getVSCodeServerConfig();

  const baseFolder = serverConfig.serverDataFolderName || ".vscodium-server";
  const devcontainerFolder = baseFolder.replace(/-server$/, "-devcontainer");

  const config: ServerInstallConfig = {
    scriptId: crypto.randomBytes(12).toString("hex"),
    version: serverConfig.version,
    commit: serverConfig.commit,
    quality: serverConfig.quality,
    release: serverConfig.release,
    serverApplicationName: serverConfig.serverApplicationName,
    serverDataFolderName: devcontainerFolder,
    downloadUrlTemplate:
      serverConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE,
    connectionToken: crypto.randomUUID(),
    serverPort: SERVER_PORT,
    extensionIds: [],
    envVariables: [],
  };

  const result = await installServerInContainer(containerName, config, executor ?? makeContainerExec());
  result.dataFolder = devcontainerFolder;
  return result;
}

// Based on open-remote-ssh/src/serverSetup.ts (MIT, jeanp413)
// Adapted for container use: --host=0.0.0.0, no socket path, no extensions,
// no custom install path, no server validation, no env variable capture.
export function generateBashInstallScript(config: ServerInstallConfig): string {
  const {
    scriptId,
    version,
    commit,
    quality,
    release,
    serverApplicationName,
    serverDataFolderName,
    downloadUrlTemplate,
    connectionToken,
    serverPort,
    extensionIds,
    envVariables,
  } = config;

  const extensions = extensionIds.map(id => "--install-extension " + id).join(" ");

  return `
# Server installation script
# Based on open-remote-ssh (MIT, jeanp413)

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="${version}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"
DISTRO_VSCODIUM_RELEASE="${release}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_LISTEN_FLAG="--port=${serverPort}"
SERVER_DATA_DIR="$HOME/${serverDataFolderName}"
SERVER_DATA_DIR_FLAG="--server-data-dir=$SERVER_DATA_DIR"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=
# SERVER_VALIDATION_FLAG=""  # not needed for container use

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
    echo "${scriptId}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(v => `echo "${v}==$${v}=="`).join("\n    ")}
    echo "${scriptId}: end"
    exit 0
}

# Check if platform is supported
if ! command -v uname; then
    echo "Error 'uname' command not found, could not get platform/arch data."
    print_install_results_and_exit 1
fi

KERNEL="$(uname -s)"
case $KERNEL in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    FreeBSD)
        PLATFORM="freebsd"
        ;;
    DragonFly)
        PLATFORM="dragonfly"
        ;;
    "")
        echo "Error uname -s yields empty result"
        print_install_results_and_exit 1
        ;;
    *)
        echo "Error platform not supported: $KERNEL"
        print_install_results_and_exit 1
        ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    armv7l | armv8l)
        SERVER_ARCH="armhf"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    ppc64le)
        SERVER_ARCH="ppc64le"
        ;;
    riscv64)
        SERVER_ARCH="riscv64"
        ;;
    loongarch64)
        SERVER_ARCH="loong64"
        ;;
    s390x)
        SERVER_ARCH="s390x"
        ;;
    *)
        echo "Error architecture not supported: $ARCH"
        print_install_results_and_exit 1
        ;;
esac

# https://www.freedesktop.org/software/systemd/man/os-release.html
OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z $OS_RELEASE_ID ]]; then
    OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
    if [[ -z $OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="unknown"
    fi
fi

# Create installation folder
if [[ ! -d $SERVER_DIR ]]; then
    mkdir -p $SERVER_DIR
    if (( $? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

# adjust platform for vscodium download, if needed
if [[ $OS_RELEASE_ID = alpine ]]; then
    PLATFORM=$OS_RELEASE_ID
fi

SERVER_DOWNLOAD_URL="$(echo "${downloadUrlTemplate.replace(/\$\{/g, '\\${')}" | sed "s/\\\${quality}/$DISTRO_QUALITY/g" | sed "s/\\\${version}/$DISTRO_VERSION/g" | sed "s/\\\${commit}/$DISTRO_COMMIT/g" | sed "s/\\\${os}/$PLATFORM/g" | sed "s/\\\${arch}/$SERVER_ARCH/g" | sed "s/\\\${release}/$DISTRO_VSCODIUM_RELEASE/g")"

# Check if server script is already installed
if [[ ! -f $SERVER_SCRIPT ]]; then
    case "$PLATFORM" in
        darwin | linux | alpine | freebsd )
            ;;
        *)
            echo "Error '$PLATFORM' needs manual installation of remote extension host"
            print_install_results_and_exit 1
            ;;
    esac

    pushd $SERVER_DIR > /dev/null

    if command -v wget >/dev/null 2>&1; then
        wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz $SERVER_DOWNLOAD_URL
    elif command -v curl >/dev/null 2>&1; then
        curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz $SERVER_DOWNLOAD_URL
    elif command -v fetch >/dev/null 2>&1; then
        fetch --retry --timeout=10 --quiet --output=vscode-server.tar.gz $SERVER_DOWNLOAD_URL
    else
        echo "Error no tool to download server binary"
        print_install_results_and_exit 1
    fi

    if (( $? > 0 )); then
        echo "Error downloading server from $SERVER_DOWNLOAD_URL"
        rm -rf vscode-server.tar.gz
        print_install_results_and_exit 1
    fi

    tar -xf vscode-server.tar.gz --strip-components 1
    if (( $? > 0 )); then
        echo "Error while extracting server contents"
        rm -rf vscode-server.tar.gz
        print_install_results_and_exit 1
    fi

    if [[ ! -f $SERVER_SCRIPT ]]; then
        rm -rf $SERVER_DIR/*
        echo "Error server contents are corrupted"
        print_install_results_and_exit 1
    fi

    rm -f vscode-server.tar.gz

    popd > /dev/null
else
    echo "Server script already installed in $SERVER_SCRIPT"
fi

# -- server validation not needed for container use --
# if true; then
#     if command -v sed >/dev/null 2>&1; then
#         sed -i -E 's/"commit": "[0-9a-f]+",/"commit": "'"$DISTRO_COMMIT"'",/' "$SERVER_DIR/product.json";
#     fi
# fi

# Try to find if server is already running
if [[ -f $SERVER_PIDFILE ]]; then
    SERVER_PID="$(cat $SERVER_PIDFILE)"
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
else
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z $SERVER_RUNNING_PROCESS ]]; then
    if [[ -f $SERVER_LOGFILE ]]; then
        rm $SERVER_LOGFILE
    fi
    if [[ -f $SERVER_TOKENFILE ]]; then
        rm $SERVER_TOKENFILE
    fi

    touch $SERVER_TOKENFILE
    chmod 600 $SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="${connectionToken}"
    echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

    $SERVER_SCRIPT --start-server --host=0.0.0.0 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
    echo $! > $SERVER_PIDFILE
else
    echo "Server script is already running $SERVER_SCRIPT"
fi

if [[ -f $SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
    echo "Error server token file not found $SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
    for i in {1..5}; do
        LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n $LISTENING_ON ]]; then
            break
        fi
        sleep 0.5
    done

    if [[ -z $LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        print_install_results_and_exit 1
    fi
else
    echo "Error server log file not found $SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
`;
}
