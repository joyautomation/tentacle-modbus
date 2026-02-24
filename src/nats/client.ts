import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { log } from "../utils/logger.ts";

/**
 * Connect to NATS, retrying indefinitely every 5 seconds on failure.
 */
export async function connectToNats(servers: string): Promise<NatsConnection> {
  const serverList = servers.split(",").map((s) => s.trim());
  while (true) {
    try {
      log.nats.info(`Connecting to NATS at ${servers}...`);
      const nc = await connect({ servers: serverList });
      log.nats.info("Connected to NATS");
      return nc;
    } catch (err) {
      log.nats.warn(`Failed to connect to NATS: ${err}. Retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
