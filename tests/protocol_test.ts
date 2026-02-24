/**
 * Protocol spec-byte tests.
 *
 * Each assertion validates the raw bytes produced or parsed by
 * protocol.ts against the Modbus Application Protocol Specification
 * V1.1b3 (Modbus.org). No network required.
 *
 * Spec references:
 *   Section 4.1 — MBAP Header description
 *   Table 15    — FC03 Request example
 */

import { assertEquals } from "@std/assert";
import { encodeFrame, decodeMbapHeader, frameLength } from "../src/modbus/protocol.ts";

// ─── encodeFrame ────────────────────────────────────────────────────────────

Deno.test("encodeFrame: FC03 request matches Modbus spec Table 15", () => {
  // Spec: Read 3 holding registers starting at 0x006B
  // PDU:  [0x03, 0x00, 0x6B, 0x00, 0x03]
  // MBAP with TxID=0x0001, UnitID=0x01:
  //   [0x00,0x01, 0x00,0x00, 0x00,0x06, 0x01, 0x03,0x00,0x6B,0x00,0x03]
  const pdu = new Uint8Array([0x03, 0x00, 0x6b, 0x00, 0x03]);
  const frame = encodeFrame(0x0001, 0x01, pdu);
  assertEquals(frame, new Uint8Array([
    0x00, 0x01, // Transaction ID
    0x00, 0x00, // Protocol ID
    0x00, 0x06, // Length = 1 (unitId) + 5 (PDU)
    0x01,       // Unit ID
    0x03, 0x00, 0x6b, 0x00, 0x03, // PDU
  ]));
});

Deno.test("encodeFrame: FC05 write single coil ON matches spec Table 23", () => {
  // Spec: Write coil at 0x00AC to ON (0xFF00)
  // PDU: [0x05, 0x00, 0xAC, 0xFF, 0x00]
  const pdu = new Uint8Array([0x05, 0x00, 0xAC, 0xFF, 0x00]);
  const frame = encodeFrame(0x0002, 0x01, pdu);
  assertEquals(frame, new Uint8Array([
    0x00, 0x02,
    0x00, 0x00,
    0x00, 0x06,
    0x01,
    0x05, 0x00, 0xAC, 0xFF, 0x00,
  ]));
});

Deno.test("encodeFrame: FC01 request for 37 coils from address 0x13", () => {
  // Spec Table 1: Read 37 (0x25) coils starting at 0x0013
  const pdu = new Uint8Array([0x01, 0x00, 0x13, 0x00, 0x25]);
  const frame = encodeFrame(0x0003, 0x01, pdu);
  assertEquals(frame[6], 0x01); // unit ID
  assertEquals(frame.slice(7), pdu);
  // Length field = 1 + 5 = 6
  assertEquals((frame[4] << 8) | frame[5], 6);
});

Deno.test("encodeFrame: protocol ID is always 0x0000", () => {
  const frame = encodeFrame(0xFFFF, 0xFF, new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x01]));
  assertEquals(frame[2], 0x00);
  assertEquals(frame[3], 0x00);
});

Deno.test("encodeFrame: transaction ID wraps correctly at 0xFFFF", () => {
  const pdu = new Uint8Array([0x06, 0x00, 0x00, 0x00, 0x01]);
  const frame = encodeFrame(0xFFFF, 0x01, pdu);
  assertEquals(frame[0], 0xFF);
  assertEquals(frame[1], 0xFF);
});

// ─── decodeMbapHeader ───────────────────────────────────────────────────────

Deno.test("decodeMbapHeader: parses spec Table 15 frame prefix", () => {
  const frame = new Uint8Array([
    0x00, 0x01, // Transaction ID = 1
    0x00, 0x00, // Protocol ID
    0x00, 0x06, // Length = 6
    0x01,       // Unit ID = 1
    0x03, 0x00, 0x6b, 0x00, 0x03,
  ]);
  const header = decodeMbapHeader(frame);
  assertEquals(header.transactionId, 0x0001);
  assertEquals(header.length, 6);
  assertEquals(header.unitId, 0x01);
});

Deno.test("decodeMbapHeader: round-trips with encodeFrame", () => {
  const pdu = new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x04]);
  const frame = encodeFrame(0xABCD, 0x05, pdu);
  const header = decodeMbapHeader(frame);
  assertEquals(header.transactionId, 0xABCD);
  assertEquals(header.unitId, 0x05);
  assertEquals(header.length, 1 + pdu.length); // 6
});

// ─── frameLength ────────────────────────────────────────────────────────────

Deno.test("frameLength: total bytes = 6 + mbapLength", () => {
  // FC03 request: MBAP length = 6 (1 unitId + 5 PDU), total = 12
  assertEquals(frameLength(6), 12);
  // Minimal 1-byte PDU: length = 2 (1 unitId + 1 PDU), total = 8
  assertEquals(frameLength(2), 8);
});
