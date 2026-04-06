import { run, getTimeout } from "../ssh.js";
import type { NodeConfig, StatusPayload } from "../types.js";
import type { NodeCache } from "../nats/cache.js";

function formatCached(node: NodeConfig, data: StatusPayload, age: number): string {
  const lines = [`=== Node: ${node.name} (${node.host}) ===`, `[source: cache, age: ${age}s]\n`];

  lines.push(`=== NixOS Version ===\n${data.version}`);
  lines.push(`=== Uptime ===\n${data.uptime}`);
  lines.push(`=== Current Generation ===\n${data.generation}`);
  lines.push(`=== Memory ===\n  total: ${data.memory.total}  used: ${data.memory.used}  free: ${data.memory.free}  available: ${data.memory.available}`);
  lines.push(`=== Disk ===\n${data.disk.root}${data.disk.nix ? "\n" + data.disk.nix : ""}`);

  if (data.failedServices.length > 0) {
    lines.push(`=== Failed Services ===\n${data.failedServices.join("\n")}`);
  } else {
    lines.push(`=== Failed Services ===`);
  }

  lines.push(`=== K3s Status ===\n${data.k3s.active ? "active" : "inactive"}\n${data.k3s.nodes}`);

  return lines.join("\n");
}

export async function status(node: NodeConfig, cache?: NodeCache): Promise<string> {
  // Try cache first
  if (cache) {
    const cached = cache.getStatus(node.name);
    if (cached) {
      const age = cache.age(node.name);
      return formatCached(node, cached, age);
    }
  }

  // SSH fallback
  const timeout = getTimeout("status");
  const sourceTag = cache ? "[source: ssh (cache stale)]\n" : "";

  const commands = [
    "echo '=== NixOS Version ===' && nixos-version",
    "echo '=== Uptime ===' && uptime",
    "echo '=== Current Generation ===' && readlink /nix/var/nix/profiles/system",
    "echo '=== Memory ===' && free -h | head -3",
    "echo '=== Disk ===' && df -h / /nix 2>/dev/null | sort -u",
    "echo '=== Failed Services ===' && systemctl --failed --no-pager --no-legend 2>/dev/null || echo 'none'",
    "echo '=== K3s Status ===' && (systemctl is-active k3s 2>/dev/null && sudo k3s kubectl get nodes --no-headers 2>/dev/null || echo 'K3s not running or not accessible')",
  ];

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

  const lines = [`=== Node: ${node.name} (${node.host}) ===`, sourceTag];

  if (result.exitCode !== 0 && result.stderr) {
    lines.push(`Warnings:\n${result.stderr}`);
  }

  lines.push(result.stdout);
  return lines.join("\n");
}
