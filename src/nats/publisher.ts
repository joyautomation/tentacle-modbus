import type { NatsConnection } from "@nats-io/transport-deno";
import type { PlcDataMessage } from "@tentacle/nats-schema";
import { log } from "../utils/logger.ts";

const encoder = new TextEncoder();

export type BatchValue = {
  tagId: string;
  value: number | boolean;
  datatype: "number" | "boolean";
};

/**
 * Publish a batch of tag values to modbus.data.{deviceId}
 */
export function publishBatch(
  nc: NatsConnection,
  deviceId: string,
  values: BatchValue[],
): void {
  if (values.length === 0) return;

  const timestamp = Date.now();

  for (const { tagId, value, datatype } of values) {
    const msg: PlcDataMessage = {
      moduleId: "modbus",
      deviceId,
      variableId: tagId,
      value,
      datatype,
      timestamp,
    };
    try {
      nc.publish(`modbus.data.${deviceId}`, encoder.encode(JSON.stringify(msg)));
    } catch (err) {
      log.nats.warn(`Failed to publish tag ${tagId}: ${err}`);
    }
  }
}
