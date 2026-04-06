/**
 * NATS subject hierarchy for nixops node telemetry.
 *
 * Subject layout:
 *   nixops.heartbeat.<node>     — 30s liveness ping
 *   nixops.status.<node>        — 60s full status blob
 *   nixops.zfs.<node>           — 60s ZFS pool health
 *   nixops.generations.<node>   — 5m generation list
 */

// Subject builders
export const heartbeatSubject = (node: string) => `nixops.heartbeat.${node}`;
export const statusSubject = (node: string) => `nixops.status.${node}`;
export const zfsSubject = (node: string) => `nixops.zfs.${node}`;
export const generationsSubject = (node: string) => `nixops.generations.${node}`;

// Wildcard subscriptions
export const HEARTBEAT_ALL = "nixops.heartbeat.>";
export const STATUS_ALL = "nixops.status.>";
export const ZFS_ALL = "nixops.zfs.>";
export const GENERATIONS_ALL = "nixops.generations.>";
export const ALL_SUBJECTS = "nixops.>";

// Parse a subject into { type, node }
export function parseSubject(subject: string): { type: string; node: string } | null {
  const parts = subject.split(".");
  if (parts.length !== 3 || parts[0] !== "nixops") return null;
  return { type: parts[1], node: parts[2] };
}
