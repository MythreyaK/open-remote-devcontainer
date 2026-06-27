ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG HOST_UID=1000
ARG HOST_GID=1000
ARG HOST_USERNAME=user

SHELL [ "/bin/sh", "-c" ]

USER root

RUN set -e;                                     \
OS_ID=$(. /etc/os-release && echo "$ID");       \
if [ "$OS_ID" = "alpine" ]; then                \
    apk add bash curl shadow libstdc++;         \
elif [ "$OS_ID" = "ubuntu" ]; then              \
    apt update -y && apt install -y curl;       \
elif [ "$OS_ID" = "fedora" ]; then              \
    dnf install -y curl;                        \
fi;                                             \
#                                               \
if [ "${HOST_USERNAME}" = "root" ]; then                                                                    \
    echo "{{DEVCONTAINER_STAGE2 WARNING: Using user root. May cause permission issues.}}" 1>&2;             \
    exit 0;                                                                                                 \
fi;                                                                                                         \
if getent passwd "${HOST_USERNAME}" > /dev/null; then                                                       \
    EXISTING_UID=$(id -u "${HOST_USERNAME}");                                                               \
    echo "User '${HOST_USERNAME}' exists, updating UID from ${EXISTING_UID} to '${HOST_UID}'";              \
    #                                                                                                       \
    # if HOST_UID already exists, (but, obviously, with different username)                                 \
    # move that user to a new ID and update HOST_USERNAME's uid to HOST_UID                                 \
    EXISTING_USERNAME=$(getent passwd "${HOST_UID}" | cut -d: -f1 || true);                                 \
    if [ -n "${EXISTING_USERNAME}" ] && [ "${EXISTING_USERNAME}" != "${HOST_USERNAME}" ]; then              \
        NEW_UID=$((${HOST_UID}+1234));                                                                      \
        if getent passwd "${NEW_UID}" > /dev/null; then                                                     \
            echo "{{ERROR: Not attempting to resolve user UID/GID fixup. Please fix it in a Dockerfile}}";  \
            exit 1;                                                                                         \
        fi;                                                                                                 \
        echo "User '${EXISTING_USERNAME}' with ID '${HOST_UID}' already exists. Moving to '${NEW_UID}'";    \
        usermod -u "${NEW_UID}" "${EXISTING_USERNAME}";                                                     \
    fi;                                                                                                     \
    #                                                                                                       \
    usermod -u "${HOST_UID}" "${HOST_USERNAME}";                                                            \
    #                                                                                                       \
    # if group id exists, make that the user's primary group                                                \
    if getent group "${HOST_GID}" > /dev/null; then                                                         \
        usermod -g "${HOST_GID}" "${HOST_USERNAME}";                                                        \
    else                                                                                                    \
        # gid doesn't exist, but name does                                                                  \
        # create a new group with a new name and add user to that group                                     \
        if getent group "${HOST_USERNAME}" > /dev/null; then                                                \
            groupadd -g "${HOST_GID}" "${HOST_USERNAME}_x";                                                 \
        else                                                                                                \
            # both gid and name don't exist                                                                 \
            # add a group and make that the user's primary group                                            \
            groupadd -g "${HOST_GID}" "${HOST_USERNAME}";                                                   \
        fi;                                                                                                 \
        # update user's primary gid                                                                         \
        usermod -g "${HOST_GID}" "${HOST_USERNAME}";                                                        \
    fi;                                                                                                     \
    #                                                                                                       \
    USER_HOMEDIR=$(getent passwd "${HOST_USERNAME}" | cut -d: -f6);                                         \
    if [ -n "${USER_HOMEDIR}" ]; then                                                                       \
        mkdir -p "${USER_HOMEDIR}";                                                                         \
        chown -R "${HOST_UID}:${HOST_GID}" "${USER_HOMEDIR}";                                               \
    fi;                                                                                                     \
else                                                                                                        \
    echo "{{DEVCONTAINER_STAGE2 ERROR: User '${HOST_USERNAME}' does not exist in container}}" 1>&2;           \
    exit 1;                                                                                                 \
fi;                                                                                                         \
id "${HOST_USERNAME}";                                                                                      \
echo "Done";

