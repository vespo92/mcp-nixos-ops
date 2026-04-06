/**
 * SSH transport with ControlMaster multiplexing and ProxyJump support.
 *
 * Performance model:
 *   - First connection to a host: ~200ms (full handshake, creates socket)
 *   - Subsequent commands: ~10-20ms (reuse existing socket)
 *   - Jump host commands: ~20-30ms (tunnel through persistent socket)
 *
 * This is faster than manual bash because:
 *   1. ControlMaster keeps sockets alive between MCP tool calls
 *   2. ProxyJump reuses the bastion's persistent socket
 *   3. Parallel commands across nodes share the same tunnels
 */

import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import type { NodeConfig, SSHResult } from "./types.js";
import { debug, log } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const REBUILD_TIMEOUT = 600_000;

// Socket directory — must be SHORT (macOS Unix socket path limit is 104 chars)
const SOCKET_DIR = join(tmpdir(), "nxs");

// Ensure socket directory exists
try {
  if (!existsSync(SOCKET_DIR)) {
    mkdirSync(SOCKET_DIR, { mode: 0o700, recursive: true });
  }
} catch {
  // Fall back to /tmp if we can't create the dir
}

// Node registry for jump host resolution (set by index.ts after loading inventory)
let nodeRegistry: NodeConfig[] = [];

export function setNodeRegistry(nodes: NodeConfig[]): void {
  nodeRegistry = nodes;
}

function resolveJumpNode(jumpHostName: string): NodeConfig | undefined {
  return nodeRegistry.find((n) => n.name === jumpHostName);
}

function socketPath(node: NodeConfig): string {
  // Keep it short to avoid macOS 104-char Unix socket path limit
  return join(SOCKET_DIR, node.name);
}

export function getTimeout(action: string): number {
  if (action.startsWith("rebuild") || action === "rollback" || action === "diff") {
    return REBUILD_TIMEOUT;
  }
  return DEFAULT_TIMEOUT;
}

/**
 * Build SSH args with ControlMaster and optional ProxyJump.
 */
function buildSSHArgs(node: NodeConfig, command: string): string[] {
  const sock = socketPath(node);
  const args: string[] = [
    // ControlMaster: auto-create persistent socket, reuse if exists
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sock}`,
    "-o", "ControlPersist=600",        // Keep socket alive 10 minutes after last use
    // Connection settings
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",     // Keep-alive every 30s
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",             // Suppress warnings
    "-p", String(node.port),
  ];

  // SSH key
  if (node.sshKey) {
    args.push("-i", node.sshKey);
  }

  // ProxyJump through another node via ProxyCommand
  // We use ProxyCommand (not -J) so we can enforce ControlMaster on the jump leg too
  if (node.jumpHost) {
    const jumpNode = resolveJumpNode(node.jumpHost);
    if (jumpNode) {
      const jumpSock = socketPath(jumpNode);
      const keyArg = jumpNode.sshKey ? `-i ${jumpNode.sshKey}` : "";
      const proxyCmd = [
        "ssh",
        "-o ControlMaster=auto",
        `-o ControlPath=${jumpSock}`,
        "-o ControlPersist=600",
        "-o StrictHostKeyChecking=no",
        "-o UserKnownHostsFile=/dev/null",
        "-o BatchMode=yes",
        "-o LogLevel=ERROR",
        keyArg,
        `-p ${jumpNode.port}`,
        `-W %h:%p`,
        `${jumpNode.user}@${jumpNode.host}`,
      ].filter(Boolean).join(" ");

      args.push("-o", `ProxyCommand=${proxyCmd}`);
    } else {
      log(`WARNING: Jump host "${node.jumpHost}" not found in inventory, connecting directly`);
    }
  }

  args.push(`${node.user}@${node.host}`, command);
  return args;
}

/**
 * Warm up the ControlMaster connection for a node.
 * This establishes the persistent socket without running a real command.
 * Call this at startup for the jump host to pre-warm the tunnel.
 */
export async function warmup(node: NodeConfig): Promise<boolean> {
  debug(`[${node.name}] Warming up ControlMaster connection...`);
  const result = await run(node, "true", 15_000);
  if (result.exitCode === 0) {
    debug(`[${node.name}] ControlMaster socket ready`);
    return true;
  }
  debug(`[${node.name}] Warmup failed: ${result.stderr}`);
  return false;
}

/**
 * Execute a command on a remote NixOS node via SSH.
 * Uses ControlMaster for connection reuse and ProxyJump for jump hosts.
 */
export async function run(
  node: NodeConfig,
  command: string,
  timeout: number = DEFAULT_TIMEOUT
): Promise<SSHResult> {
  debug(`[${node.name}] Running: ${command.slice(0, 100)}... (timeout: ${timeout}ms)`);

  const args = buildSSHArgs(node, command);

  try {
    const proc = Bun.spawn(["ssh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    return {
      exitCode: timedOut ? -1 : exitCode,
      stdout: stdout.trim(),
      stderr: timedOut ? stderr.trim() + "\n[TIMED OUT]" : stderr.trim(),
      timedOut,
    };
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `SSH failed: ${err}`,
      timedOut: false,
    };
  }
}

/**
 * Run commands on multiple nodes in parallel.
 * All jump host tunnels are shared, so this is very efficient.
 */
export async function runMulti(
  nodes: NodeConfig[],
  command: string,
  timeout: number = DEFAULT_TIMEOUT
): Promise<Map<string, SSHResult>> {
  const results = new Map<string, SSHResult>();
  const promises = nodes.map(async (node) => {
    const result = await run(node, command, timeout);
    results.set(node.name, result);
  });
  await Promise.allSettled(promises);
  return results;
}

/**
 * Cleanup: close all ControlMaster sockets.
 */
export function closeAll(): void {
  debug("Closing all ControlMaster sockets...");
  // Send exit to each socket
  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(SOCKET_DIR);
    for (const file of files) {
      const sock = join(SOCKET_DIR, file);
      try {
        Bun.spawnSync(["ssh", "-o", `ControlPath=${sock}`, "-O", "exit", "dummy"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
    }
  } catch {}
}
