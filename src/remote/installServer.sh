#!/usr/bin/env bash

#_CODIUM_INJECT_DEBUG_SET_X
set -eu # 🇪🇺
set -o pipefail

set -E
trap 'echo "INSTALL_SCRIPT_ERROR: trap ERR: line ${LINENO}: \`${BASH_COMMAND}\` failed with exit code $?"' ERR

# CODIUM_INJECT_* are injected from extension via replacement
# CODIUM_DOWNLOAD_URL='CODIUM_INJECT_DOWNLOAD_URL' # injected after platform info is set
CODIUM_SERVER_COMMIT='CODIUM_INJECT_SERVER_COMMIT'
CODIUM_SERVER_VERSION='CODIUM_INJECT_SERVER_VERSION'
CODIUM_SERVER_ROOT_DIR='CODIUM_INJECT_SERVER_ROOT_DIR'
CODIUM_SERVER_LAUNCH_CONFIG='CODIUM_INJECT_SERVER_LAUNCH_CONFIG'
CODIUM_SERVER_LISTEN_PORT='CODIUM_INJECT_SERVER_LISTEN_PORT'
CODIUM_FORCE_REINSTALL_SERVER='CODIUM_INJECT_FORCE_REINSTALL_SERVER'
CODIUM_SHUTDOWN_ACTION='CODIUM_INJECT_SHUTDOWN_ACTION'

# Derived
CODIUM_SERVER_INSTALL_DIR="${CODIUM_SERVER_ROOT_DIR}/bin/${CODIUM_SERVER_COMMIT}"

# Platform info
CODIUM_ARCH=""
CODIUM_OS_ID=""
CODIUM_OS_PLATFORM="linux"

# Server state
CODIUM_DOWNLOAD_URL="UNSET_SET_LATER"
CODIUM_SERVER_TOKEN="ERR"
CODIUM_SERVER_PID="ERR"

function print_envs {
    echo "EXIT[[CODIUM_ARCH:${CODIUM_ARCH}]]";
    echo "EXIT[[CODIUM_OS_ID:${CODIUM_OS_ID}]]";
    echo "EXIT[[CODIUM_OS_PLATFORM:${CODIUM_OS_PLATFORM}]]";
    echo "EXIT[[CODIUM_DOWNLOAD_URL:${CODIUM_DOWNLOAD_URL}]]";
    echo "EXIT[[CODIUM_SERVER_COMMIT:${CODIUM_SERVER_COMMIT}]]";
    echo "EXIT[[CODIUM_SERVER_VERSION:${CODIUM_SERVER_VERSION}]]";
    echo "EXIT[[CODIUM_SERVER_ROOT_DIR:${CODIUM_SERVER_ROOT_DIR}]]";
    echo "EXIT[[CODIUM_SERVER_LAUNCH_CONFIG:${CODIUM_SERVER_LAUNCH_CONFIG}]]";
    echo "EXIT[[CODIUM_SERVER_LISTEN_PORT:${CODIUM_SERVER_LISTEN_PORT}]]";
    echo "EXIT[[CODIUM_FORCE_REINSTALL_SERVER:${CODIUM_FORCE_REINSTALL_SERVER}]]";
    echo "EXIT[[CODIUM_SHUTDOWN_ACTION:${CODIUM_SHUTDOWN_ACTION}]]";
    echo "EXIT[[CODIUM_SERVER_INSTALL_DIR:${CODIUM_SERVER_INSTALL_DIR}]]";
    echo "EXIT[[CODIUM_SERVER_TOKEN:${CODIUM_SERVER_TOKEN}]]";
    echo "EXIT[[CODIUM_SERVER_PID:${CODIUM_SERVER_PID}]]";
    echo "EXITCODE[[CODE:$1]]";
}

function print_envs_exit() {
    print_envs $1;
    exit $1;
}

EXIT_OK=0
UNSUPPORTED_PLATFORM=11
DEPENDENCIES_NOT_INSTALLED=12
SERVER_DOWNLOAD_FAILED=13
SERVER_INSTALL_FAILED=14
WRITE_STATE_FILES_FAILED=15
INSTALL_RETRIES_FAILED=16
INSTALL_LOCK_TIMEOUT=17
BAD_ARGS=20

function inspect_conatiner_platform() {
    if [[ -r /etc/os-release ]]; then
        CODIUM_OS_ID=$(source /etc/os-release && echo "${ID:-}")
    elif [[ -r /usr/lib/os-release ]]; then
        CODIUM_OS_ID=$(source /usr/lib/os-release && echo "${ID:-}")
    else
        echo "INSTALL_SCRIPT_WARN: Both /etc/os-release and /usr/lib/os-release were not found";
        # print_envs_exit "${UNSUPPORTED_PLATFORM}";
    fi

    case $(uname -m) in
        "x86_64"  | "amd64"  )  CODIUM_ARCH="x64"   ;;
        "armv7l"  | "armv8l" )  CODIUM_ARCH="armhf" ;;
        "aarch64" | "arm64"  )  CODIUM_ARCH="arm64" ;;
        "riscv64"     )  CODIUM_ARCH="riscv64"      ;;
        "ppc64le"     )  CODIUM_ARCH="ppc64le"      ;;
        "loongarch64" )  CODIUM_ARCH="loong64"      ;;
        "s390x"       )  CODIUM_ARCH="s390x"        ;;
        * ) {
            echo "INSTALL_SCRIPT_ERROR: Unsupported architecture $(uname -m)";
            print_envs_exit "${UNSUPPORTED_PLATFORM}";
        };;
    esac

    if [[ "${CODIUM_OS_ID}" == "alpine" ]]; then
        CODIUM_OS_PLATFORM=alpine;
        if [[ $(find /usr/lib -iname '*libstdc++*' | wc -l) -eq 0 ]]; then
            echo "INSTALL_SCRIPT_ERROR: alpine needs libstdc++ for codium. Install with 'apk add libstdc++'";
            print_envs_exit "${DEPENDENCIES_NOT_INSTALLED}";
        fi
    fi

    echo "INSTALL_SCRIPT_INFO: [[CODIUM_ARCH:$CODIUM_ARCH]]"
    echo "INSTALL_SCRIPT_INFO: [[CODIUM_OS_ID:$CODIUM_OS_ID]]"
    echo "INSTALL_SCRIPT_INFO: [[CODIUM_OS_PLATFORM:$CODIUM_OS_PLATFORM]]"
}

function test_deps() {
    if ! command -v curl &>/dev/null; then
        echo "INSTALL_SCRIPT_ERROR: 'curl' must be installed";
        print_envs_exit "${DEPENDENCIES_NOT_INSTALLED}";
    fi
    if ! command -v tar &>/dev/null; then
        echo "INSTALL_SCRIPT_ERROR: 'tar' not found";
        print_envs_exit "${DEPENDENCIES_NOT_INSTALLED}";
    fi
    if \
        ! command -v pgrep -f -- 'bash' &>/dev/null \
        || ! pgrep -f -- 'bash' &>/dev/null; \
    then
        echo "INSTALL_SCRIPT_ERROR: 'pgrep' not found or not functional";
        print_envs_exit "${DEPENDENCIES_NOT_INSTALLED}";
    fi
    if ! command -v xargs &>/dev/null; then
        echo "INSTALL_SCRIPT_ERROR: 'xargs' not found or not functional";
        print_envs_exit "${DEPENDENCIES_NOT_INSTALLED}";
    fi
}

function kill_server_and_remove_all() {
    # shouldn't reset token
    pgrep -f -- "codium-d[a]emon-monitor.*--daemon" | xargs -I{} -- bash -c 'kill -SIGINT -- -{} || kill -SIGINT -- {}' || true
    pgrep -f -- "--host [0].0.0.0 --port ${CODIUM_SERVER_LISTEN_PORT}" | xargs -I{} -- bash -c 'kill -SIGINT -- -{} || kill -SIGINT -- {}' || true
    sleep 3
    pgrep -f -- "codium-d[a]emon-monitor.*--daemon" | xargs -I{} -- bash -c 'kill -SIGKILL -- -{} || kill -SIGKILL -- {}' || true
    pgrep -f -- "--host [0].0.0.0 --port ${CODIUM_SERVER_LISTEN_PORT}" | xargs -I{} -- bash -c 'kill -SIGKILL -- -{} || kill -SIGKILL -- {}' || true
    rm -rf "${CODIUM_SERVER_ROOT_DIR}/bin"
    rm -f "${CODIUM_SERVER_ROOT_DIR}/${CODIUM_SERVER_COMMIT}."*
}

function download_server() {
    # to inject arch and os from the template string
    CODIUM_DOWNLOAD_URL="CODIUM_INJECT_DOWNLOAD_URL"
    DOWNLOAD_TIMEOUT=300 # in seconds, 5 minutes
    echo "INSTALL_SCRIPT_INFO: Downloading server from URL ${CODIUM_DOWNLOAD_URL} ..."

    # TODO: 10 for now because github downtime
    local CURL_ERR
    if CURL_ERR=$(curl -fsSL --retry 10 "${CODIUM_DOWNLOAD_URL}" --connect-timeout 10 --max-time ${DOWNLOAD_TIMEOUT} -o /tmp/codium.tar.gz 2>&1); then
        return 0;
    fi

    echo "INSTALL_SCRIPT_ERROR: Failed to download codium server: ${CURL_ERR}";
    print_envs_exit "${SERVER_DOWNLOAD_FAILED}";
}

function download_and_install_server() {
    if [[ ${CODIUM_FORCE_REINSTALL_SERVER} == "true" ]]; then
        kill_server_and_remove_all
    fi

    # test if server already exists
    if [[ -r "${CODIUM_SERVER_INSTALL_DIR}" && -r "${CODIUM_SERVER_INSTALL_DIR}/bin/codium-server" ]]; then
        echo "INSTALL_SCRIPT_INFO: Version vscodium-reh-linux-${CODIUM_ARCH}-${CODIUM_SERVER_VERSION} commit ${CODIUM_SERVER_COMMIT} already installed, skipping download"
        return 0;
    else
        echo "INSTALL_SCRIPT_INFO: Cleaning up old *.token, *.pid, *.log files if present"
        rm -f "${CODIUM_SERVER_ROOT_DIR}/${CODIUM_SERVER_COMMIT}."*
    fi

    download_server

    local MKDIR_ERR
    if ! MKDIR_ERR=$(mkdir -p "${CODIUM_SERVER_INSTALL_DIR}" 2>&1); then
        echo "INSTALL_SCRIPT_ERROR: Could not create '${CODIUM_SERVER_INSTALL_DIR}' directory: ${MKDIR_ERR}";
        print_envs_exit "${SERVER_INSTALL_FAILED}";
    fi

    local TAR_ERR
    if ! TAR_ERR=$(tar --strip-components 1 -xf /tmp/codium.tar.gz -C "${CODIUM_SERVER_INSTALL_DIR}" 2>&1); then
        echo "INSTALL_SCRIPT_ERROR: tar extract into '${CODIUM_SERVER_INSTALL_DIR}' failed: ${TAR_ERR}";
        print_envs_exit "${SERVER_INSTALL_FAILED}";
    fi

    if [[ ! -x "${CODIUM_SERVER_INSTALL_DIR}/bin/codium-server" || ! -x "${CODIUM_SERVER_INSTALL_DIR}/node" ]]; then
        kill_server_and_remove_all
        print_envs_exit "${SERVER_INSTALL_FAILED}"
    fi

    rm -f /tmp/codium.tar.gz || true
    ln -sf "${CODIUM_SERVER_INSTALL_DIR}/bin/remote-cli/codium" "${CODIUM_SERVER_INSTALL_DIR}/bin/remote-cli/code"
}

function start_codium_server() {
    # if MAIN=1 "${CODIUM_SERVER_INSTALL_DIR}/node"                           \
    #     --no-warnings "${CODIUM_SERVER_ROOT_DIR}/codium-daemon-monitor.ts"  \
    #     --config "${CODIUM_SERVER_LAUNCH_CONFIG}"                           \
    #     |& tee /tmp/codium-daemon-monitor-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n').log  \

    # Redirect to a file because the exec command that launches this script (from extension
    # code) needs to exit once the server is up. Monitor script can't tee/pipe as that keeps
    # this script's io open and needs to detach/daemonize. So log to a file and print that
    # on exit
    local MONITOR_OUT
    MONITOR_OUT=$(mktemp -p "${CODIUM_SERVER_ROOT_DIR}" codium-daemon-monitor-log-XXXXXX)
    local MONITOR_EXIT=0

    echo "INSTALL_SCRIPT_INFO: daemon start logfile: ${MONITOR_OUT}"

    MAIN=1 "${CODIUM_SERVER_INSTALL_DIR}/node"                              \
        --no-warnings "${CODIUM_SERVER_ROOT_DIR}/codium-daemon-monitor.ts"  \
        --config "${CODIUM_SERVER_LAUNCH_CONFIG}"                           \
        > "${MONITOR_OUT}" 2>&1 127>&- || MONITOR_EXIT=$?

    if [[ ${MONITOR_EXIT} -eq 0 ]]; then
        # warnings only, keep them visible
        cat "${MONITOR_OUT}" || true
        # TODO: keeping them makes it easier to check logs without relying on vscodium's
        # output window ... success, so eh ..., remove them I guess
        # mv "${MONITOR_OUT}" "${MONITOR_OUT}-old.log" || true
        rm -f "${MONITOR_OUT}" || true

        CODIUM_SERVER_TOKEN=$(cat "${CODIUM_SERVER_ROOT_DIR}/${CODIUM_SERVER_COMMIT}.token")
        CODIUM_SERVER_PID=$(pgrep -f -- 'codium-daemon-monitor.*--d[a]emon' | head -n 1 || true)
        print_envs_exit "${EXIT_OK}";
        return 0;
    else
        echo "INSTALL_SCRIPT_ERROR: codium-daemon-monitor exited with code ${MONITOR_EXIT}, saved to log ${MONITOR_OUT}"
        # TODO: keeping them makes it easier to check logs without relying on vscodium's
        # output window

        # Prepend INSTALL_SCRIPT_ERROR so the ts/extension side can regex-match all lines from this file
        # we might not have a log, so don't fail attempting to print the log
        sed '/^INSTALL_SCRIPT_/!s|^|INSTALL_SCRIPT_ERROR: |' "${MONITOR_OUT}" || true
        tail -n 100 "${CODIUM_SERVER_ROOT_DIR}/${CODIUM_SERVER_COMMIT}.log" \
           | sed '/^INSTALL_SCRIPT_/!s|^|INSTALL_SCRIPT_ERROR: |'           \
           || true

        mv "${MONITOR_OUT}" "${MONITOR_OUT}-old.log" || true
        echo "INSTALL_SCRIPT_ERROR: Log ${MONITOR_OUT} moved to ${MONITOR_OUT}-old.log"

        CODIUM_SERVER_TOKEN="ERR"
        CODIUM_SERVER_PID="ERR"
        print_envs_exit "${SERVER_INSTALL_FAILED}"
    fi
}

function wait_lock() {
    mkdir -p "${CODIUM_SERVER_ROOT_DIR}"
    # ah yes, space-sensitive
    exec 127<>"${CODIUM_SERVER_ROOT_DIR}/vscodium-install.lock"

    if timeout 120 flock 127; then
        trap 'flock -u 127' EXIT;
        printf '%s\n'           \
            "Hello there! 🔦"   \
            "This file exists to prevent multiple vscodium windows attempting"      \
            "to set up a devcontainer with vscodium-server at the same time from"   \
            "clobbering each other. It is safe to delete this file iff no active"   \
            "install, vscodium server, or daemon processes are running. Before"     \
            "removing this file, kill all server and daemon procs (codium-server,"  \
            "codium-daemon-monitor) and remove *.token and *.lock files."           \
        >& 127
        echo "INSTALL_SCRIPT_INFO: Install lock acquired";
    else
        echo "INSTALL_SCRIPT_WARN: Install lock timeout";
        print_envs_exit "${INSTALL_LOCK_TIMEOUT}";
        return 0;
    fi
}

test_deps
inspect_conatiner_platform
wait_lock
download_and_install_server
start_codium_server

echo "INSTALL_SCRIPT_INFO: SCRIPT_END"
