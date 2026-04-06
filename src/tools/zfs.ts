import { run, getTimeout } from "../ssh.js";
import type { NodeConfig, ZfsPayload } from "../types.js";
import type { NodeCache } from "../nats/cache.js";

function formatCached(node: NodeConfig, data: ZfsPayload, age: number): string {
  const lines = [`=== ZFS Preflight: ${node.name} ===`, `[source: cache, age: ${age}s]`];
  lines.push(`Configured pools: ${node.zfsPools.join(", ")}`);

  for (const pool of data.pools) {
    lines.push(`\n--- Pool: ${pool.name} ---`);

    if (!pool.imported) {
      lines.push(`Status: NOT IMPORTED`);
      lines.push(`ERROR: Pool "${pool.name}" is not imported.`);
      continue;
    }

    lines.push(`Health: ${pool.health}`);
    lines.push(`Usage: ${pool.alloc} used of ${pool.size} (${pool.capacityPct}%), ${pool.free} free`);

    if (pool.capacityPct >= 85) {
      lines.push(`WARNING: Pool capacity at ${pool.capacityPct}%`);
    }

    if (pool.scrub) {
      lines.push(`Scrub: ${pool.scrub}`);
    }
  }

  if (data.datasets) {
    lines.push(`\nDatasets:\n${data.datasets}`);
  }

  return lines.join("\n");
}

export async function zfsPreflight(node: NodeConfig, cache?: NodeCache): Promise<string> {
  // Try cache first
  if (cache) {
    const cached = cache.getZfs(node.name);
    if (cached) {
      const age = cache.age(node.name);
      return formatCached(node, cached, age);
    }
  }

  // SSH fallback
  const timeout = getTimeout("zfs-preflight");
  const sourceTag = cache ? "[source: ssh (cache stale)]\n" : "";
  const lines = [`=== ZFS Preflight: ${node.name} ===`, sourceTag];

  if (node.zfsPools.length === 0) {
    lines.push("No ZFS pools configured for this node.");
    return lines.join("\n");
  }

  lines.push(`Configured pools: ${node.zfsPools.join(", ")}`);

  for (const pool of node.zfsPools) {
    lines.push(`\n--- Pool: ${pool} ---`);

    const listResult = await run(node, `sudo zpool list ${pool} 2>&1`, timeout);

    if (
      listResult.exitCode !== 0 ||
      listResult.stdout.includes("no such pool") ||
      listResult.stderr.includes("no such pool")
    ) {
      lines.push(`Status: NOT IMPORTED`);
      lines.push(`ERROR: Pool "${pool}" is not imported. Run 'sudo zpool import ${pool}'`);
      continue;
    }

    const listLines = listResult.stdout.split("\n").filter((l) => l.trim());
    if (listLines.length >= 2) {
      lines.push(`List: ${listLines[1].trim()}`);
    }

    const healthResult = await run(node, `sudo zpool status -x ${pool} 2>&1`, timeout);
    if (healthResult.stdout.includes("is healthy")) {
      lines.push(`Health: ONLINE (healthy)`);
    } else {
      lines.push(`Health: ${healthResult.stdout}`);
    }

    const statusResult = await run(
      node,
      `sudo zpool status ${pool} 2>&1 | grep -E '(scan:|scrub|state:)' | head -5`,
      timeout
    );
    if (statusResult.stdout) {
      lines.push(`Details:\n${statusResult.stdout}`);
    }

    const usageResult = await run(
      node,
      `sudo zpool list -H -o name,size,alloc,free,cap,health ${pool} 2>&1`,
      timeout
    );
    if (usageResult.exitCode === 0 && usageResult.stdout) {
      const parts = usageResult.stdout.split(/\s+/);
      if (parts.length >= 6) {
        lines.push(`Usage: ${parts[2]} used of ${parts[1]} (${parts[4]} capacity), ${parts[3]} free`);
        const capNum = parseInt(parts[4], 10);
        if (!isNaN(capNum) && capNum >= 85) {
          lines.push(`WARNING: Pool capacity is at ${capNum}% - consider freeing space`);
        }
      }
    }

    const dsResult = await run(
      node,
      `sudo zfs list -r -o name,used,avail,mountpoint ${pool} 2>&1 | head -20`,
      timeout
    );
    if (dsResult.exitCode === 0 && dsResult.stdout) {
      lines.push(`\nDatasets:\n${dsResult.stdout}`);
    }
  }

  return lines.join("\n");
}
