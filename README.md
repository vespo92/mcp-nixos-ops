# mcp-nixos-ops

MCP server for managing NixOS machines over SSH. Built for fleets, not toys.

## What it does

One MCP tool (`nixos_ops`) with 9 actions for remote NixOS management:

| Action | Safe | Description |
|---|---|---|
| `list-nodes` | Yes | Show configured nodes |
| `status` | Yes | Version, uptime, memory, disk, K3s, ZFS, failed services |
| `rebuild-dry` | Yes | `nixos-rebuild dry-build` — preview changes without applying |
| `validate` | Yes | Syntax check + evaluation check before you even dry-build |
| `zfs-preflight` | Yes | Verify pools are imported, healthy, not full |
| `generations` | Yes | List system generations with dates |
| `diff` | Yes | Package diff between current and pending config (nvd/nix-diff) |
| `rebuild-switch` | **No** | Apply config. 3 safety gates: node opt-in + confirm + ZFS preflight |
| `rollback` | **No** | Revert to previous generation. 2 safety gates: node opt-in + confirm |

## Why

AI assistants + `nixos-rebuild` = bricked machines. This server adds guardrails:

- **Dry-run first, always.** The tool descriptions guide LLMs to preview before applying.
- **ZFS auto-check.** `rebuild-switch` automatically runs ZFS preflight and blocks if pools are unhealthy or not imported (a real NixOS problem).
- **Flake-aware.** Never sends `--flake` unless the node config says `useFlake: true`. Mixing these up causes boot failures.
- **Explicit opt-in.** Destructive ops require both node-level config AND per-call confirmation.

## Performance

Uses SSH `ControlMaster` for persistent multiplexed connections:

| Scenario | Latency |
|---|---|
| First command (cold) | ~1s |
| Subsequent commands | **~60ms** |
| Via jump host (warm) | **~170ms** |
| 3 nodes in parallel | **~65ms total** |

Sockets persist for 10 minutes between calls. Faster than typing `ssh`.

## Jump host support

Nodes can route through another node. The jump host's ControlMaster socket is shared, so tunneled connections are nearly as fast as direct ones.

```json
{
  "name": "worker-3",
  "host": "198.51.100.13",
  "jumpHost": "bastion"
}
```

## Setup

### 1. Install

```bash
git clone https://github.com/vespo92/mcp-nixos-ops.git
cd mcp-nixos-ops
bun install
```

Requires [Bun](https://bun.sh) runtime.

### 2. Configure nodes

Create `~/.config/mcp-nixos/nodes.json`:

```json
[
  {
    "name": "node-1",
    "host": "198.51.100.10",
    "user": "admin",
    "sshKey": "~/.ssh/id_ed25519",
    "useFlake": false,
    "configPath": "/etc/nixos/configuration.nix",
    "zfsPools": ["tank"],
    "tags": ["control-plane"],
    "allowRebuildSwitch": false,
    "allowRollback": true
  },
  {
    "name": "node-2",
    "host": "198.51.100.11",
    "user": "admin",
    "sshKey": "~/.ssh/id_ed25519",
    "jumpHost": "node-1",
    "zfsPools": ["rpool"],
    "allowRebuildSwitch": false,
    "allowRollback": true
  }
]
```

Or set `MCP_NIXOS_NODES` env var with inline JSON or a file path.

### 3. Add to Claude Code

```json
{
  "mcpServers": {
    "nixos-ops": {
      "command": "bun",
      "args": ["run", "/path/to/mcp-nixos-ops/src/index.ts"]
    }
  }
}
```

### 4. Test

```
nixos_ops action=list-nodes
nixos_ops action=status node=node-1
nixos_ops action=zfs-preflight node=node-1
```

## Node config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Node identifier |
| `host` | string | required | SSH host (IP or hostname) |
| `user` | string | `"admin"` | SSH user |
| `port` | number | `22` | SSH port |
| `sshKey` | string | - | Path to SSH private key (`~` expanded) |
| `jumpHost` | string | - | Name of another node to use as SSH bastion |
| `useFlake` | boolean | `false` | Use `--flake` for nixos-rebuild |
| `configPath` | string | `/etc/nixos/configuration.nix` | Path to configuration.nix (classic mode) |
| `flakePath` | string | `/etc/nixos` | Path to flake directory (flake mode) |
| `zfsPools` | string[] | `[]` | ZFS pools to check in preflight |
| `tags` | string[] | `[]` | Arbitrary tags for filtering |
| `allowRebuildSwitch` | boolean | `false` | Allow `rebuild-switch` action |
| `allowRollback` | boolean | `true` | Allow `rollback` action |

## Environment variables

| Variable | Description |
|---|---|
| `MCP_NIXOS_NODES` | Inline JSON array of nodes, or path to config file |
| `MCP_NIXOS_CONFIG_PATH` | Override default config file location |
| `MCP_NIXOS_OPS_DEBUG` | Set to `1` for verbose stderr logging |

## Roadmap

- [ ] MQTT/NATS event bus for real-time node health streaming
- [ ] QoS-aware rebuild scheduling (don't rebuild under load)
- [ ] Fleet-wide operations (rebuild all workers, rolling upgrades)
- [ ] Generation pinning and boot entry management
- [ ] Config drift detection across nodes
- [ ] Integration with nixos-anywhere for zero-touch provisioning

## License

MIT
