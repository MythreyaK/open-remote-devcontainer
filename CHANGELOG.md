# Open Remote - Devcontainer: Changelog

## 0.7.0

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
