import { run, getTimeout } from "../ssh.js";
import type { NodeConfig } from "../types.js";

export async function status(node: NodeConfig): Promise<string> {
  const timeout = getTimeout("status");

  // Run multiple status commands in a single SSH session via shell
  const commands = [
    "echo '=== NixOS Version ===' && nixos-version",
    "echo '=== Uptime ===' && uptime",
    "echo '=== Current Generation ===' && readlink /nix/var/nix/profiles/system",
    "echo '=== Memory ===' && free -h | head -3",
    "echo '=== Disk ===' && df -h / /nix 2>/dev/null | sort -u",
    "echo '=== Failed Services ===' && systemctl --failed --no-pager --no-legend 2>/dev/null || echo 'none'",
    "echo '=== K3s Status ===' && (systemctl is-active k3s 2>/dev/null && sudo k3s kubectl get nodes --no-headers 2>/dev/null || echo 'K3s not running or not accessible')",
  ];

  // Add ZFS pool status if configured
  if (node.zfsPools.length > 0) {
    commands.push(
      `echo '=== ZFS Pools ===' && sudo zpool list 2>/dev/null && echo '---' && sudo zpool status -x 2>/dev/null || echo 'ZFS not available'`
    );
  }

  const combined = commands.join(" && ");
  const result = await run(node, combined, timeout);

  if (result.timedOut) {
    return `[${node.name}] Status check timed out after ${timeout / 1000}s`;
  }

  const lines = [`=== Node: ${node.name} (${node.host}) ===`];

  if (result.exitCode !== 0 && result.stderr) {
    lines.push(`\nWarnings:\n${result.stderr}`);
  }

  lines.push(result.stdout);
  return lines.join("\n");
}
