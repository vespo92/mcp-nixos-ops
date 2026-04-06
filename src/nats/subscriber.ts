/**
 * NATS subscriber — listens to all nixops.> subjects
 * and populates the in-memory cache.
 */

import { NodeCache } from "./cache.js";
import { ALL_SUBJECTS, parseSubject } from "./subjects.js";
import { log, debug } from "../types.js";
import type {
  HeartbeatPayload,
  StatusPayload,
  ZfsPayload,
  GenerationsPayload,
} from "../types.js";

let StringCodec: any = null;

export async function startSubscriber(
  connection: any,
  cache: NodeCache
): Promise<void> {
  if (!connection) return;

  const natsLib = await import("nats");
  StringCodec = natsLib.StringCodec;
  const sc = StringCodec();

  const sub = connection.subscribe(ALL_SUBJECTS);
  log(`[nats] Subscribed to ${ALL_SUBJECTS}`);

  (async () => {
    for await (const msg of sub) {
      try {
        const parsed = parseSubject(msg.subject);
        if (!parsed) continue;

        const data = JSON.parse(sc.decode(msg.data));
        const { type, node } = parsed;

        switch (type) {
          case "heartbeat":
            cache.updateHeartbeat(node, data as HeartbeatPayload);
            break;
          case "status":
            cache.updateStatus(node, data as StatusPayload);
            break;
          case "zfs":
            cache.updateZfs(node, data as ZfsPayload);
            break;
          case "generations":
            cache.updateGenerations(node, data as GenerationsPayload);
            break;
          default:
            debug(`[nats] Unknown subject type: ${type}`);
        }
      } catch (err) {
        debug(`[nats] Error processing message on ${msg.subject}: ${err}`);
      }
    }
  })();
}
