# Open Remote - Devcontainer

Devcontainer support for [VSCodium](https://github.com/VSCodium/vscodium). Build and connect to containers using Docker or Podman.

## Getting started

> [!Important]  
> You need to enable the proposed resolver API for this extension to work. 


```jsonc
{
    ...
    "enable-proposed-api": [
        "mythreyak.open-remote-devcontainer"
    ]
}
```

You can open this file by 
* **Preferences: Configure Runtime Arguments** from the command palette (`Ctrl+Shift+p`)
* `Ctrl+p`, paste `~/.vscode-oss/argv.json` to open the file.

## Commands

| Command | Description |
|---|---|
| **Open workspace in container** | Build (if needed) and connect |
| **Rebuild and reopen in container** | Force rebuild and reconnect |
| **Rebuild without cache and reopen in container** | Rebuild image from scratch and reconnect |
| **Show configuration (devcontainer.json)** | Open `devcontainer.json` |
| **Close remote (reopen locally)** | Disconnect and reopen on host |
| **Get engine version** | Show container engine version |
| **Show log file** | Open build/connection log |

## Settings

| Setting | Default | Description |
|---|---|---|
| `dev.containers.dockerPath` | `docker` | Container CLI path (`docker` or `podman`) |
| `dev.containers.extraArgs` | `[]` | Extra args passed before the subcommand (e.g. `["--root", "/custom/storage"]`) |
| `dev.containers.defaultExtensions` | `[]` | Extensions to install in every devcontainer |

## Not yet supported

These features are not supported, but might be added in the future. 

- Compose
- config: `features`
- config: `forwardPorts` / `portsAttributes`
- config: `customizations.vscode.settings`
- config: `shutdownAction` (parsed but not enforced)
- config: `hostRequirements`
- config: `waitFor`
- named config files `.devcontainer/<name>/devcontainer.json`
- devcontainer on a remote machine (wip!)

While this extension might work with `vscode`, it is not supported. 

## Acknowledgements

This project would not have been possible without the work of:

- [codium-devcontainer](https://github.com/DDorch/codium-devcontainer) by [@DDorch](https://github.com/DDorch) ([Open VSX](https://open-vsx.org/extension/DDorch/codium-devcontainer)): Original inspiration
- [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) by [@jeanp413](https://github.com/jeanp413) ([Open VSX](https://open-vsx.org/extension/jeanp413/open-remote-ssh)): Install script and server setup inspiration
- [vscode-remote-oss](https://github.com/xaberus/vscode-remote-oss) by [@xaberus](https://github.com/xaberus): Resolver API usage example
