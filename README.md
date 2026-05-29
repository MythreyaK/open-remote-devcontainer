# Open Remote - Devcontainer

Pre-0.5.0, the extension relied on an SSH server inside the container via [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) by [@jeanp413](https://github.com/jeanp413).

From `0.5.0` onwards, the VS Code proposed resolver API is used and must be enabled in `argv.json`.

## How it works

1. Reads `.devcontainer/devcontainer.json` from your workspace
2. Builds a container image from the specified `image` or `dockerFile`
3. Starts the container with your workspace bind-mounted
4. Installs the VSCodium Remote Extension Host (`vscodium-reh`) inside the container
5. Connects via a direct TCP tunnel (no SSH)

## Getting started

1. Install the extension
2. Enable the proposed resolver API
3. Create `.devcontainer/devcontainer.json` in your project (or use **Devcontainer: Add Dockerfile Template**)
4. Run **Devcontainer: Open Folder in container** from the command palette

```
{
    ...
    "enable-proposed-api": [
        ...,
        "mythreyak.open-remote-devcontainer",
    ]
    ...
}
```

You can configure this by running the **Preferences: Configure Runtime Arguments** command. The file is located in `~/.vscode-oss/argv.json`.

## Supported devcontainer.json fields

| Field | Status |
|---|---|
| `image` | Supported |
| `dockerFile` | Supported |
| `remoteUser` | Supported |
| `postCreateCommand` | Supported (runs as `RUN` during image build) |
| `postStartCommand` | Supported (runs in terminal after connect) |
| `mounts` | Supported (string and object format, with custom `options` for SELinux `:z`/`:Z`) |
| `runArgs` | Supported (passed through to `docker run`) |
| `${localEnv:VAR}` | Supported in mounts, runArgs, and lifecycle commands |
| `features` | Not yet |
| `forwardPorts` | Not yet |


## Commands

- **Devcontainer: Open Folder in container** — build (if needed) and connect
- **Devcontainer: Rebuild & reopen in container** — force rebuild and reconnect
- **Devcontainer: Open Devcontainer Configuration** — open `devcontainer.json`
- **Devcontainer: Add Dockerfile Template** — scaffold `.devcontainer/Dockerfile`
- **Devcontainer: Rebuild without cache & reopen in container** — rebuild image from scratch and reconnect
- **Devcontainer: Show Log** — open build/connection logs (WIP)
- **Devcontainer: Reopen Folder Locally** — disconnect and reopen on host
- **Devcontainer: Show Actions** — quick pick menu for all commands

## Settings

| Setting | Default | Description |
|---|---|---|
| `remote.devcontainer.containerBinary` | `docker` | Container CLI (`docker` or `podman`) |
| `remote.devcontainer.containerExtraArgs` | `[]` | Extra args passed before the subcommand (e.g. `["--root", "/custom/storage"]`) |

## Development

```sh
npm install
npm run dts          # generate vscode type definitions
npm run compile      # type check + build
npm test             # run unit tests
npm run format       # auto-format with biome
npm run lint         # lint check
```

### Reproducible builds

To validate a release, checkout the commit and run

```shell
$ SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) TZ=UTC   \
    npm run vsce:package                                \
    && sha256sum *.vsix
```

and compare against the `*.sha` on the releases page. For pre-releases, use `npm run vsce:package -- --pre-release` instead. 

## Acknowledgements

This project would not have been possible without the work of:

- [codium-devcontainer](https://github.com/DDorch/codium-devcontainer) by [@DDorch](https://github.com/DDorch) ([Open VSX](https://open-vsx.org/extension/DDorch/codium-devcontainer)): the original devcontainer extension this project forked from
- [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) by [@jeanp413](https://github.com/jeanp413) ([Open VSX](https://open-vsx.org/extension/jeanp413/open-remote-ssh)): the server installer and remote authority resolver are adapted from this extension
- [@xaberus](https://github.com/xaberus) — [vscode-remote-oss](https://github.com/xaberus/vscode-remote-oss): reference for remote development on OSS builds of VS Code

## Disclaimer

Claude and Opencode were used for the initial prototyping using the above implementations as references. A rewrite will (probably) come soon.
