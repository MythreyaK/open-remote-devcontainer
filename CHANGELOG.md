# Open Remote - Devcontainer: Changelog

## v0.7.2

- npm audit: bump fast-uri, qs
- update changelog

#### Misc:
- CI: update build script to publish changelog b/w tag releases

## v0.7.1

- forwardPort, onPostAttach, and config watcher activate after remote window fully loads. Fixes race conditions where ports don't correctly forward connections
- Better error messages for some actions

#### Dev: misc code refactor
Stability:
  - npm audit: bump js-yaml, nanoid
  - Harden environment variable parsing: filter invalid keys, shell noise. Improves stability
  - Misc code refactor (check github for full changes)

Prep for Remote-SSH:
  - Correctly chain remote authorities: enables devcontainer-on-SSH workflows
  - Filesystem operations now work transparently over remote connections (vscode.workspace.fs)
  - Simplified engine configuration: single unified settings query instead of scattered calls
  - Note: devcontainer over remote-ssh is **not** enabled/supported yet, wip

## v0.7.0

### Breaking changes

- **Settings keys renamed**: If you customized the container engine or extra args, update your settings:
  - `remote.devcontainer.engine` -> `dev.containers.dockerPath`
  - `remote.devcontainer.extraArgs` -> `dev.containers.extraArgs`

### New

- Add `forwardPorts` support: ports in `devcontainer.json` are forwarded automatically when container is ready
- Auto-detect listening ports in containers (`showCandidatePort` / `candidatePortSource`)
- Internal server port (65432) hidden from the 'Ports' panel
- Status bar remote indicator commands (open, rebuild, reopen locally)
- Command palette filtering: remote-only commands hidden in local sessions and vice versa
- Add `dev.containers.defaultExtensions` setting: extensions installed in every devcontainer

### Fixes

- `workspaceMount` is now optional (inferred from workspace path)
- Empty lifecycle command records no longer cause errors
