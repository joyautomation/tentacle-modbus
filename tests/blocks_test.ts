/**
 * Block-read grouping algorithm tests.
 *
 * Validates that buildBlocks() correctly groups tags into minimal
 * contiguous address blocks. No network required.
 */

import { assertEquals } from "@std/assert";
import { buildBlocks, MAX_GAP } from "../src/modbus/blocks.ts";
import type { ModbusTagConfig } from "../types/config.ts";

function tag(id: string, address: number, datatype: ModbusTagConfig["datatype"] = "uint16"): ModbusTagConfig {
  return { id, address, functionCode: "holding", datatype };
}

// ─── Basic grouping ─────────────────────────────────────────────────────────

Deno.test("buildBlocks: empty input returns empty array", () => {
  assertEquals(buildBlocks([]), []);
});

Deno.test("buildBlocks: single tag produces one block", () => {
  const blocks = buildBlocks([tag("a", 10)]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].startAddr, 10);
  assertEquals(blocks[0].count, 1);
  assertEquals(blocks[0].tags.length, 1);
});

Deno.test("buildBlocks: adjacent tags merge into one block", () => {
  const blocks = buildBlocks([tag("a", 0), tag("b", 1), tag("c", 2)]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].startAddr, 0);
  assertEquals(blocks[0].count, 3);
});

Deno.test("buildBlocks: gap within MAX_GAP merges", () => {
  // addresses 0 and MAX_GAP — gap is exactly MAX_GAP, so merged
  const blocks = buildBlocks([tag("a", 0), tag("b", MAX_GAP)]);
  assertEquals(blocks.length, 1);
});

Deno.test("buildBlocks: gap beyond MAX_GAP splits into two blocks", () => {
  const blocks = buildBlocks([tag("a", 0), tag("b", MAX_GAP + 2)]);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].startAddr, 0);
  assertEquals(blocks[1].startAddr, MAX_GAP + 2);
});

// ─── Multi-register types ────────────────────────────────────────────────────

Deno.test("buildBlocks: float32 tag occupies 2 registers", () => {
  const blocks = buildBlocks([{ ...tag("a", 0), datatype: "float32" }]);
  assertEquals(blocks[0].count, 2);
});

Deno.test("buildBlocks: float64 tag occupies 4 registers", () => {
  const blocks = buildBlocks([{ ...tag("a", 0), datatype: "float64" }]);
  assertEquals(blocks[0].count, 4);
});

Deno.test("buildBlocks: int32 followed by uint16 merges correctly", () => {
  // int32 at 0 (occupies 0-1), uint16 at 2 — adjacent, one block of 3
  const blocks = buildBlocks([
    { ...tag("a", 0), datatype: "int32" },
    tag("b", 2),
  ]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].count, 3);
});

// ─── Word offsets ────────────────────────────────────────────────────────────

Deno.test("buildBlocks: wordOffset reflects position within block", () => {
  const blocks = buildBlocks([
    tag("a", 5),
    tag("b", 7),
    tag("c", 10),
  ]);
  assertEquals(blocks.length, 1);
  const offsets = new Map(blocks[0].tags.map((t) => [t.config.id, t.wordOffset]));
  assertEquals(offsets.get("a"), 0);
  assertEquals(offsets.get("b"), 2);
  assertEquals(offsets.get("c"), 5);
});

// ─── Input order independence ────────────────────────────────────────────────

Deno.test("buildBlocks: sorts tags by address before grouping", () => {
  // Tags provided in reverse address order
  const blocks = buildBlocks([tag("b", 10), tag("a", 0), tag("c", 5)]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].startAddr, 0);
  // Tags are in sorted-address order within the block
  assertEquals(blocks[0].tags.map((t) => t.config.id), ["a", "c", "b"]);
});

// ─── Multiple blocks ─────────────────────────────────────────────────────────

Deno.test("buildBlocks: three separate sparse groups → three blocks", () => {
  const blocks = buildBlocks([
    tag("a", 0),
    tag("b", 100),
    tag("c", 200),
  ]);
  assertEquals(blocks.length, 3);
  assertEquals(blocks[0].startAddr, 0);
  assertEquals(blocks[1].startAddr, 100);
  assertEquals(blocks[2].startAddr, 200);
});
