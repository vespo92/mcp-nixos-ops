import { run, getTimeout } from "../ssh.js";
import type { NodeConfig, GenerationsPayload } from "../types.js";
import type { NodeCache } from "../nats/cache.js";

function formatCached(node: NodeConfig, data: GenerationsPayload, age: number, limit: number): string {
  const lines = [`=== Generations: ${node.name} (last ${limit}) ===`, `[source: cache, age: ${age}s]`];
  lines.push(`Current: ${data.current}\n`);
  const shown = data.generations.slice(-limit);
  for (const gen of shown) {
    const marker = gen.current ? "(current)" : "";
    lines.push(`  ${gen.id}   ${gen.date}   ${marker}`);
  }
  return lines.join("\n");
}

export async function listGenerations(
  node: NodeConfig,
  limit: number = 10,
  cache?: NodeCache
): Promise<string> {
  // Try cache first
  if (cache) {
    const cached = cache.getGenerations(node.name);
    if (cached) {
      return formatCached(node, cached, cache.age(node.name), limit);
    }
  }

  // SSH fallback
  const timeout = getTimeout("generations");
  const sourceTag = cache ? "[source: ssh (cache stale)]\n" : "";
  const cmd = `sudo nix-env --list-generations --profile /nix/var/nix/profiles/system | tail -n ${limit}`;

  const result = await run(node, cmd, timeout);

  const lines = [`=== Generations: ${node.name} (last ${limit}) ===`, sourceTag];

  if (result.timedOut) {
    lines.push(`TIMED OUT`);
  } else if (result.exitCode !== 0) {
    lines.push(`FAILED (exit code ${result.exitCode})`);
    lines.push(`stderr: ${result.stderr}`);
  } else {
    const current = await run(
      node,
      "readlink /nix/var/nix/profiles/system",
      10_000
    );
    lines.push(`Current: ${current.stdout}`);
    lines.push("");
    lines.push(result.stdout);
  }

  return lines.join("\n");
}

export async function rollback(
  node: NodeConfig,
  confirm: boolean
): Promise<string> {
  // Gate 1: node permission
  if (!node.allowRollback) {
    return `BLOCKED: Node "${node.name}" has allowRollback=false.`;
  }

  // Gate 2: explicit confirmation
  if (!confirm) {
    return `BLOCKED: rollback is a DESTRUCTIVE operation. You must pass confirm=true to proceed. This will activate the previous NixOS generation on ${node.name}.`;
  }

  const timeout = getTimeout("rollback");

  // Record current generation
  const genBefore = await run(
    node,
    "readlink /nix/var/nix/profiles/system",
    10_000
  );

  // Execute rollback
  const cmd = node.useFlake
    ? "sudo nixos-rebuild switch --rollback"
    : "sudo nixos-rebuild switch --rollback --no-flake";
  const result = await run(node, cmd, timeout);

  // Record new generation
  const genAfter = await run(
    node,
    "readlink /nix/var/nix/profiles/system",
    10_000
  );

  const lines = [`=== Rollback: ${node.name} ===`];

  if (result.timedOut) {
    lines.push(`TIMED OUT after ${timeout / 1000}s`);
    lines.push(`WARNING: Rollback may still be running.`);
  } else if (result.exitCode !== 0) {
    lines.push(`FAILED (exit code ${result.exitCode})`);
    lines.push(`stdout:\n${result.stdout}`);
    lines.push(`stderr:\n${result.stderr}`);
  } else {
    lines.push(`SUCCESS`);
    lines.push(`Generation before: ${genBefore.stdout}`);
    lines.push(`Generation after:  ${genAfter.stdout}`);
    lines.push(`\n${result.stdout}`);
  }

  return lines.join("\n");
}
