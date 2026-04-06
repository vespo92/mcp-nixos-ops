import { run, getTimeout } from "../ssh.js";
import type { NodeConfig } from "../types.js";
import { zfsPreflight } from "./zfs.js";

function rebuildCmd(node: NodeConfig, action: "dry-build" | "switch"): string {
  if (node.useFlake) {
    return `sudo nixos-rebuild ${action} --flake ${node.flakePath}#${node.name}`;
  }
  return `sudo nixos-rebuild ${action} --no-flake`;
}

export async function rebuildDry(node: NodeConfig): Promise<string> {
  const timeout = getTimeout("rebuild-dry");
  const cmd = rebuildCmd(node, "dry-build");

  const result = await run(node, cmd, timeout);

  const lines = [`=== Dry Build: ${node.name} ===`, `Command: ${cmd}`];

  if (result.timedOut) {
    lines.push(`\nTIMED OUT after ${timeout / 1000}s`);
    lines.push(`Partial stdout:\n${result.stdout}`);
  } else if (result.exitCode !== 0) {
    lines.push(`\nFAILED (exit code ${result.exitCode})`);
    lines.push(`stdout:\n${result.stdout}`);
    lines.push(`stderr:\n${result.stderr}`);
  } else {
    lines.push(`\nSUCCESS`);
    lines.push(result.stdout);
    if (result.stderr) {
      lines.push(`\nstderr (warnings):\n${result.stderr}`);
    }
  }

  return lines.join("\n");
}

export async function rebuildSwitch(
  node: NodeConfig,
  confirm: boolean
): Promise<string> {
  // Gate 1: node permission
  if (!node.allowRebuildSwitch) {
    return `BLOCKED: Node "${node.name}" has allowRebuildSwitch=false. This is a safety setting in the node inventory. Change it in the config file if you are certain this node is safe to rebuild.`;
  }

  // Gate 2: explicit confirmation
  if (!confirm) {
    return `BLOCKED: rebuild-switch is a DESTRUCTIVE operation. You must pass confirm=true to proceed. This will activate a new NixOS configuration on ${node.name}.`;
  }

  // Gate 3: ZFS preflight
  if (node.zfsPools.length > 0) {
    const zfsResult = await zfsPreflight(node);
    const hasUnhealthy =
      zfsResult.includes("NOT IMPORTED") ||
      zfsResult.includes("DEGRADED") ||
      zfsResult.includes("FAULTED") ||
      zfsResult.includes("UNAVAIL") ||
      zfsResult.includes("OFFLINE");

    if (hasUnhealthy) {
      return `BLOCKED: ZFS preflight failed on ${node.name}. Fix ZFS issues before rebuilding.\n\n${zfsResult}`;
    }
  }

  const timeout = getTimeout("rebuild-switch");

  // Record generation before
  const genBefore = await run(node, "readlink /nix/var/nix/profiles/system", 10_000);

  // Execute rebuild
  const cmd = rebuildCmd(node, "switch");
  const result = await run(node, cmd, timeout);

  // Record generation after
  const genAfter = await run(node, "readlink /nix/var/nix/profiles/system", 10_000);

  const lines = [`=== Rebuild Switch: ${node.name} ===`, `Command: ${cmd}`];

  if (result.timedOut) {
    lines.push(`\nTIMED OUT after ${timeout / 1000}s`);
    lines.push(`WARNING: The rebuild may still be running on the node.`);
    lines.push(`Partial stdout:\n${result.stdout}`);
  } else if (result.exitCode !== 0) {
    lines.push(`\nFAILED (exit code ${result.exitCode})`);
    lines.push(`stdout:\n${result.stdout}`);
    lines.push(`stderr:\n${result.stderr}`);
  } else {
    lines.push(`\nSUCCESS`);
    lines.push(`Generation before: ${genBefore.stdout}`);
    lines.push(`Generation after:  ${genAfter.stdout}`);
    lines.push(`\n${result.stdout}`);
  }

  return lines.join("\n");
}
