import { run, getTimeout } from "../ssh.js";
import type { NodeConfig } from "../types.js";

export async function diff(node: NodeConfig): Promise<string> {
  const timeout = getTimeout("diff");
  const lines = [`=== Config Diff: ${node.name} ===`];

  // Build the pending config without activating
  let buildCmd: string;
  if (node.useFlake) {
    buildCmd = `sudo nixos-rebuild build --flake ${node.flakePath}#${node.name} 2>&1`;
  } else {
    buildCmd = `sudo nixos-rebuild build --no-flake 2>&1`;
  }

  lines.push(`Building pending config...`);
  const buildResult = await run(node, buildCmd, timeout);

  if (buildResult.timedOut) {
    lines.push(`BUILD TIMED OUT after ${timeout / 1000}s`);
    return lines.join("\n");
  }

  if (buildResult.exitCode !== 0) {
    lines.push(`BUILD FAILED (exit code ${buildResult.exitCode})`);
    lines.push(buildResult.stdout);
    if (buildResult.stderr) lines.push(buildResult.stderr);
    return lines.join("\n");
  }

  lines.push(`Build succeeded.`);

  // Get current and pending system paths
  const current = "/run/current-system";
  const pending = "./result"; // nixos-rebuild build creates ./result symlink

  // Try nvd first (best diff tool for NixOS)
  const nvdResult = await run(
    node,
    `command -v nvd >/dev/null 2>&1 && nvd diff ${current} ${pending} 2>&1`,
    60_000
  );

  if (nvdResult.exitCode === 0 && nvdResult.stdout.trim()) {
    lines.push(`\n--- nvd diff ---`);
    lines.push(nvdResult.stdout);
    await cleanup(node);
    return lines.join("\n");
  }

  // Try nix-diff
  const nixDiffResult = await run(
    node,
    `command -v nix-diff >/dev/null 2>&1 && nix-diff ${current} ${pending} 2>&1`,
    60_000
  );

  if (nixDiffResult.exitCode === 0 && nixDiffResult.stdout.trim()) {
    lines.push(`\n--- nix-diff ---`);
    lines.push(nixDiffResult.stdout);
    await cleanup(node);
    return lines.join("\n");
  }

  // Fallback: compare store paths / package counts
  lines.push(
    `\n--- Fallback comparison (nvd/nix-diff not available) ---`
  );

  const fallback = await run(
    node,
    [
      `echo "Current packages:" && nix-store -qR ${current} | wc -l`,
      `echo "Pending packages:" && nix-store -qR ${pending} | wc -l`,
      `echo "--- New packages ---" && comm -13 <(nix-store -qR ${current} | sort) <(nix-store -qR ${pending} | sort) | head -30`,
      `echo "--- Removed packages ---" && comm -23 <(nix-store -qR ${current} | sort) <(nix-store -qR ${pending} | sort) | head -30`,
    ].join(" && "),
    60_000
  );

  if (fallback.exitCode === 0) {
    lines.push(fallback.stdout);
  } else {
    lines.push(`Fallback diff failed: ${fallback.stderr}`);
  }

  await cleanup(node);
  return lines.join("\n");
}

async function cleanup(node: NodeConfig): Promise<void> {
  // Remove the result symlink
  await run(node, "rm -f ./result", 5_000);
}
