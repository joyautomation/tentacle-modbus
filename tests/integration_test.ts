/**
 * Integration tests: full block-read + decode pipeline.
 *
 * Tests the readAllTags path (block grouping → FC read → decode → typed value)
 * using the test fixture server. Exercises multiple datatypes, byte orders,
 * and mixed function codes in a single scan.
 */

import { assertEquals, assertAlmostEquals } from "@std/assert";
import { ModbusClient } from "../src/modbus/client.ts";
import { readHoldingRegisters, readCoils, readInputRegisters } from "../src/modbus/functions.ts";
import { buildBlocks } from "../src/modbus/blocks.ts";
import { decodeRegisters } from "../src/modbus/decode.ts";
import { ModbusTestServer } from "./server/modbus_server.ts";
import type { ModbusTagConfig } from "../types/config.ts";

async function withServer(
  fn: (client: ModbusClient, server: ModbusTestServer) => Promise<void>,
): Promise<void> {
  const server = new ModbusTestServer();
  await server.start();
  const client = new ModbusClient();
  await client.connect("127.0.0.1", server.port);
  try {
    await fn(client, server);
  } finally {
    await client.disconnect();
    await server.stop();
  }
}

function tag(
  id: string,
  address: number,
  datatype: ModbusTagConfig["datatype"],
  functionCode: ModbusTagConfig["functionCode"] = "holding",
  byteOrder: ModbusTagConfig["byteOrder"] = "ABCD",
): ModbusTagConfig {
  return { id, address, functionCode, datatype, byteOrder };
}

// ─── Block read + decode ─────────────────────────────────────────────────────

Deno.test("block read: adjacent int16 tags read in one request", async () => {
  await withServer(async (client, server) => {
    server.setHolding(0, 100, 200, 300);
    const tags = [tag("a", 0, "int16"), tag("b", 1, "int16"), tag("c", 2, "int16")];
    const blocks = buildBlocks(tags);
    assertEquals(blocks.length, 1);

    const words = await readHoldingRegisters(client, 1, blocks[0].startAddr, blocks[0].count);
    assertEquals(server.requests.length, 1); // one request for all three

    const results = new Map<string, number | boolean>();
    for (const { config, wordOffset } of blocks[0].tags) {
      results.set(config.id, decodeRegisters(words, wordOffset, config.datatype, "ABCD"));
    }
    assertEquals(results.get("a"), 100);
    assertEquals(results.get("b"), 200);
    assertEquals(results.get("c"), 300);
  });
});

Deno.test("block read: float32 ABCD spanning 2 registers", async () => {
  await withServer(async (client, server) => {
    // π as ABCD words at address 5
    server.setHolding(5, 0x4049, 0x0FDB);
    const tags = [tag("pi", 5, "float32")];
    const blocks = buildBlocks(tags);
    const words = await readHoldingRegisters(client, 1, blocks[0].startAddr, blocks[0].count);
    assertAlmostEquals(
      decodeRegisters(words, blocks[0].tags[0].wordOffset, "float32", "ABCD") as number,
      Math.PI,
      1e-6,
    );
  });
});

Deno.test("block read: sparse tags create two separate requests", async () => {
  await withServer(async (client, server) => {
    server.setHolding(0, 42).setHolding(200, 99);
    const tags = [tag("a", 0, "uint16"), tag("b", 200, "uint16")];
    const blocks = buildBlocks(tags);
    assertEquals(blocks.length, 2);

    const results = new Map<string, number | boolean>();
    for (const block of blocks) {
      const words = await readHoldingRegisters(client, 1, block.startAddr, block.count);
      for (const { config, wordOffset } of block.tags) {
        results.set(config.id, decodeRegisters(words, wordOffset, config.datatype, "ABCD"));
      }
    }
    assertEquals(server.requests.length, 2);
    assertEquals(results.get("a"), 42);
    assertEquals(results.get("b"), 99);
  });
});

Deno.test("block read: gap tags within MAX_GAP read in one request", async () => {
  await withServer(async (client, server) => {
    server.setHolding(0, 10).setHolding(5, 20); // gap of 4 registers (within MAX_GAP=10)
    const tags = [tag("a", 0, "uint16"), tag("b", 5, "uint16")];
    const blocks = buildBlocks(tags);
    assertEquals(blocks.length, 1);

    const words = await readHoldingRegisters(client, 1, blocks[0].startAddr, blocks[0].count);
    assertEquals(server.requests.length, 1);

    const aOffset = blocks[0].tags.find((t) => t.config.id === "a")!.wordOffset;
    const bOffset = blocks[0].tags.find((t) => t.config.id === "b")!.wordOffset;
    assertEquals(decodeRegisters(words, aOffset, "uint16", "ABCD"), 10);
    assertEquals(decodeRegisters(words, bOffset, "uint16", "ABCD"), 20);
  });
});

// ─── Mixed function codes ────────────────────────────────────────────────────

Deno.test("mixed FC: coils and holding registers read independently", async () => {
  await withServer(async (client, server) => {
    server.setHolding(0, 0x1234);
    server.setCoil(0, true).setCoil(1, false);

    const holdingTags = [tag("reg", 0, "uint16", "holding")];
    const coilTags = [tag("coil0", 0, "boolean", "coil"), tag("coil1", 1, "boolean", "coil")];

    const holdingBlocks = buildBlocks(holdingTags);
    const coilBlocks = buildBlocks(coilTags);

    const holdingWords = await readHoldingRegisters(client, 1, holdingBlocks[0].startAddr, holdingBlocks[0].count);
    // For coils, we use readCoils which returns booleans directly
    const coilBits = await readCoils(client, 1, coilBlocks[0].startAddr, coilBlocks[0].count);

    assertEquals(decodeRegisters(holdingWords, 0, "uint16", "ABCD"), 0x1234);
    assertEquals(coilBits[0], true);
    assertEquals(coilBits[1], false);
  });
});

// ─── Byte order variants ─────────────────────────────────────────────────────

Deno.test("float32 DCBA: π reads correctly", async () => {
  await withServer(async (client, server) => {
    // π as DCBA words: [0xDB0F, 0x4940]
    server.setHolding(0, 0xDB0F, 0x4940);
    const words = await readHoldingRegisters(client, 1, 0, 2);
    assertAlmostEquals(decodeRegisters(words, 0, "float32", "DCBA") as number, Math.PI, 1e-6);
  });
});

// ─── Write → read round-trip ─────────────────────────────────────────────────

Deno.test("write then read: single register round-trip", async () => {
  await withServer(async (client, server) => {
    // Write 0x1234 to address 5
    const { writeSingleRegister } = await import("../src/modbus/functions.ts");
    await writeSingleRegister(client, 1, 5, 0x1234);
    // Read it back
    const words = await readHoldingRegisters(client, 1, 5, 1);
    assertEquals(words[0], 0x1234);
    assertEquals(server.holding.get(5), 0x1234);
  });
});

Deno.test("write then read: float32 multi-register round-trip", async () => {
  await withServer(async (client, server) => {
    const { writeMultipleRegisters } = await import("../src/modbus/functions.ts");
    const { encodeValue } = await import("../src/modbus/decode.ts");
    const value = 42.5;
    const words = encodeValue(value, "float32", "ABCD");
    await writeMultipleRegisters(client, 1, 10, words);

    const readBack = await readHoldingRegisters(client, 1, 10, 2);
    assertAlmostEquals(decodeRegisters(readBack, 0, "float32", "ABCD") as number, value, 1e-5);
  });
});

// ─── Reconnection ────────────────────────────────────────────────────────────

Deno.test(
  "client reconnects after server drops connection",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const server = new ModbusTestServer();
    await server.start();
    server.setHolding(0, 0xABCD);

    const client = new ModbusClient();
    await client.connect("127.0.0.1", server.port);

    const words1 = await readHoldingRegisters(client, 1, 0, 1);
    assertEquals(words1[0], 0xABCD);

    // Stop and restart server (simulates network drop)
    await server.stop();
    await new Promise((r) => setTimeout(r, 50));
    await server.start();
    server.setHolding(0, 0x1234);

    // Reconnect client to new port
    await client.connect("127.0.0.1", server.port);
    const words2 = await readHoldingRegisters(client, 1, 0, 1);
    assertEquals(words2[0], 0x1234);

    await client.disconnect();
    await server.stop();
  },
);
