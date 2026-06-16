#!/usr/bin/env bash

#_CODIUM_INJECT_DEBUG_SET_X
set -e
set -o pipefail

# CODIUM_INJECT_* are injected from extension via replacement

CODIUM_ARCH=""
CODIUM_OS_ID=""
CODIUM_OS_PLATFORM="linux"
# CODIUM_SERVER_ROOT_DIR="CODIUM_INJECT_SERVER_ROOT_DIR"
# CODIUM_SERVER_ROOT_DIR="${HOME}/.vscode-oss-devcontainer/CODIUM_INJECT_SERVER_COMMIT"
CODIUM_SERVER_ROOT_DIR="${HOME}/.vscode-oss-devcontainer"
CODIUM_VERSION_FILE="${CODIUM_SERVER_ROOT_DIR}/version"

CODIUM_INSTALLED_VERSION=""
CODIUM_DOWNLOAD_URL=""
CODIUM_NEW_INSTALL_VERSION="CODIUM_INJECT_CODIUM_INSTALL_VERSION"
CODIUM_SERVER_LISTEN_PORT="CODIUM_INJECT_SERVER_LISTEN_PORT"
# CODIUM_TOKEN_FILE_PATH="CODIUM_INJECT_TOKEN_FILE_PATH"
CODIUM_TOKEN_FILE_PATH="${CODIUM_SERVER_ROOT_DIR}/token"
CODIUM_TOKEN="CODIUM_INJECT_TOKEN_VALUE"
# CODIUM_SERVER_PID_FILE_PATH="CODIUM_INJECT_SERVER_PID_FILE"
CODIUM_SERVER_PID_FILE_PATH="${CODIUM_SERVER_ROOT_DIR}/codium.pid"
CODIUM_SERVER_PID=""
# CODIUM_LOG_FILE_PATH="CODIUM_INJECT_LOG_FILE_PATH"
CODIUM_LOG_FILE_PATH="${CODIUM_SERVER_ROOT_DIR}/log.out"
CODIUM_FORCE_REINSTALL_SERVER="CODIUM_INJECT_FORCE_REINSTALL_SERVER"

function print_envs {
    echo "EXIT[[CODIUM_ARCH:${CODIUM_ARCH}]]";
    echo "EXIT[[CODIUM_OS_ID:${CODIUM_OS_ID}]]";
    echo "EXIT[[CODIUM_OS_PLATFORM:${CODIUM_OS_PLATFORM}]]";
    echo "EXIT[[CODIUM_SERVER_ROOT_DIR:${CODIUM_SERVER_ROOT_DIR}]]";
    echo "EXIT[[CODIUM_VERSION_FILE:${CODIUM_VERSION_FILE}]]";
    echo "EXIT[[CODIUM_INSTALLED_VERSION:${CODIUM_INSTALLED_VERSION}]]";
    echo "EXIT[[CODIUM_DOWNLOAD_URL:${CODIUM_DOWNLOAD_URL}]]";
    echo "EXIT[[CODIUM_NEW_INSTALL_VERSION:${CODIUM_NEW_INSTALL_VERSION}]]";
    echo "EXIT[[CODIUM_SERVER_LISTEN_PORT:${CODIUM_SERVER_LISTEN_PORT}]]";
    echo "EXIT[[CODIUM_TOKEN_FILE_PATH:${CODIUM_TOKEN_FILE_PATH}]]";
    echo "EXIT[[CODIUM_TOKEN:${CODIUM_TOKEN}]]";
    echo "EXIT[[CODIUM_SERVER_PID_FILE_PATH:${CODIUM_SERVER_PID_FILE_PATH}]]";
    echo "EXIT[[CODIUM_SERVER_PID:${CODIUM_SERVER_PID}]]";
    echo "EXIT[[CODIUM_LOG_FILE_PATH:${CODIUM_LOG_FILE_PATH}]]";
    echo "EXITCODE[[CODE:$1]]";
}

function print_envs_exit() {
    print_envs $1;
    exit $1;
}

UNSUPPORTED_PLATFORM=1
DEPS_CHECK_FAILED=2
SERVER_DOWNLOAD_FAILED=3
SERVER_INSTALL_FAILED=4
WRITE_STATE_FILES_FAILED=5
INSTALL_RETRIES_FAILED=6
BAD_ARGS=20

# TODO: Multiple sessions to the same container?

function inspect_conatiner_platform() {
    if [[ -r /etc/os-release ]]; then
        CODIUM_OS_ID=$(source /etc/os-release && echo "$ID")
    elif [[ -r /usr/lib/os-release ]]; then
        CODIUM_OS_ID=$(source /usr/lib/os-release && echo "$ID")
    else
        echo "INSTALL_SCRIPT_WARN: Both /etc/os-release and /usr/lib/os-release were not found";
        # print_envs_exit ${UNSUPPORTED_PLATFORM};
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
            print_envs_exit ${UNSUPPORTED_PLATFORM};
        };;
    esac

    if [[ "${CODIUM_OS_ID}" == "alpine" ]]; then
        CODIUM_OS_PLATFORM=alpine;
        if [[ $(find /usr/lib -iname '*libstdc++*' | wc -l) -eq 0 ]]; then
            echo "INSTALL_SCRIPT_ERROR: alpine needs libstdc++ for codium. Install with 'apk add libstdc++'";
            print_envs_exit ${DEPS_CHECK_FAILED};
        fi
    fi

    echo "INSTALL_SCRIPT_INFO: [[CODIUM_ARCH:$CODIUM_ARCH]]"
    echo "INSTALL_SCRIPT_INFO: [[CODIUM_OS_ID:$CODIUM_OS_ID]]"
    echo "INSTALL_SCRIPT_INFO: [[CODIUM_OS_PLATFORM:$CODIUM_OS_PLATFORM]]"
}

function test_deps() {
    if ! command -v curl &>/dev/null; then
        echo "INSTALL_SCRIPT_ERROR: 'curl' must be installed";
        print_envs_exit ${DEPS_CHECK_FAILED};
    fi
    if ! command -v tar &>/dev/null; then
        echo "INSTALL_SCRIPT_ERROR: 'tar' not found";
        print_envs_exit ${DEPS_CHECK_FAILED};
    fi
}

function kill_server_and_remove_server_state() {
    CODIUM_SERVER_PID=""
    # shouldn't reset token
    pkill -f -- "--host 0.0.0.0 --port ${CODIUM_SERVER_LISTEN_PORT}" || true
    sleep 3
    pkill -9 -f -- "--host 0.0.0.0 --port ${CODIUM_SERVER_LISTEN_PORT}" || true
    rm -f "${CODIUM_TOKEN_FILE_PATH}" "${CODIUM_SERVER_PID_FILE_PATH}"
}

function kill_server_and_remove_all() {
    kill_server_and_remove_server_state
    rm -rf "${CODIUM_SERVER_ROOT_DIR}"
}

function download_server() {
    DOWNLOAD_TIMEOUT=300 # in seconds, 5 minutes
    echo "INSTALL_SCRIPT_INFO: Downloading server from URL ${CODIUM_DOWNLOAD_URL} ..."

    # TODO: 10 for now because github downtime
    if curl -fsSL --retry 10 "${CODIUM_DOWNLOAD_URL}" --connect-timeout 10 --max-time ${DOWNLOAD_TIMEOUT} -o /tmp/codium.tar.gz; then
        return 0;
    fi

    print_envs_exit ${SERVER_DOWNLOAD_FAILED};
}

function download_and_install_server() {
    CODIUM_DOWNLOAD_URL="CODIUM_INJECT_DOWNLOAD_URL"

    if [[ ${CODIUM_FORCE_REINSTALL_SERVER} == "true" ]]; then
        kill_server_and_remove_all
    fi

    # test if server already exists
    if [[ -r "${CODIUM_SERVER_ROOT_DIR}" && -r "${CODIUM_VERSION_FILE}" ]]; then
        source "${CODIUM_VERSION_FILE}"
        echo "INSTALL_SCRIPT_INFO: Existing codium server version: ${CODIUM_INSTALLED_VERSION}"

        # check if version is the same
        if [[ "${CODIUM_INSTALLED_VERSION}" != "${CODIUM_NEW_INSTALL_VERSION}" ]]; then
            echo "INSTALL_SCRIPT_INFO: Existing version ${CODIUM_INSTALLED_VERSION} != ${CODIUM_NEW_INSTALL_VERSION}"
            # if not, nuke the dir and reinstall
            kill_server_and_remove_all
            CODIUM_INSTALLED_VERSION=""
        else
            # else, versions are same, return
            echo "INSTALL_SCRIPT_INFO: Version vscodium-reh-linux-${CODIUM_ARCH}-${CODIUM_INSTALLED_VERSION} already installed, skipping download"
            return 0;
        fi
    fi

    download_server

    if ! mkdir -p "${CODIUM_SERVER_ROOT_DIR}"; then
        echo "INSTALL_SCRIPT_ERROR: Could not create '${CODIUM_SERVER_ROOT_DIR}' directory";
        print_envs_exit ${SERVER_INSTALL_FAILED};
    fi

    if ! tar --strip-components 1 -xf /tmp/codium.tar.gz -C "${CODIUM_SERVER_ROOT_DIR}"; then
        echo "INSTALL_SCRIPT_ERROR: tar extract into '${CODIUM_SERVER_ROOT_DIR}' failed";
        print_envs_exit ${SERVER_INSTALL_FAILED};
    fi

    if [[ ! -x "${CODIUM_SERVER_ROOT_DIR}/bin/codium-server" ]]; then
        rm -rf "${CODIUM_SERVER_ROOT_DIR}"
        print_envs_exit ${SERVER_INSTALL_FAILED}
    fi

    echo "CODIUM_INSTALLED_VERSION=${CODIUM_NEW_INSTALL_VERSION}" > "${CODIUM_VERSION_FILE}"
    source "${CODIUM_VERSION_FILE}"

    rm -f /tmp/codium.tar.gz || true
}

function wait_for_server_running() {
    local MAX_CONNECT_RETRY_COUNT=15
    local COUNTER=0

    while [[ ${COUNTER} -lt ${MAX_CONNECT_RETRY_COUNT} ]]; do
        if curl -s "http://localhost:${CODIUM_SERVER_LISTEN_PORT}/version" >/dev/null 2>&1; then
            return 0;
        fi
        sleep 1;
        COUNTER=$((COUNTER+1));
    done;
    return 1;
}

function start_codium_server() {
    local MAX_RETRIES=3
    local RETRIES=0

    while [[ $RETRIES -lt $MAX_RETRIES ]]; do

        touch -a "${CODIUM_LOG_FILE_PATH}" "${CODIUM_TOKEN_FILE_PATH}" "${CODIUM_SERVER_PID_FILE_PATH}" || true
        chmod 600 "${CODIUM_TOKEN_FILE_PATH}"

        # ensure we can write to these files
        if [[ \
            ! -f "${CODIUM_LOG_FILE_PATH}"         || ! -w "${CODIUM_LOG_FILE_PATH}"       || \
            ! -f "${CODIUM_TOKEN_FILE_PATH}"       || ! -w "${CODIUM_TOKEN_FILE_PATH}"     || \
            ! -f "${CODIUM_SERVER_PID_FILE_PATH}"  || ! -w "${CODIUM_SERVER_PID_FILE_PATH}"  \
        ]]; then
            echo "INSTALL_SCRIPT_ERROR: Cannot write to '${CODIUM_TOKEN_FILE_PATH}' or '${CODIUM_SERVER_PID_FILE_PATH}', exiting";
            print_envs_exit ${WRITE_STATE_FILES_FAILED};
        fi

        NUM_PIDS=$(ps -o pid,args | grep -i -- "--host 0.0.0.0 --port ${CODIUM_SERVER_LISTEN_PORT}" | grep -vc grep || true)

        if [[ ${NUM_PIDS} -ge 2 ]] && wait_for_server_running; then
            echo "INSTALL_SCRIPT_INFO: Server already running ...";

            if [[ -r "${CODIUM_TOKEN_FILE_PATH}" && -r "${CODIUM_SERVER_PID_FILE_PATH}" ]]; then
                CODIUM_SERVER_PID=$(cat "${CODIUM_SERVER_PID_FILE_PATH}");
                CODIUM_TOKEN=$(cat "${CODIUM_TOKEN_FILE_PATH}");
                # ensure_server_running
                echo "INSTALL_SCRIPT_INFO: Server already running with [[PID:${CODIUM_SERVER_PID}]] and [[token:${CODIUM_TOKEN}]]"
                print_envs 0;
                return 0;
            else
                echo "INSTALL_SCRIPT_WARN: Could not read token or pid file, attempting restart";
                kill_server_and_remove_server_state
                RETRIES=$((RETRIES+1))
                continue;
            fi
        else
            echo "INSTALL_SCRIPT_INFO: Starting server ..."
            echo "${CODIUM_TOKEN}" > "${CODIUM_TOKEN_FILE_PATH}"
            CMD=(
                "${CODIUM_SERVER_ROOT_DIR}/bin/codium-server"
                --start-server
                --host "0.0.0.0"
                --port "${CODIUM_SERVER_LISTEN_PORT}"
                --enable-remote-auto-shutdown
                --accept-server-license-terms
                --telemetry-level off
                --server-data-dir "${CODIUM_SERVER_ROOT_DIR}"
                CODIUM_INJECT_INSTALL_EXTENSIONS
                --connection-token-file "${CODIUM_TOKEN_FILE_PATH}"
            )

            echo "INSTALL_SCRIPT_INFO: Starting server [${CMD[*]} &> ${CODIUM_LOG_FILE_PATH}] ... "

            # start server and wait
            "${CMD[@]}" &> "${CODIUM_LOG_FILE_PATH}" &
            _CODIUM_SERVER_PID=$!

            if wait_for_server_running; then
                CODIUM_SERVER_PID=${_CODIUM_SERVER_PID}
                echo "${CODIUM_SERVER_PID}" > "${CODIUM_SERVER_PID_FILE_PATH}"
                # token set before server start
                # ensure_server_running
                print_envs 0;
                return 0;
            else
                kill_server_and_remove_server_state
                RETRIES=$((RETRIES+1))
                continue;
            fi
        fi
    done;
    echo "INSTALL_SCRIPT_ERROR: Max retries reached, could not start server"
    print_envs_exit ${INSTALL_RETRIES_FAILED};
}

# CODIUM_PRE_DOWNLOAD_ENVS="CODIUM_INJECT_PRE_DOWNLOAD_ENVS"
test_deps
inspect_conatiner_platform
download_and_install_server

# CODIUM_POST_DOWNLOAD_ENVS="CODIUM_INJECT_POST_DOWNLOAD_ENVS"

#_CODIUM_INJECT_SERVER_LAUNCH_ENVS
start_codium_server


echo "INSTALL_SCRIPT_INFO: SCRIPT_END"
