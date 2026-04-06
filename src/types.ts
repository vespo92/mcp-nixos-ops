import { z } from "zod";

// --- Node inventory schema ---

export const NodeConfigSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  user: z.string().default("admin"),
  port: z.number().int().positive().default(22),
  sshKey: z.string().optional(),
  jumpHost: z.string().optional(), // Node name to use as ProxyJump bastion
  useFlake: z.boolean().default(false),
  configPath: z.string().default("/etc/nixos/configuration.nix"),
  flakePath: z.string().default("/etc/nixos"),
  zfsPools: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  allowRebuildSwitch: z.boolean().default(false),
  allowRollback: z.boolean().default(true),
});

export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export const NodesConfigSchema = z.array(NodeConfigSchema).min(1);

// --- SSH result ---

export interface SSHResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// --- Tool parameters ---

export const ActionSchema = z.enum([
  "list-nodes",
  "status",
  "rebuild-dry",
  "rebuild-switch",
  "generations",
  "rollback",
  "validate",
  "zfs-preflight",
  "diff",
]);

export type Action = z.infer<typeof ActionSchema>;

export const ToolParamsSchema = z.object({
  action: ActionSchema,
  node: z.string().optional(),
  confirm: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional().default(10),
});

export type ToolParams = z.infer<typeof ToolParamsSchema>;

// --- ZFS types ---

export interface ZFSPoolStatus {
  name: string;
  imported: boolean;
  health: string;
  size: string;
  alloc: string;
  free: string;
  capacity: string;
  scrubStatus: string;
  statusDetail: string;
}

// --- Logging ---

const DEBUG = process.env.MCP_NIXOS_OPS_DEBUG === "1";

export function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.error("[mcp-nixos-ops]", ...args);
  }
}

export function log(...args: unknown[]): void {
  console.error("[mcp-nixos-ops]", ...args);
}
