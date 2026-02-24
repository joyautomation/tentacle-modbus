/**
 * Pymodbus smoke tests — third-party server validation.
 *
 * Tests our client against a real pymodbus server to confirm that our
 * protocol framing is correct against an independent implementation.
 *
 * The pymodbus server initialises holding/input registers with value=address
 * (register N has value N), coils/discretes all false.
 *
 * Requires pymodbus_server.py to be running:
 *   python scripts/pymodbus_server.py &
 *
 * Skipped if PYMODBUS_PORT env var is not set (opt-in for CI / local use).
 */

import { assertEquals, assertAlmostEquals } from "@std/assert";
import { ModbusClient } from "../src/modbus/client.ts";
import {
  readHoldingRegisters,
  readInputRegisters,
  readCoils,
  writeSingleCoil,
  writeSingleRegister,
  writeMultipleRegisters,
} from "../src/modbus/functions.ts";
import { decodeRegisters, encodeValue } from "../src/modbus/decode.ts";

const PYMODBUS_HOST = Deno.env.get("PYMODBUS_HOST") ?? "127.0.0.1";
const PYMODBUS_PORT = parseInt(Deno.env.get("PYMODBUS_PORT") ?? "0");
const UNIT_ID = 1;

function skip(name: string): void {
  Deno.test(name, { ignore: PYMODBUS_PORT === 0 }, () => {});
}

// Use a real test when the server is available, skip otherwise
function smokeTest(name: string, fn: (client: ModbusClient) => Promise<void>): void {
  Deno.test(name, { ignore: PYMODBUS_PORT === 0 }, async () => {
    const client = new ModbusClient();
    await client.connect(PYMODBUS_HOST, PYMODBUS_PORT);
    try {
      await fn(client);
    } finally {
      await client.disconnect();
    }
  });
}

// Silence the unused skip import warning
skip;

// ─── Reads ───────────────────────────────────────────────────────────────────

smokeTest("pymodbus FC03: holding register N has value N", async (client) => {
  // Registers 0-4 should be 0,1,2,3,4
  const words = await readHoldingRegisters(client, UNIT_ID, 0, 5);
  assertEquals(Array.from(words), [0, 1, 2, 3, 4]);
});

smokeTest("pymodbus FC04: input register N has value N", async (client) => {
  const words = await readInputRegisters(client, UNIT_ID, 10, 3);
  assertEquals(Array.from(words), [10, 11, 12]);
});

smokeTest("pymodbus FC01: coils initialised to false", async (client) => {
  const bits = await readCoils(client, UNIT_ID, 0, 8);
  assertEquals(bits.every((b) => b === false), true);
});

// ─── Writes + read-back ──────────────────────────────────────────────────────

smokeTest("pymodbus FC06 + FC03: write single register, read back", async (client) => {
  await writeSingleRegister(client, UNIT_ID, 100, 0xABCD);
  const words = await readHoldingRegisters(client, UNIT_ID, 100, 1);
  assertEquals(words[0], 0xABCD);
});

smokeTest("pymodbus FC05 + FC01: write coil ON, read back", async (client) => {
  await writeSingleCoil(client, UNIT_ID, 50, true);
  const bits = await readCoils(client, UNIT_ID, 50, 1);
  assertEquals(bits[0], true);
});

smokeTest("pymodbus FC16 + FC03: write float32, read back and decode", async (client) => {
  const value = 1234.5;
  const words = encodeValue(value, "float32", "ABCD");
  await writeMultipleRegisters(client, UNIT_ID, 150, words);
  const readBack = await readHoldingRegisters(client, UNIT_ID, 150, 2);
  assertAlmostEquals(
    decodeRegisters(readBack, 0, "float32", "ABCD") as number,
    value,
    1e-3,
  );
});

smokeTest("pymodbus FC16 + FC03: write int32, read back and decode", async (client) => {
  const value = -100000;
  const words = encodeValue(value, "int32", "ABCD");
  await writeMultipleRegisters(client, UNIT_ID, 160, words);
  const readBack = await readHoldingRegisters(client, UNIT_ID, 160, 2);
  assertEquals(decodeRegisters(readBack, 0, "int32", "ABCD"), value);
});

// ─── Block read sanity ───────────────────────────────────────────────────────

smokeTest("pymodbus block read: 10 contiguous registers in one request", async (client) => {
  // Registers 0-9 should be 0-9 (pymodbus default)
  const words = await readHoldingRegisters(client, UNIT_ID, 0, 10);
  for (let i = 0; i < 10; i++) {
    assertEquals(words[i], i, `register ${i} should equal ${i}`);
  }
});
