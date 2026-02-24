/**
 * Modbus function code implementations.
 *
 * All functions take a connected ModbusClient plus addressing parameters and
 * return decoded coil/register arrays.
 *
 * FC01 — Read Coils            (read-write bits)
 * FC02 — Read Discrete Inputs  (read-only bits)
 * FC03 — Read Holding Registers (read-write words)
 * FC04 — Read Input Registers   (read-only words)
 * FC05 — Write Single Coil
 * FC06 — Write Single Register
 * FC15 — Write Multiple Coils
 * FC16 — Write Multiple Registers
 */

import type { ModbusClient } from "./client.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPdu(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function u16be(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * FC01 — Read Coils
 * Returns `count` boolean values starting at `startAddr`.
 */
export async function readCoils(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  count: number,
): Promise<boolean[]> {
  const pdu = buildPdu(0x01, ...u16be(startAddr), ...u16be(count));
  const resp = await client.request(unitId, pdu);
  return extractBits(resp, 2, count);
}

/**
 * FC02 — Read Discrete Inputs
 */
export async function readDiscreteInputs(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  count: number,
): Promise<boolean[]> {
  const pdu = buildPdu(0x02, ...u16be(startAddr), ...u16be(count));
  const resp = await client.request(unitId, pdu);
  return extractBits(resp, 2, count);
}

/**
 * FC03 — Read Holding Registers
 * Returns `count` 16-bit words.
 */
export async function readHoldingRegisters(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  count: number,
): Promise<Uint16Array> {
  const pdu = buildPdu(0x03, ...u16be(startAddr), ...u16be(count));
  const resp = await client.request(unitId, pdu);
  return extractWords(resp, 2, count);
}

/**
 * FC04 — Read Input Registers
 */
export async function readInputRegisters(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  count: number,
): Promise<Uint16Array> {
  const pdu = buildPdu(0x04, ...u16be(startAddr), ...u16be(count));
  const resp = await client.request(unitId, pdu);
  return extractWords(resp, 2, count);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * FC05 — Write Single Coil
 * value=true → 0xFF00, value=false → 0x0000
 */
export async function writeSingleCoil(
  client: ModbusClient,
  unitId: number,
  addr: number,
  value: boolean,
): Promise<void> {
  const coilValue = value ? 0xff00 : 0x0000;
  const pdu = buildPdu(0x05, ...u16be(addr), ...u16be(coilValue));
  await client.request(unitId, pdu);
}

/**
 * FC06 — Write Single Register
 */
export async function writeSingleRegister(
  client: ModbusClient,
  unitId: number,
  addr: number,
  value: number,
): Promise<void> {
  const pdu = buildPdu(0x06, ...u16be(addr), ...u16be(value & 0xffff));
  await client.request(unitId, pdu);
}

/**
 * FC15 — Write Multiple Coils
 */
export async function writeMultipleCoils(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  values: boolean[],
): Promise<void> {
  const byteCount = Math.ceil(values.length / 8);
  const coilBytes = new Uint8Array(byteCount);
  for (let i = 0; i < values.length; i++) {
    if (values[i]) coilBytes[Math.floor(i / 8)] |= (1 << (i % 8));
  }
  const pdu = new Uint8Array(6 + byteCount);
  pdu[0] = 0x0f;
  pdu[1] = (startAddr >> 8) & 0xff;
  pdu[2] = startAddr & 0xff;
  pdu[3] = (values.length >> 8) & 0xff;
  pdu[4] = values.length & 0xff;
  pdu[5] = byteCount;
  pdu.set(coilBytes, 6);
  await client.request(unitId, pdu);
}

/**
 * FC16 — Write Multiple Registers
 * `words` must be in big-endian network order.
 */
export async function writeMultipleRegisters(
  client: ModbusClient,
  unitId: number,
  startAddr: number,
  words: Uint16Array,
): Promise<void> {
  const byteCount = words.length * 2;
  const pdu = new Uint8Array(6 + byteCount);
  pdu[0] = 0x10;
  pdu[1] = (startAddr >> 8) & 0xff;
  pdu[2] = startAddr & 0xff;
  pdu[3] = (words.length >> 8) & 0xff;
  pdu[4] = words.length & 0xff;
  pdu[5] = byteCount;
  const view = new DataView(pdu.buffer);
  for (let i = 0; i < words.length; i++) {
    view.setUint16(6 + i * 2, words[i], false);
  }
  await client.request(unitId, pdu);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract boolean bits from a bit-packed coil/discrete response */
function extractBits(pdu: Uint8Array, dataOffset: number, count: number): boolean[] {
  const bytes = pdu.subarray(dataOffset);
  const result: boolean[] = [];
  for (let i = 0; i < count; i++) {
    result.push(((bytes[Math.floor(i / 8)] >> (i % 8)) & 1) === 1);
  }
  return result;
}

/** Extract 16-bit register words from a register read response */
function extractWords(pdu: Uint8Array, dataOffset: number, count: number): Uint16Array {
  const bytes = pdu.subarray(dataOffset);
  const words = new Uint16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let i = 0; i < count; i++) {
    words[i] = view.getUint16(i * 2, false); // big-endian
  }
  return words;
}
