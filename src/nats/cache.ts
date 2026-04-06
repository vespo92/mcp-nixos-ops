/**
 * In-memory cache for node state received via NATS.
 *
 * Each node has a CachedNodeState that holds the latest payload
 * for each telemetry type. Staleness is determined by the heartbeat
 * timestamp — if 3 heartbeats are missed (90s), the cache is stale
 * and reads fall back to SSH.
 */

import type {
  CachedNodeState,
  HeartbeatPayload,
  StatusPayload,
  ZfsPayload,
  GenerationsPayload,
} from "../types.js";
import { debug } from "../types.js";

// 3 missed 30s heartbeats = stale
export const STALE_THRESHOLD_MS = 90_000;

export class NodeCache {
  private store = new Map<string, CachedNodeState>();

  updateHeartbeat(node: string, payload: HeartbeatPayload): void {
    const state = this.getOrCreate(node);
    state.heartbeat = payload;
    state.lastSeen = Date.now();
    debug(`[cache] ${node} heartbeat updated`);
  }

  updateStatus(node: string, payload: StatusPayload): void {
    const state = this.getOrCreate(node);
    state.status = payload;
    state.lastSeen = Date.now();
  }

  updateZfs(node: string, payload: ZfsPayload): void {
    const state = this.getOrCreate(node);
    state.zfs = payload;
    state.lastSeen = Date.now();
  }

  updateGenerations(node: string, payload: GenerationsPayload): void {
    const state = this.getOrCreate(node);
    state.generations = payload;
    state.lastSeen = Date.now();
  }

  get(node: string): CachedNodeState | undefined {
    return this.store.get(node);
  }

  isStale(node: string): boolean {
    const state = this.store.get(node);
    if (!state) return true;
    return Date.now() - state.lastSeen > STALE_THRESHOLD_MS;
  }

  getStatus(node: string): StatusPayload | null {
    if (this.isStale(node)) return null;
    return this.store.get(node)?.status ?? null;
  }

  getZfs(node: string): ZfsPayload | null {
    if (this.isStale(node)) return null;
    return this.store.get(node)?.zfs ?? null;
  }

  getGenerations(node: string): GenerationsPayload | null {
    if (this.isStale(node)) return null;
    return this.store.get(node)?.generations ?? null;
  }

  /** Age of last heartbeat in seconds, or -1 if no data */
  age(node: string): number {
    const state = this.store.get(node);
    if (!state) return -1;
    return Math.round((Date.now() - state.lastSeen) / 1000);
  }

  /** All nodes that have ever reported */
  knownNodes(): string[] {
    return [...this.store.keys()];
  }

  /** Summary for debugging */
  summary(): string {
    const lines: string[] = [];
    for (const [node, state] of this.store) {
      const age = this.age(node);
      const stale = this.isStale(node) ? "STALE" : "LIVE";
      lines.push(`  ${node}: ${stale} (${age}s ago)`);
    }
    return lines.length > 0 ? lines.join("\n") : "  (empty)";
  }

  private getOrCreate(node: string): CachedNodeState {
    let state = this.store.get(node);
    if (!state) {
      state = { lastSeen: 0 };
      this.store.set(node, state);
    }
    return state;
  }
}
