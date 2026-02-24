/**
 * Decode / encode spec-byte tests.
 *
 * Validates that register words are decoded to the correct typed values
 * against independently-calculated IEEE 754 / two's complement byte sequences.
 * No network required.
 *
 * Known values used as ground truth (from IEEE 754 converter + Modbus spec):
 *
 *   π ≈ 3.14159265 → IEEE 754 float32: 0x40490FDB
 *     ABCD words: [0x4049, 0x0FDB]
 *     DCBA words: [0xDB0F, 0x4940]
 *     BADC words: [0x4940, 0xDB0F]
 *     CDAB words: [0x0FDB, 0x4049]
 *
 *   100000 → uint32: 0x000186A0
 *     ABCD words: [0x0001, 0x86A0]
 */

import { assertEquals, assertAlmostEquals } from "@std/assert";
import { decodeRegisters, encodeValue, registerCount } from "../src/modbus/decode.ts";

// ─── registerCount ───────────────────────────────────────────────────────────

Deno.test("registerCount: single-register types", () => {
  assertEquals(registerCount("boolean"), 1);
  assertEquals(registerCount("int16"), 1);
  assertEquals(registerCount("uint16"), 1);
});

Deno.test("registerCount: two-register types", () => {
  assertEquals(registerCount("int32"), 2);
  assertEquals(registerCount("uint32"), 2);
  assertEquals(registerCount("float32"), 2);
});

Deno.test("registerCount: four-register types", () => {
  assertEquals(registerCount("float64"), 4);
});

// ─── decodeRegisters: int16 / uint16 ────────────────────────────────────────

Deno.test("decode int16 positive", () => {
  // 0x0064 = 100 signed
  const words = new Uint16Array([0x0064]);
  assertEquals(decodeRegisters(words, 0, "int16", "ABCD"), 100);
});

Deno.test("decode int16 negative (two's complement)", () => {
  // 0xFF9C = -100 in two's complement
  const words = new Uint16Array([0xFF9C]);
  assertEquals(decodeRegisters(words, 0, "int16", "ABCD"), -100);
});

Deno.test("decode uint16 max", () => {
  const words = new Uint16Array([0xFFFF]);
  assertEquals(decodeRegisters(words, 0, "uint16", "ABCD"), 65535);
});

Deno.test("decode boolean: non-zero register = true", () => {
  assertEquals(decodeRegisters(new Uint16Array([1]), 0, "boolean", "ABCD"), true);
  assertEquals(decodeRegisters(new Uint16Array([0xFF]), 0, "boolean", "ABCD"), true);
});

Deno.test("decode boolean: zero register = false", () => {
  assertEquals(decodeRegisters(new Uint16Array([0]), 0, "boolean", "ABCD"), false);
});

// ─── decodeRegisters: float32 all byte orders ────────────────────────────────

Deno.test("decode float32 ABCD (big-endian, standard)", () => {
  // π → 0x40490FDB → words [0x4049, 0x0FDB]
  const words = new Uint16Array([0x4049, 0x0FDB]);
  assertAlmostEquals(decodeRegisters(words, 0, "float32", "ABCD") as number, Math.PI, 1e-6);
});

Deno.test("decode float32 DCBA (little-endian)", () => {
  // π reversed bytes: [0xDB, 0x0F, 0x49, 0x40] → words [0xDB0F, 0x4940]
  const words = new Uint16Array([0xDB0F, 0x4940]);
  assertAlmostEquals(decodeRegisters(words, 0, "float32", "DCBA") as number, Math.PI, 1e-6);
});

Deno.test("decode float32 BADC (byte-swapped)", () => {
  // bytes arrive as [B,A,D,C] = [0x49,0x40,0xDB,0x0F] → words [0x4940, 0xDB0F]
  const words = new Uint16Array([0x4940, 0xDB0F]);
  assertAlmostEquals(decodeRegisters(words, 0, "float32", "BADC") as number, Math.PI, 1e-6);
});

Deno.test("decode float32 CDAB (word-swapped)", () => {
  // bytes arrive as [C,D,A,B] = [0x0F,0xDB,0x40,0x49] → words [0x0FDB, 0x4049]
  const words = new Uint16Array([0x0FDB, 0x4049]);
  assertAlmostEquals(decodeRegisters(words, 0, "float32", "CDAB") as number, Math.PI, 1e-6);
});

// ─── decodeRegisters: int32 / uint32 ────────────────────────────────────────

Deno.test("decode uint32 ABCD: 100000 = 0x000186A0", () => {
  const words = new Uint16Array([0x0001, 0x86A0]);
  assertEquals(decodeRegisters(words, 0, "uint32", "ABCD"), 100000);
});

Deno.test("decode int32 ABCD: -1 = 0xFFFFFFFF", () => {
  const words = new Uint16Array([0xFFFF, 0xFFFF]);
  assertEquals(decodeRegisters(words, 0, "int32", "ABCD"), -1);
});

// ─── decodeRegisters: word offset ───────────────────────────────────────────

Deno.test("decode with non-zero word offset (block read simulation)", () => {
  // Block contains [garbage, garbage, 0x4049, 0x0FDB]
  const words = new Uint16Array([0x0000, 0x1234, 0x4049, 0x0FDB]);
  assertAlmostEquals(decodeRegisters(words, 2, "float32", "ABCD") as number, Math.PI, 1e-6);
});

// ─── encodeValue: round-trip ─────────────────────────────────────────────────

Deno.test("encodeValue/decodeRegisters round-trip: float32 ABCD", () => {
  const original = 1234.5678;
  const words = encodeValue(original, "float32", "ABCD");
  const decoded = decodeRegisters(words, 0, "float32", "ABCD") as number;
  assertAlmostEquals(decoded, original, 1e-3); // float32 precision
});

Deno.test("encodeValue/decodeRegisters round-trip: int32 DCBA", () => {
  const words = encodeValue(-99999, "int32", "DCBA");
  assertEquals(decodeRegisters(words, 0, "int32", "DCBA"), -99999);
});

Deno.test("encodeValue/decodeRegisters round-trip: uint16 ABCD", () => {
  const words = encodeValue(0xBEEF, "uint16", "ABCD");
  assertEquals(decodeRegisters(words, 0, "uint16", "ABCD"), 0xBEEF);
});

Deno.test("encodeValue: boolean true → word 0x0001", () => {
  const words = encodeValue(true, "boolean", "ABCD");
  assertEquals(words[0], 1);
});

Deno.test("encodeValue: boolean false → word 0x0000", () => {
  const words = encodeValue(false, "boolean", "ABCD");
  assertEquals(words[0], 0);
});
