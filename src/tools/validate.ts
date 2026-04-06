import { run, getTimeout } from "../ssh.js";
import type { NodeConfig } from "../types.js";

export async function validate(node: NodeConfig): Promise<string> {
  const timeout = getTimeout("validate");
  const lines = [`=== Validate: ${node.name} ===`];

  if (node.useFlake) {
    return await validateFlake(node, timeout, lines);
  }
  return await validateClassic(node, timeout, lines);
}

async function validateFlake(
  node: NodeConfig,
  timeout: number,
  lines: string[]
): Promise<string> {
  lines.push(`Mode: Flake (${node.flakePath})`);

  // Check flake.nix exists
  const exists = await run(
    node,
    `test -f ${node.flakePath}/flake.nix && echo "EXISTS" || echo "MISSING"`,
    10_000
  );

  if (exists.stdout.includes("MISSING")) {
    lines.push(`\nFAILED: ${node.flakePath}/flake.nix does not exist`);
    return lines.join("\n");
  }
  lines.push(`flake.nix: EXISTS`);

  // Run flake check
  const check = await run(
    node,
    `cd ${node.flakePath} && nix flake check --no-build 2>&1`,
    timeout
  );

  if (check.timedOut) {
    lines.push(`\nFlake check TIMED OUT`);
  } else if (check.exitCode !== 0) {
    lines.push(`\nFlake check FAILED (exit code ${check.exitCode})`);
    lines.push(check.stdout);
    if (check.stderr) lines.push(check.stderr);
  } else {
    lines.push(`\nFlake check PASSED`);
    if (check.stdout) lines.push(check.stdout);
  }

  return lines.join("\n");
}

async function validateClassic(
  node: NodeConfig,
  timeout: number,
  lines: string[]
): Promise<string> {
  lines.push(`Mode: Classic (${node.configPath})`);

  // Step 1: Check config file exists
  const exists = await run(
    node,
    `test -f ${node.configPath} && echo "EXISTS" || echo "MISSING"`,
    10_000
  );

  if (exists.stdout.includes("MISSING")) {
    lines.push(`\nFAILED: ${node.configPath} does not exist`);
    return lines.join("\n");
  }
  lines.push(`Config file: EXISTS`);

  // Step 2: Syntax check with nix-instantiate --parse
  const syntax = await run(
    node,
    `nix-instantiate --parse ${node.configPath} > /dev/null 2>&1 && echo "SYNTAX_OK" || echo "SYNTAX_FAIL"`,
    30_000
  );

  if (syntax.stdout.includes("SYNTAX_FAIL")) {
    // Get the actual error
    const syntaxErr = await run(
      node,
      `nix-instantiate --parse ${node.configPath} 2>&1`,
      30_000
    );
    lines.push(`\nSyntax check FAILED:`);
    lines.push(syntaxErr.stdout || syntaxErr.stderr);
    return lines.join("\n");
  }
  lines.push(`Syntax check: PASSED`);

  // Step 3: Evaluation check
  const evalCheck = await run(
    node,
    `nix-instantiate '<nixpkgs/nixos>' -A system --no-build 2>&1 | tail -5`,
    timeout
  );

  if (evalCheck.timedOut) {
    lines.push(`\nEvaluation check TIMED OUT`);
  } else if (evalCheck.exitCode !== 0) {
    lines.push(`\nEvaluation check FAILED (exit code ${evalCheck.exitCode})`);
    lines.push(evalCheck.stdout);
    if (evalCheck.stderr) lines.push(evalCheck.stderr);
  } else {
    lines.push(`Evaluation check: PASSED`);
    if (evalCheck.stdout) lines.push(evalCheck.stdout);
  }

  return lines.join("\n");
}
