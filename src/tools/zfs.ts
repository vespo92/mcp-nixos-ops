import { run, getTimeout } from "../ssh.js";
import type { NodeConfig } from "../types.js";

export async function zfsPreflight(node: NodeConfig): Promise<string> {
  const timeout = getTimeout("zfs-preflight");
  const lines = [`=== ZFS Preflight: ${node.name} ===`];

  if (node.zfsPools.length === 0) {
    lines.push("No ZFS pools configured for this node.");
    return lines.join("\n");
  }

  lines.push(`Configured pools: ${node.zfsPools.join(", ")}`);

  for (const pool of node.zfsPools) {
    lines.push(`\n--- Pool: ${pool} ---`);

    // Check if pool is imported
    const listResult = await run(
      node,
      `sudo zpool list ${pool} 2>&1`,
      timeout
    );

    if (
      listResult.exitCode !== 0 ||
      listResult.stdout.includes("no such pool") ||
      listResult.stderr.includes("no such pool")
    ) {
      lines.push(`Status: NOT IMPORTED`);
      lines.push(
        `ERROR: Pool "${pool}" is not imported. Run 'sudo zpool import ${pool}' to import it.`
      );
      continue;
    }

    // Parse pool list output (NAME SIZE ALLOC FREE ... HEALTH ...)
    const listLines = listResult.stdout.split("\n").filter((l) => l.trim());
    if (listLines.length >= 2) {
      lines.push(`List: ${listLines[1].trim()}`);
    }

    // Health check
    const healthResult = await run(
      node,
      `sudo zpool status -x ${pool} 2>&1`,
      timeout
    );

    if (healthResult.stdout.includes("is healthy")) {
      lines.push(`Health: ONLINE (healthy)`);
    } else {
      lines.push(`Health: ${healthResult.stdout}`);
    }

    // Detailed status for scrub info
    const statusResult = await run(
      node,
      `sudo zpool status ${pool} 2>&1 | grep -E '(scan:|scrub|state:)' | head -5`,
      timeout
    );
    if (statusResult.stdout) {
      lines.push(`Details:\n${statusResult.stdout}`);
    }

    // Usage
    const usageResult = await run(
      node,
      `sudo zpool list -H -o name,size,alloc,free,cap,health ${pool} 2>&1`,
      timeout
    );
    if (usageResult.exitCode === 0 && usageResult.stdout) {
      const parts = usageResult.stdout.split(/\s+/);
      if (parts.length >= 6) {
        lines.push(
          `Usage: ${parts[2]} used of ${parts[1]} (${parts[4]} capacity), ${parts[3]} free`
        );

        // Warn if capacity is high
        const capNum = parseInt(parts[4], 10);
        if (!isNaN(capNum) && capNum >= 85) {
          lines.push(`WARNING: Pool capacity is at ${capNum}% - consider freeing space`);
        }
      }
    }

    // Dataset list
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
