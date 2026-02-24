/**
 * Function code integration tests.
 *
 * Runs each FC against the Deno test fixture server to validate that
 * our client sends correctly-framed requests AND correctly parses responses.
 * Breaks the echo-chamber risk at the PDU level: the server independently
 * validates request bytes via RecordedRequest.
 */

import { assertEquals, assertAlmostEquals, assertRejects } from "@std/assert";
import { ModbusClient } from "../src/modbus/client.ts";
import {
  readCoils,
  readDiscreteInputs,
  readHoldingRegisters,
  readInputRegisters,
  writeSingleCoil,
  writeSingleRegister,
  writeMultipleCoils,
  writeMultipleRegisters,
} from "../src/modbus/functions.ts";
import { ModbusTestServer } from "./server/modbus_server.ts";

const UNIT_ID = 1;

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

// ─── FC01 Read Coils ─────────────────────────────────────────────────────────

Deno.test("FC01: reads coils from server", async () => {
  await withServer(async (client, server) => {
    server.setCoil(0, true).setCoil(1, false).setCoil(2, true);
    const bits = await readCoils(client, UNIT_ID, 0, 3);
    assertEquals(bits, [true, false, true]);
  });
});

Deno.test("FC01: request recorded with correct address and count", async () => {
  await withServer(async (client, server) => {
    await readCoils(client, UNIT_ID, 0x0013, 37);
    assertEquals(server.requests[0].fc, 0x01);
    assertEquals(server.requests[0].addr, 0x0013);
    assertEquals(server.requests[0].count, 37);
  });
});

Deno.test("FC01: reads 8+ coils across byte boundary", async () => {
  await withServer(async (client, server) => {
    server.setCoil(7, true).setCoil(8, true);
    const bits = await readCoils(client, UNIT_ID, 0, 10);
    assertEquals(bits[7], true);
    assertEquals(bits[8], true);
    assertEquals(bits[0], false);
  });
});

// ─── FC02 Read Discrete Inputs ───────────────────────────────────────────────

Deno.test("FC02: reads discrete inputs from server", async () => {
  await withServer(async (client, server) => {
    server.setDiscrete(5, true);
    const bits = await readDiscreteInputs(client, UNIT_ID, 0, 8);
    assertEquals(bits[5], true);
    assertEquals(bits[0], false);
  });
});

// ─── FC03 Read Holding Registers ─────────────────────────────────────────────

Deno.test("FC03: reads holding registers matching spec Table 15", async () => {
  await withServer(async (client, server) => {
    // Spec Table 16 response values: 0x022B, 0x0000, 0x0064
    server.setHolding(0x006B, 0x022B, 0x0000, 0x0064);
    const words = await readHoldingRegisters(client, UNIT_ID, 0x006B, 3);
    assertEquals(words[0], 0x022B);
    assertEquals(words[1], 0x0000);
    assertEquals(words[2], 0x0064);
  });
});

Deno.test("FC03: request recorded with correct address and count", async () => {
  await withServer(async (client, server) => {
    await readHoldingRegisters(client, UNIT_ID, 0x006B, 3);
    assertEquals(server.requests[0].fc, 0x03);
    assertEquals(server.requests[0].addr, 0x006B);
    assertEquals(server.requests[0].count, 3);
  });
});

Deno.test("FC03: π float32 words decode correctly end-to-end", async () => {
  await withServer(async (client, server) => {
    // π as ABCD words: [0x4049, 0x0FDB]
    server.setHolding(10, 0x4049, 0x0FDB);
    const words = await readHoldingRegisters(client, UNIT_ID, 10, 2);
    assertEquals(words[0], 0x4049);
    assertEquals(words[1], 0x0FDB);
    // Decode via DataView to verify
    const view = new DataView(new Uint8Array([0x40, 0x49, 0x0F, 0xDB]).buffer);
    assertAlmostEquals(view.getFloat32(0, false), Math.PI, 1e-6);
  });
});

// ─── FC04 Read Input Registers ───────────────────────────────────────────────

Deno.test("FC04: reads input registers from server", async () => {
  await withServer(async (client, server) => {
    server.setInput(0, 0xDEAD, 0xBEEF);
    const words = await readInputRegisters(client, UNIT_ID, 0, 2);
    assertEquals(words[0], 0xDEAD);
    assertEquals(words[1], 0xBEEF);
  });
});

// ─── FC05 Write Single Coil ──────────────────────────────────────────────────

Deno.test("FC05: writes coil ON and server stores true", async () => {
  await withServer(async (client, server) => {
    await writeSingleCoil(client, UNIT_ID, 0x00AC, true);
    assertEquals(server.coils.get(0x00AC), true);
    // Verify request recorded correctly
    assertEquals(server.requests[0].fc, 0x05);
    assertEquals(server.requests[0].addr, 0x00AC);
  });
});

Deno.test("FC05: writes coil OFF and server stores false", async () => {
  await withServer(async (client, server) => {
    server.setCoil(0, true);
    await writeSingleCoil(client, UNIT_ID, 0, false);
    assertEquals(server.coils.get(0), false);
  });
});

// ─── FC06 Write Single Register ─────────────────────────────────────────────

Deno.test("FC06: writes single register and server stores value", async () => {
  await withServer(async (client, server) => {
    await writeSingleRegister(client, UNIT_ID, 0x0001, 0x0003);
    assertEquals(server.holding.get(0x0001), 0x0003);
    assertEquals(server.requests[0].fc, 0x06);
    assertEquals(server.requests[0].addr, 0x0001);
  });
});

// ─── FC15 Write Multiple Coils ───────────────────────────────────────────────

Deno.test("FC15: writes multiple coils across byte boundary", async () => {
  await withServer(async (client, server) => {
    const values = [true, false, true, false, true, false, true, false, true];
    await writeMultipleCoils(client, UNIT_ID, 0, values);
    assertEquals(server.coils.get(0), true);
    assertEquals(server.coils.get(1), false);
    assertEquals(server.coils.get(8), true);
  });
});

// ─── FC16 Write Multiple Registers ──────────────────────────────────────────

Deno.test("FC16: writes multiple registers and server stores all words", async () => {
  await withServer(async (client, server) => {
    // π as ABCD words: [0x4049, 0x0FDB]
    const words = new Uint16Array([0x4049, 0x0FDB]);
    await writeMultipleRegisters(client, UNIT_ID, 20, words);
    assertEquals(server.holding.get(20), 0x4049);
    assertEquals(server.holding.get(21), 0x0FDB);
    assertEquals(server.requests[0].fc, 0x10);
    assertEquals(server.requests[0].addr, 20);
    assertEquals(server.requests[0].count, 2);
  });
});

// ─── Exception handling ───────────────────────────────────────────────────────

Deno.test("client rejects promise on Modbus exception response", async () => {
  await withServer(async (client, server) => {
    // Inject exception code 0x02 (illegal data address) for FC03
    server.injectException(0x03, 0x02);
    await assertRejects(
      () => readHoldingRegisters(client, UNIT_ID, 0, 1),
      Error,
      "Modbus exception",
    );
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

Deno.test(
  "client rejects on timeout when server drops connection",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const server = new ModbusTestServer();
    await server.start();
    server.dropNextConnections(1);
    const client = new ModbusClient();
    try {
      await client.connect("127.0.0.1", server.port);
      await new Promise((r) => setTimeout(r, 50));
      await assertRejects(
        () => readHoldingRegisters(client, UNIT_ID, 0, 1),
        Error,
      );
    } finally {
      await client.disconnect();
      await server.stop();
    }
  },
);
