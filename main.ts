/**
 * tentacle-modbus Service
 *
 * Standalone Modbus TCP → NATS bridge.
 * Stateless: starts with zero device connections. Connections are created
 * on-demand when clients send modbus.subscribe requests.
 *
 * Environment variables:
 *   NATS_SERVERS — NATS server URL(s), comma-separated (default: localhost:4222)
 *
 * Run with:
 *   deno run --allow-net --allow-env main.ts
 */

import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createLogger, LogLevel } from "@joyautomation/coral";
import { connectToNats } from "./src/nats/client.ts";
import { createScanner } from "./src/service/scanner.ts";
import { enableNatsLogging } from "./src/utils/logger.ts";
import type { ServiceHeartbeat } from "@tentacle/nats-schema";

const log = createLogger("modbus", LogLevel.info);

async function main(): Promise<void> {
  log.info("═══════════════════════════════════════════════════════════════");
  log.info("               tentacle-modbus Service");
  log.info("═══════════════════════════════════════════════════════════════");

  const natsServers = Deno.env.get("NATS_SERVERS") || "localhost:4222";
  log.info(`NATS Servers: ${natsServers}`);

  const nc = await connectToNats(natsServers);

  // Enable NATS log streaming
  enableNatsLogging(nc, "modbus", "modbus");

  // Monitor NATS connection closure
  (async () => {
    const err = await nc.closed();
    if (err) log.error(`NATS connection closed with error: ${err}`);
  })();

  // Create and start scanner
  log.info("Initializing scanner...");
  const scanner = createScanner(nc);
  scanner.start();

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  const js = jetstream(nc);
  const kvm = new Kvm(js);
  const heartbeatsKv = await kvm.create("service_heartbeats", {
    history: 1,
    ttl: 60 * 1000, // 60s TTL
  });

  const heartbeatKey = "modbus";
  const startedAt = Date.now();

  const publishHeartbeat = async () => {
    const heartbeat: ServiceHeartbeat = {
      serviceType: "modbus",
      moduleId: "modbus",
      lastSeen: Date.now(),
      startedAt,
      metadata: {},
    };
    try {
      const encoder = new TextEncoder();
      await heartbeatsKv.put(heartbeatKey, encoder.encode(JSON.stringify(heartbeat)));
    } catch (err) {
      log.warn(`Failed to publish heartbeat: ${err}`);
    }
  };

  await publishHeartbeat();
  log.info("Service heartbeat started (moduleId: modbus)");

  const heartbeatInterval = setInterval(publishHeartbeat, 10_000);

  log.info("");
  log.info("Service running. Waiting for subscribe requests...");
  log.info("");

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(heartbeatInterval);
    try {
      await heartbeatsKv.delete(heartbeatKey);
    } catch { /* already expired */ }
    await scanner.stop();
    await nc.drain();
    log.info("Shutdown complete");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));

  // Also accept a NATS shutdown command
  const shutdownSub = nc.subscribe("modbus.shutdown");
  (async () => {
    for await (const _msg of shutdownSub) {
      log.info("Received shutdown command via NATS");
      await shutdown("NATS shutdown");
      break;
    }
  })();
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`Fatal error: ${err}`);
    Deno.exit(1);
  });
}
