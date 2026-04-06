import { describe, expect, test } from "bun:test";
import {
  heartbeatSubject,
  statusSubject,
  zfsSubject,
  generationsSubject,
  parseSubject,
  ALL_SUBJECTS,
} from "../src/nats/subjects";

describe("NATS subjects", () => {
  test("builds correct subjects", () => {
    expect(heartbeatSubject("nix01")).toBe("nixops.heartbeat.nix01");
    expect(statusSubject("nix01")).toBe("nixops.status.nix01");
    expect(zfsSubject("nix01")).toBe("nixops.zfs.nix01");
    expect(generationsSubject("nix01")).toBe("nixops.generations.nix01");
  });

  test("ALL_SUBJECTS wildcard", () => {
    expect(ALL_SUBJECTS).toBe("nixops.>");
  });

  test("parses valid subjects", () => {
    expect(parseSubject("nixops.heartbeat.nix01")).toEqual({ type: "heartbeat", node: "nix01" });
    expect(parseSubject("nixops.zfs.node-3")).toEqual({ type: "zfs", node: "node-3" });
  });

  test("returns null for invalid subjects", () => {
    expect(parseSubject("foo.bar.baz")).toBeNull();
    expect(parseSubject("nixops.too.many.parts")).toBeNull();
    expect(parseSubject("nixops")).toBeNull();
  });
});
