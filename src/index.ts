#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadInventory, getNode } from "./inventory.js";
import { closeAll, setNodeRegistry, warmup } from "./ssh.js";
import { status } from "./tools/status.js";
import { rebuildDry, rebuildSwitch } from "./tools/rebuild.js";
import { listGenerations, rollback } from "./tools/generations.js";
import { validate } from "./tools/validate.js";
import { zfsPreflight } from "./tools/zfs.js";
import { diff } from "./tools/diff.js";
import { log, debug, type NodeConfig } from "./types.js";

// Load inventory at startup
let nodes: NodeConfig[];
try {
  nodes = loadInventory();
  setNodeRegistry(nodes); // Register nodes for jump host resolution
  log(`Loaded ${nodes.length} node(s): ${nodes.map((n) => n.name).join(", ")}`);

  // Pre-warm jump hosts in background (don't block startup)
  const jumpHosts = new Set(nodes.map((n) => n.jumpHost).filter(Boolean));
  if (jumpHosts.size > 0) {
    log(`Pre-warming jump host(s): ${[...jumpHosts].join(", ")}`);
    for (const jh of jumpHosts) {
      const jumpNode = nodes.find((n) => n.name === jh);
      if (jumpNode) {
        warmup(jumpNode).then((ok) => {
          if (ok) log(`Jump host ${jh} ready`);
          else log(`Jump host ${jh} warmup failed — will retry on first use`);
        });
      }
    }
  }
} catch (err) {
  log(`FATAL: Failed to load node inventory: ${err}`);
  process.exit(1);
}

// Create MCP server
const server = new McpServer({
  name: "mcp-nixos-ops",
  version: "1.0.0",
});

// Register the nixos_ops tool
server.tool(
  "nixos_ops",
  `Remote NixOS system management via SSH.

Actions:
  list-nodes      — Show configured nodes, tags, and permission flags
  status          — System health: version, uptime, generation, K3s, ZFS, memory, disk, failed services
  rebuild-dry     — Safe dry-build (no changes applied)
  rebuild-switch  — DESTRUCTIVE: activate new config. Requires allowRebuildSwitch=true on node, confirm=true, AND ZFS preflight pass
  generations     — List NixOS generations
  rollback        — DESTRUCTIVE: revert to previous generation. Requires allowRollback=true AND confirm=true
  validate        — Syntax check and evaluation of NixOS config
  zfs-preflight   — Check ZFS pool health, import status, usage, scrub status
  diff            — Build pending config and compare to current (uses nvd/nix-diff if available)

Safety model:
  - rebuild-switch has THREE gates: node permission, confirm flag, and ZFS preflight
  - rollback has TWO gates: node permission and confirm flag
  - All commands have timeouts (120s default, 600s for builds)
  - Never uses --flake unless the node has useFlake=true`,
  {
    action: z.enum([
      "list-nodes",
      "status",
      "rebuild-dry",
      "rebuild-switch",
      "generations",
      "rollback",
      "validate",
      "zfs-preflight",
      "diff",
    ]).describe("The operation to perform"),
    node: z.string().optional().describe("Node name from inventory (required except for list-nodes)"),
    confirm: z.boolean().optional().default(false).describe("Required for destructive operations (rebuild-switch, rollback)"),
    limit: z.number().optional().default(10).describe("Number of generations to show (for generations action)"),
  },
  async ({ action, node: nodeName, confirm, limit }) => {
    try {
      // list-nodes doesn't need a node
      if (action === "list-nodes") {
        return formatResult(listNodes());
      }

      // All other actions require a node name
      if (!nodeName) {
        return formatError(`Action "${action}" requires a "node" parameter. Use action="list-nodes" to see available nodes.`);
      }

      const node = getNode(nodes, nodeName);

      switch (action) {
        case "status":
          return formatResult(await status(node));

        case "rebuild-dry":
          return formatResult(await rebuildDry(node));

        case "rebuild-switch":
          return formatResult(await rebuildSwitch(node, confirm));

        case "generations":
          return formatResult(await listGenerations(node, limit));

        case "rollback":
          return formatResult(await rollback(node, confirm));

        case "validate":
          return formatResult(await validate(node));

        case "zfs-preflight":
          return formatResult(await zfsPreflight(node));

        case "diff":
          return formatResult(await diff(node));

        default:
          return formatError(`Unknown action: ${action}`);
      }
    } catch (err) {
      return formatError(`Error executing ${action}: ${err}`);
    }
  }
);

function listNodes(): string {
  const lines = ["=== Configured NixOS Nodes ===", ""];

  for (const node of nodes) {
    const tags = node.tags.length > 0 ? `[${node.tags.join(", ")}]` : "";
    const flakeMode = node.useFlake ? "flake" : "classic";
    const perms: string[] = [];
    if (node.allowRebuildSwitch) perms.push("rebuild-switch");
    if (node.allowRollback) perms.push("rollback");
    const permStr = perms.length > 0 ? perms.join(", ") : "read-only";

    lines.push(`${node.name} (${node.host}:${node.port})`);
    lines.push(`  User: ${node.user} | Mode: ${flakeMode} | Tags: ${tags || "none"}`);
    lines.push(`  Config: ${node.useFlake ? node.flakePath : node.configPath}`);
    lines.push(`  ZFS pools: ${node.zfsPools.length > 0 ? node.zfsPools.join(", ") : "none"}`);
    lines.push(`  Allowed ops: ${permStr}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function formatError(text: string) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${text}` }],
    isError: true,
  };
}

// Graceful shutdown
process.on("SIGINT", () => {
  debug("SIGINT received, cleaning up...");
  closeAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  debug("SIGTERM received, cleaning up...");
  closeAll();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server started on stdio");
}

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
