import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadInventory, getNode } from "../src/inventory.js";
import { NodeConfigSchema, NodesConfigSchema } from "../src/types.js";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "mcp-nixos-ops-test-" + Date.now());
const TEST_CONFIG = join(TEST_DIR, "nodes.json");

const VALID_NODE = {
  name: "test-node",
  host: "10.0.0.99",
  user: "admin",
  port: 22,
  sshKey: "~/.ssh/id_ed25519",
  useFlake: false,
  configPath: "/etc/nixos/configuration.nix",
  flakePath: "/etc/nixos",
  zfsPools: ["tank"],
  tags: ["test"],
  allowRebuildSwitch: false,
  allowRollback: true,
};

const VALID_NODES = [
  VALID_NODE,
  {
    name: "test-node-2",
    host: "10.0.0.100",
    user: "root",
    port: 2222,
    useFlake: true,
    configPath: "/etc/nixos/configuration.nix",
    flakePath: "/etc/nixos",
    zfsPools: [],
    tags: ["worker"],
    allowRebuildSwitch: true,
    allowRollback: false,
  },
];

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear env vars
  delete process.env.MCP_NIXOS_NODES;
  delete process.env.MCP_NIXOS_CONFIG_PATH;
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.MCP_NIXOS_NODES;
  delete process.env.MCP_NIXOS_CONFIG_PATH;
});

describe("NodeConfigSchema", () => {
  test("validates a complete node config", () => {
    const result = NodeConfigSchema.parse(VALID_NODE);
    expect(result.name).toBe("test-node");
    expect(result.host).toBe("10.0.0.99");
    expect(result.zfsPools).toEqual(["tank"]);
  });

  test("applies defaults for optional fields", () => {
    const minimal = { name: "minimal", host: "10.0.0.1" };
    const result = NodeConfigSchema.parse(minimal);
    expect(result.user).toBe("admin");
    expect(result.port).toBe(22);
    expect(result.useFlake).toBe(false);
    expect(result.zfsPools).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.allowRebuildSwitch).toBe(false);
    expect(result.allowRollback).toBe(true);
  });

  test("rejects missing name", () => {
    expect(() => NodeConfigSchema.parse({ host: "10.0.0.1" })).toThrow();
  });

  test("rejects missing host", () => {
    expect(() => NodeConfigSchema.parse({ name: "no-host" })).toThrow();
  });

  test("rejects empty name", () => {
    expect(() => NodeConfigSchema.parse({ name: "", host: "10.0.0.1" })).toThrow();
  });
});

describe("NodesConfigSchema", () => {
  test("validates an array of nodes", () => {
    const result = NodesConfigSchema.parse(VALID_NODES);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("test-node");
    expect(result[1].name).toBe("test-node-2");
  });

  test("rejects empty array", () => {
    expect(() => NodesConfigSchema.parse([])).toThrow();
  });
});

describe("loadInventory", () => {
  test("loads from MCP_NIXOS_NODES env var (inline JSON)", () => {
    process.env.MCP_NIXOS_NODES = JSON.stringify(VALID_NODES);
    const nodes = loadInventory();
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe("test-node");
  });

  test("loads from MCP_NIXOS_NODES env var (file path)", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify(VALID_NODES));
    process.env.MCP_NIXOS_NODES = TEST_CONFIG;
    const nodes = loadInventory();
    expect(nodes).toHaveLength(2);
  });

  test("loads from MCP_NIXOS_CONFIG_PATH", () => {
    writeFileSync(TEST_CONFIG, JSON.stringify(VALID_NODES));
    process.env.MCP_NIXOS_CONFIG_PATH = TEST_CONFIG;
    const nodes = loadInventory();
    expect(nodes).toHaveLength(2);
  });

  test("throws if no config found", () => {
    // Point to a non-existent path
    process.env.MCP_NIXOS_CONFIG_PATH = "/tmp/nonexistent-mcp-nixos/nodes.json";
    expect(() => loadInventory()).toThrow("No node inventory found");
  });

  test("throws on invalid JSON in env var", () => {
    process.env.MCP_NIXOS_NODES = "not json at all {{{";
    expect(() => loadInventory()).toThrow();
  });

  test("expands tilde in sshKey paths", () => {
    process.env.MCP_NIXOS_NODES = JSON.stringify([VALID_NODE]);
    const nodes = loadInventory();
    expect(nodes[0].sshKey).not.toContain("~");
    expect(nodes[0].sshKey).toContain("/.ssh/id_ed25519");
  });
});

describe("getNode", () => {
  test("finds node by name", () => {
    const parsed = NodesConfigSchema.parse(VALID_NODES);
    const node = getNode(parsed, "test-node");
    expect(node.host).toBe("10.0.0.99");
  });

  test("finds second node by name", () => {
    const parsed = NodesConfigSchema.parse(VALID_NODES);
    const node = getNode(parsed, "test-node-2");
    expect(node.host).toBe("10.0.0.100");
  });

  test("throws for unknown node", () => {
    const parsed = NodesConfigSchema.parse(VALID_NODES);
    expect(() => getNode(parsed, "nonexistent")).toThrow('Node "nonexistent" not found');
  });

  test("error message lists available nodes", () => {
    const parsed = NodesConfigSchema.parse(VALID_NODES);
    try {
      getNode(parsed, "nope");
    } catch (err: any) {
      expect(err.message).toContain("test-node");
      expect(err.message).toContain("test-node-2");
    }
  });
});

describe("safety flags", () => {
  test("default allowRebuildSwitch is false", () => {
    const node = NodeConfigSchema.parse({ name: "n", host: "h" });
    expect(node.allowRebuildSwitch).toBe(false);
  });

  test("default allowRollback is true", () => {
    const node = NodeConfigSchema.parse({ name: "n", host: "h" });
    expect(node.allowRollback).toBe(true);
  });

  test("can explicitly disable rollback", () => {
    const node = NodeConfigSchema.parse({
      name: "n",
      host: "h",
      allowRollback: false,
    });
    expect(node.allowRollback).toBe(false);
  });

  test("can explicitly enable rebuildSwitch", () => {
    const node = NodeConfigSchema.parse({
      name: "n",
      host: "h",
      allowRebuildSwitch: true,
    });
    expect(node.allowRebuildSwitch).toBe(true);
  });
});
