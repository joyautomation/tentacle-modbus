/**
 * Modbus Scanner — stateless, subscriber-driven polling engine.
 *
 * Starts with zero connections. Devices connect on-demand when a
 * modbus.subscribe request arrives. Connections are torn down when
 * the last subscriber for a device unsubscribes.
 *
 * NATS subjects:
 *   modbus.subscribe         — request/reply: add subscriber
 *   modbus.unsubscribe       — request/reply: remove subscriber
 *   modbus.command.{tagId}   — write a tag value (string payload)
 *   modbus.data.{deviceId}   — published batch of tag values
 */

import type { NatsConnection } from "@nats-io/transport-deno";
import { ModbusClient } from "../modbus/client.ts";
import {
  readCoils,
  readDiscreteInputs,
  readHoldingRegisters,
  readInputRegisters,
  writeSingleCoil,
  writeSingleRegister,
  writeMultipleRegisters,
} from "../modbus/functions.ts";
import { decodeRegisters, encodeValue } from "../modbus/decode.ts";
import { buildBlocks, type ReadBlock } from "../modbus/blocks.ts";
import { publishBatch, type BatchValue } from "../nats/publisher.ts";
import { log } from "../utils/logger.ts";
import { sleep } from "../utils/cycle.ts";
import type {
  ModbusTagConfig,
  ModbusSubscribeRequest,
  ModbusUnsubscribeRequest,
  ModbusByteOrder,
} from "../../types/config.ts";

const MODULE_ID = "modbus";
const DEFAULT_SCAN_RATE = 1000;
const DEFAULT_PORT = 502;
const DEFAULT_UNIT_ID = 1;
const DEFAULT_BYTE_ORDER: ModbusByteOrder = "ABCD";

// ─── Types ───────────────────────────────────────────────────────────────────

type DeviceSubscription = {
  subscriberId: string;
  tags: Map<string, ModbusTagConfig>; // tagId → config
  scanRate: number;
};

type DeviceConnection = {
  deviceId: string;
  host: string;
  port: number;
  unitId: number;
  byteOrder: ModbusByteOrder;
  client: ModbusClient;
  abortController: AbortController;
  polling: boolean;
  consecutiveFailures: number;
  lastValues: Map<string, number | boolean>; // for change detection
};

export type ScannerManager = {
  start: () => void;
  stop: () => Promise<void>;
};

// ─── Scanner factory ─────────────────────────────────────────────────────────

export function createScanner(nc: NatsConnection): ScannerManager {
  const connections = new Map<string, DeviceConnection>();
  // deviceId → (subscriberId → DeviceSubscription)
  const deviceSubscribers = new Map<string, Map<string, DeviceSubscription>>();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ─── Subscriber management ───────────────────────────────────────────────

  function getSubscribedTags(deviceId: string): ModbusTagConfig[] {
    const subs = deviceSubscribers.get(deviceId);
    if (!subs) return [];
    const byId = new Map<string, ModbusTagConfig>();
    for (const sub of subs.values()) {
      for (const [id, cfg] of sub.tags) {
        byId.set(id, cfg);
      }
    }
    return [...byId.values()];
  }

  function getEffectiveScanRate(deviceId: string): number {
    const subs = deviceSubscribers.get(deviceId);
    if (!subs || subs.size === 0) return DEFAULT_SCAN_RATE;
    let fastest = Infinity;
    for (const sub of subs.values()) {
      if (sub.scanRate < fastest) fastest = sub.scanRate;
    }
    return fastest === Infinity ? DEFAULT_SCAN_RATE : fastest;
  }

  function hasSubscribers(deviceId: string): boolean {
    const subs = deviceSubscribers.get(deviceId);
    return subs !== undefined && subs.size > 0;
  }

  function addSubscriber(req: ModbusSubscribeRequest): void {
    if (!deviceSubscribers.has(req.deviceId)) {
      deviceSubscribers.set(req.deviceId, new Map());
    }
    const subs = deviceSubscribers.get(req.deviceId)!;
    const existing = subs.get(req.subscriberId);
    if (existing) {
      for (const tag of req.tags) {
        existing.tags.set(tag.id, tag);
      }
      existing.scanRate = req.scanRate ?? DEFAULT_SCAN_RATE;
    } else {
      const tagMap = new Map<string, ModbusTagConfig>();
      for (const tag of req.tags) tagMap.set(tag.id, tag);
      subs.set(req.subscriberId, {
        subscriberId: req.subscriberId,
        tags: tagMap,
        scanRate: req.scanRate ?? DEFAULT_SCAN_RATE,
      });
    }
    log.modbus.info(
      `Subscribed ${req.tags.length} tags for ${req.subscriberId} on ${req.deviceId}`,
    );
  }

  /** Returns true if device has zero subscribers remaining */
  function removeSubscriber(req: ModbusUnsubscribeRequest): boolean {
    const subs = deviceSubscribers.get(req.deviceId);
    if (!subs) return true;
    const existing = subs.get(req.subscriberId);
    if (existing) {
      for (const id of req.tagIds) existing.tags.delete(id);
      if (existing.tags.size === 0) subs.delete(req.subscriberId);
    }
    if (subs.size === 0) {
      deviceSubscribers.delete(req.deviceId);
      return true;
    }
    return false;
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  function getBackoffDelay(failures: number): number {
    return Math.min(1000 * Math.pow(2, failures), 60_000);
  }

  async function pollDevice(conn: DeviceConnection): Promise<void> {
    const { abortController } = conn;

    while (!abortController.signal.aborted) {
      if (!hasSubscribers(conn.deviceId)) {
        log.modbus.info(`No subscribers for ${conn.deviceId}, stopping poll`);
        break;
      }

      // Ensure connected
      if (!conn.client.connected) {
        if (conn.consecutiveFailures > 0) {
          const delay = getBackoffDelay(conn.consecutiveFailures);
          log.modbus.debug(`Backoff ${delay}ms for ${conn.deviceId}`);
          await sleep(delay);
        }
        try {
          log.modbus.info(`Connecting to ${conn.host}:${conn.port}...`);
          await conn.client.connect(conn.host, conn.port);
          conn.consecutiveFailures = 0;
          log.modbus.info(`Connected to ${conn.deviceId} (${conn.host}:${conn.port})`);
        } catch (err) {
          conn.consecutiveFailures++;
          log.modbus.warn(`Connection failed for ${conn.deviceId}: ${err}`);
          continue;
        }
      }

      const scanStart = Date.now();
      const tags = getSubscribedTags(conn.deviceId);
      const scanRate = getEffectiveScanRate(conn.deviceId);

      try {
        const batch: BatchValue[] = await readAllTags(conn, tags);

        // Publish only changed values
        const changed = batch.filter(({ tagId, value }) => {
          const prev = conn.lastValues.get(tagId);
          return prev !== value;
        });

        for (const v of changed) conn.lastValues.set(v.tagId, v.value);
        if (changed.length > 0) publishBatch(nc, conn.deviceId, changed);

        conn.consecutiveFailures = 0;
      } catch (err) {
        conn.consecutiveFailures++;
        log.modbus.warn(`Read error on ${conn.deviceId}: ${err}`);
        // Force reconnect next iteration
        try { conn.client.disconnect(); } catch { /* ignore */ }
      }

      const elapsed = Date.now() - scanStart;
      const remaining = scanRate - elapsed;
      if (remaining > 0) await sleep(remaining);
    }

    // Clean up connection when done
    try { conn.client.disconnect(); } catch { /* ignore */ }
    connections.delete(conn.deviceId);
    log.modbus.info(`Polling stopped for ${conn.deviceId}`);
  }

  async function readAllTags(
    conn: DeviceConnection,
    tags: ModbusTagConfig[],
  ): Promise<BatchValue[]> {
    const results: BatchValue[] = [];

    // Group tags by function code
    const byFc = new Map<string, ModbusTagConfig[]>();
    for (const tag of tags) {
      const group = byFc.get(tag.functionCode) ?? [];
      group.push(tag);
      byFc.set(tag.functionCode, group);
    }

    for (const [fc, fcTags] of byFc) {
      const blocks = buildBlocks(fcTags);

      for (const block of blocks) {
        try {
          if (fc === "coil") {
            const bits = await readCoils(conn.client, conn.unitId, block.startAddr, block.count);
            for (const { config, wordOffset } of block.tags) {
              results.push({ tagId: config.id, value: bits[wordOffset], datatype: "boolean" });
            }
          } else if (fc === "discrete") {
            const bits = await readDiscreteInputs(conn.client, conn.unitId, block.startAddr, block.count);
            for (const { config, wordOffset } of block.tags) {
              results.push({ tagId: config.id, value: bits[wordOffset], datatype: "boolean" });
            }
          } else if (fc === "holding") {
            const words = await readHoldingRegisters(conn.client, conn.unitId, block.startAddr, block.count);
            for (const { config, wordOffset } of block.tags) {
              const byteOrder = config.byteOrder ?? conn.byteOrder;
              const value = decodeRegisters(words, wordOffset, config.datatype, byteOrder);
              results.push({
                tagId: config.id,
                value,
                datatype: config.datatype === "boolean" ? "boolean" : "number",
              });
            }
          } else if (fc === "input") {
            const words = await readInputRegisters(conn.client, conn.unitId, block.startAddr, block.count);
            for (const { config, wordOffset } of block.tags) {
              const byteOrder = config.byteOrder ?? conn.byteOrder;
              const value = decodeRegisters(words, wordOffset, config.datatype, byteOrder);
              results.push({
                tagId: config.id,
                value,
                datatype: config.datatype === "boolean" ? "boolean" : "number",
              });
            }
          }
        } catch (err) {
          log.modbus.warn(`Block read failed (fc=${fc}, addr=${block.startAddr}): ${err}`);
        }
      }
    }

    return results;
  }

  function ensurePolling(req: ModbusSubscribeRequest): void {
    if (connections.has(req.deviceId)) return; // already polling

    const client = new ModbusClient();
    const conn: DeviceConnection = {
      deviceId: req.deviceId,
      host: req.host,
      port: req.port ?? DEFAULT_PORT,
      unitId: req.unitId ?? DEFAULT_UNIT_ID,
      byteOrder: req.byteOrder ?? DEFAULT_BYTE_ORDER,
      client,
      abortController: new AbortController(),
      polling: true,
      consecutiveFailures: 0,
      lastValues: new Map(),
    };
    connections.set(req.deviceId, conn);
    pollDevice(conn);
  }

  async function stopDevice(deviceId: string): Promise<void> {
    const conn = connections.get(deviceId);
    if (!conn) return;
    conn.abortController.abort();
    // Connection cleanup happens inside pollDevice
  }

  // ─── Write command handler ───────────────────────────────────────────────

  function handleWriteCommand(tagId: string, rawValue: string): void {
    // Find which device owns this tag
    for (const [deviceId, subs] of deviceSubscribers) {
      for (const sub of subs.values()) {
        const tag = sub.tags.get(tagId);
        if (!tag) continue;

        const conn = connections.get(deviceId);
        if (!conn || !conn.client.connected) {
          log.modbus.warn(`Write command for ${tagId}: device not connected`);
          return;
        }

        // Parse value
        let value: number | boolean;
        if (tag.datatype === "boolean") {
          value = rawValue === "true" || rawValue === "1";
        } else {
          value = parseFloat(rawValue);
          if (isNaN(value)) {
            log.modbus.warn(`Invalid write value for ${tagId}: ${rawValue}`);
            return;
          }
        }

        const byteOrder = tag.byteOrder ?? conn.byteOrder;

        // Choose write function
        (async () => {
          try {
            if (tag.functionCode === "coil") {
              await writeSingleCoil(conn.client, conn.unitId, tag.address, Boolean(value));
            } else if (tag.functionCode === "holding") {
              if (tag.datatype === "int16" || tag.datatype === "uint16" || tag.datatype === "boolean") {
                await writeSingleRegister(conn.client, conn.unitId, tag.address, Number(value) & 0xffff);
              } else {
                const words = encodeValue(value, tag.datatype, byteOrder);
                await writeMultipleRegisters(conn.client, conn.unitId, tag.address, words);
              }
            } else {
              log.modbus.warn(`Tag ${tagId} is read-only (fc=${tag.functionCode})`);
            }
            log.modbus.debug(`Wrote ${value} to ${tagId} (${tag.functionCode}:${tag.address})`);
          } catch (err) {
            log.modbus.error(`Write failed for ${tagId}: ${err}`);
          }
        })();

        return;
      }
    }
    log.modbus.warn(`Write command for unknown tag: ${tagId}`);
  }

  // ─── NATS subscriptions ──────────────────────────────────────────────────

  let subscriptions: ReturnType<typeof nc.subscribe>[] = [];

  function start(): void {
    // modbus.subscribe
    const subSub = nc.subscribe(`${MODULE_ID}.subscribe`);
    subscriptions.push(subSub);
    (async () => {
      for await (const msg of subSub) {
        try {
          const req: ModbusSubscribeRequest = JSON.parse(decoder.decode(msg.data));
          addSubscriber(req);
          ensurePolling(req);
          if (msg.reply) {
            msg.respond(encoder.encode(JSON.stringify({
              success: true,
              count: req.tags.length,
            })));
          }
        } catch (err) {
          log.modbus.error(`subscribe handler error: ${err}`);
          if (msg.reply) {
            msg.respond(encoder.encode(JSON.stringify({ success: false, error: String(err) })));
          }
        }
      }
    })();

    // modbus.unsubscribe
    const unsubSub = nc.subscribe(`${MODULE_ID}.unsubscribe`);
    subscriptions.push(unsubSub);
    (async () => {
      for await (const msg of unsubSub) {
        try {
          const req: ModbusUnsubscribeRequest = JSON.parse(decoder.decode(msg.data));
          const empty = removeSubscriber(req);
          if (empty) await stopDevice(req.deviceId);
          if (msg.reply) {
            msg.respond(encoder.encode(JSON.stringify({ success: true })));
          }
        } catch (err) {
          log.modbus.error(`unsubscribe handler error: ${err}`);
          if (msg.reply) {
            msg.respond(encoder.encode(JSON.stringify({ success: false, error: String(err) })));
          }
        }
      }
    })();

    // modbus.command.>
    const cmdSub = nc.subscribe(`${MODULE_ID}.command.>`);
    subscriptions.push(cmdSub);
    (async () => {
      for await (const msg of cmdSub) {
        try {
          // Extract tagId from subject: modbus.command.{tagId}
          const tagId = msg.subject.slice(`${MODULE_ID}.command.`.length);
          const rawValue = decoder.decode(msg.data);
          handleWriteCommand(tagId, rawValue);
        } catch (err) {
          log.modbus.error(`command handler error: ${err}`);
        }
      }
    })();

    log.service.info("Scanner started — waiting for subscribe requests");
  }

  async function stop(): Promise<void> {
    // Abort all polling loops
    for (const conn of connections.values()) {
      conn.abortController.abort();
    }
    // Unsubscribe from NATS
    for (const sub of subscriptions) {
      sub.unsubscribe();
    }
    subscriptions = [];
    log.service.info("Scanner stopped");
  }

  return { start, stop };
}
