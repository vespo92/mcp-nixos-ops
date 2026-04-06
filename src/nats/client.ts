/**
 * NATS connection lifecycle.
 *
 * Connects to NATS server (gated by NATS_URL env var).
 * If NATS_URL is not set, all exports are no-ops and the
 * MCP server works identically via SSH-only mode.
 */

import { log, debug } from "../types.js";

// Lazy import — only loaded if NATS_URL is set
let natsLib: typeof import("nats") | null = null;
let connection: any = null;

export function getNatsUrl(): string | undefined {
  return process.env.NATS_URL || process.env.NIXOPS_NATS_URL;
}

export function isNatsEnabled(): boolean {
  return !!getNatsUrl();
}

export async function connect(): Promise<any> {
  const url = getNatsUrl();
  if (!url) {
    debug("[nats] No NATS_URL set, running in SSH-only mode");
    return null;
  }

  try {
    natsLib = await import("nats");
    connection = await natsLib.connect({
      servers: url,
      name: "mcp-nixos-ops",
      reconnect: true,
      maxReconnectAttempts: -1, // infinite
      reconnectTimeWait: 2000,
    });

    log(`[nats] Connected to ${url}`);

    // Log reconnection events
    (async () => {
      if (!connection) return;
      for await (const s of connection.status()) {
        switch (s.type) {
          case "reconnecting":
            log(`[nats] Reconnecting...`);
            break;
          case "reconnect":
            log(`[nats] Reconnected`);
            break;
          case "disconnect":
            log(`[nats] Disconnected`);
            break;
          case "error":
            log(`[nats] Error: ${s.data}`);
            break;
        }
      }
    })();

    return connection;
  } catch (err) {
    log(`[nats] Failed to connect to ${url}: ${err}`);
    log(`[nats] Falling back to SSH-only mode`);
    connection = null;
    return null;
  }
}

export function getConnection(): any {
  return connection;
}

export async function close(): Promise<void> {
  if (connection) {
    try {
      await connection.drain();
      log("[nats] Connection closed");
    } catch {
      // ignore close errors
    }
    connection = null;
  }
}
