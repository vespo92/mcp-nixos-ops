import { describe, expect, test, beforeEach } from "bun:test";
import { NodeCache, STALE_THRESHOLD_MS } from "../src/nats/cache";
import type { HeartbeatPayload, StatusPayload, ZfsPayload, GenerationsPayload } from "../src/types";

describe("NodeCache", () => {
  let cache: NodeCache;

  beforeEach(() => {
    cache = new NodeCache();
  });

  test("returns undefined for unknown node", () => {
    expect(cache.get("nope")).toBeUndefined();
    expect(cache.isStale("nope")).toBe(true);
    expect(cache.age("nope")).toBe(-1);
  });

  test("updates and retrieves heartbeat", () => {
    const hb: HeartbeatPayload = { ts: Date.now(), up: 3600, version: "25.11" };
    cache.updateHeartbeat("node-a", hb);

    const state = cache.get("node-a");
    expect(state).toBeDefined();
    expect(state!.heartbeat).toEqual(hb);
    expect(cache.isStale("node-a")).toBe(false);
    expect(cache.age("node-a")).toBeLessThanOrEqual(1);
  });

  test("updates and retrieves status", () => {
    const status: StatusPayload = {
      ts: Date.now(),
      version: "25.11",
      uptime: "up 2 hours",
      generation: "system-41-link",
      memory: { total: "188Gi", used: "41Gi", free: "140Gi", available: "147Gi" },
      disk: { root: "/dev/sda 457G 52G 382G 12% /", nix: "" },
      failedServices: [],
      k3s: { active: true, nodes: "node-a Ready" },
    };
    cache.updateStatus("node-a", status);
    expect(cache.getStatus("node-a")).toEqual(status);
  });

  test("updates and retrieves ZFS", () => {
    const zfs: ZfsPayload = {
      ts: Date.now(),
      pools: [{ name: "tank", imported: true, health: "ONLINE", capacityPct: 1, size: "29T", alloc: "486G", free: "28T", scrub: "" }],
      datasets: "tank 353G ...",
    };
    cache.updateZfs("node-a", zfs);
    expect(cache.getZfs("node-a")).toEqual(zfs);
  });

  test("updates and retrieves generations", () => {
    const gens: GenerationsPayload = {
      ts: Date.now(),
      current: "system-41-link",
      generations: [
        { id: 40, date: "2026-04-05", current: false },
        { id: 41, date: "2026-04-05", current: true },
      ],
    };
    cache.updateGenerations("node-a", gens);
    expect(cache.getGenerations("node-a")).toEqual(gens);
  });

  test("stale node returns null from typed getters", () => {
    const hb: HeartbeatPayload = { ts: Date.now(), up: 100, version: "25.11" };
    cache.updateHeartbeat("node-a", hb);

    // Force lastSeen to be old
    const state = cache.get("node-a")!;
    state.lastSeen = Date.now() - STALE_THRESHOLD_MS - 1000;

    expect(cache.isStale("node-a")).toBe(true);
    expect(cache.getStatus("node-a")).toBeNull();
    expect(cache.getZfs("node-a")).toBeNull();
    expect(cache.getGenerations("node-a")).toBeNull();
  });

  test("knownNodes lists all nodes that reported", () => {
    cache.updateHeartbeat("alpha", { ts: Date.now(), up: 1, version: "x" });
    cache.updateHeartbeat("beta", { ts: Date.now(), up: 2, version: "y" });
    expect(cache.knownNodes().sort()).toEqual(["alpha", "beta"]);
  });

  test("summary returns formatted string", () => {
    cache.updateHeartbeat("node-a", { ts: Date.now(), up: 1, version: "x" });
    const s = cache.summary();
    expect(s).toContain("node-a");
    expect(s).toContain("LIVE");
  });
});
