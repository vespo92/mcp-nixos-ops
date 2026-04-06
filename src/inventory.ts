import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NodesConfigSchema, type NodeConfig, debug, log } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mcp-nixos", "nodes.json");

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export function loadInventory(): NodeConfig[] {
  // Priority 1: environment variable with inline JSON
  const envVar = process.env.MCP_NIXOS_NODES;
  if (envVar) {
    debug("Loading inventory from MCP_NIXOS_NODES env var");
    try {
      const raw = JSON.parse(envVar);
      const nodes = NodesConfigSchema.parse(raw);
      return nodes.map(expandNodePaths);
    } catch (err) {
      // Maybe it's a file path instead of inline JSON
      const expanded = expandTilde(envVar);
      if (existsSync(expanded)) {
        debug("MCP_NIXOS_NODES is a file path:", expanded);
        return loadFromFile(expanded);
      }
      throw new Error(`MCP_NIXOS_NODES is neither valid JSON nor a readable file path: ${err}`);
    }
  }

  // Priority 2: default config file
  const configPath = expandTilde(
    process.env.MCP_NIXOS_CONFIG_PATH || DEFAULT_CONFIG_PATH
  );
  if (existsSync(configPath)) {
    debug("Loading inventory from config file:", configPath);
    return loadFromFile(configPath);
  }

  throw new Error(
    `No node inventory found. Set MCP_NIXOS_NODES env var or create ${DEFAULT_CONFIG_PATH}`
  );
}

function loadFromFile(path: string): NodeConfig[] {
  const content = readFileSync(path, "utf-8");
  const raw = JSON.parse(content);
  const nodes = NodesConfigSchema.parse(raw);
  return nodes.map(expandNodePaths);
}

function expandNodePaths(node: NodeConfig): NodeConfig {
  return {
    ...node,
    sshKey: node.sshKey ? expandTilde(node.sshKey) : undefined,
    configPath: expandTilde(node.configPath),
    flakePath: expandTilde(node.flakePath),
  };
}

export function getNode(nodes: NodeConfig[], name: string): NodeConfig {
  const node = nodes.find((n) => n.name === name);
  if (!node) {
    const available = nodes.map((n) => n.name).join(", ");
    throw new Error(`Node "${name}" not found. Available: ${available}`);
  }
  return node;
}
