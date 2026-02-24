/**
 * Decode raw Modbus register words into typed values.
 *
 * All reads return Uint16Array words in network byte order (big-endian words).
 * Multi-register types (INT32, FLOAT32, FLOAT64) are affected by byte order
 * within the word arrangement.
 */

import type { ModbusByteOrder, ModbusDatatype } from "../../types/config.ts";

/** Number of 16-bit registers consumed by each datatype */
export function registerCount(datatype: ModbusDatatype): number {
  switch (datatype) {
    case "boolean":
    case "int16":
    case "uint16":
      return 1;
    case "int32":
    case "uint32":
    case "float32":
      return 2;
    case "float64":
      return 4;
  }
}

/**
 * Arrange raw register words according to byte order, producing a byte buffer
 * suitable for DataView reads.
 *
 * Each Uint16Array word is already big-endian on the wire; we re-arrange
 * them here to form the final byte stream in ABCD order (most-significant
 * byte first) before reading as a multi-byte value.
 *
 * ABCD: words arrive [W0, W1] → bytes [A,B,C,D] (big-endian, standard)
 * DCBA: reverse all bytes       → [D,C,B,A] (little-endian)
 * BADC: swap bytes within words → [B,A,D,C]
 * CDAB: swap word order         → [C,D,A,B]
 */
function arrangeBytes(words: Uint16Array, byteOrder: ModbusByteOrder): Uint8Array {
  const n = words.length;
  const raw = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    raw[i * 2] = (words[i] >> 8) & 0xff;       // high byte
    raw[i * 2 + 1] = words[i] & 0xff;           // low byte
  }

  switch (byteOrder) {
    case "ABCD":
      return raw;
    case "DCBA":
      return raw.reverse();
    case "BADC": {
      // Swap bytes within each 16-bit word
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 2) {
        out[i] = raw[i + 1];
        out[i + 1] = raw[i];
      }
      return out;
    }
    case "CDAB": {
      // Swap word order (each pair of words)
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 4) {
        out[i] = raw[i + 2];
        out[i + 1] = raw[i + 3];
        out[i + 2] = raw[i];
        out[i + 3] = raw[i + 1];
      }
      return out;
    }
  }
}

/**
 * Decode registers from a block read result at a given word offset.
 *
 * @param words     Full block of raw register words from the read response
 * @param offset    Word index of the first register for this tag
 * @param datatype  Target datatype
 * @param byteOrder Byte order arrangement
 * @returns         Decoded numeric or boolean value
 */
export function decodeRegisters(
  words: Uint16Array,
  offset: number,
  datatype: ModbusDatatype,
  byteOrder: ModbusByteOrder,
): number | boolean {
  const count = registerCount(datatype);
  const slice = words.slice(offset, offset + count);
  const bytes = arrangeBytes(slice, byteOrder);
  const view = new DataView(bytes.buffer);

  switch (datatype) {
    case "boolean":
      return words[offset] !== 0;
    case "int16":
      return view.getInt16(0, false);
    case "uint16":
      return view.getUint16(0, false);
    case "int32":
      return view.getInt32(0, false);
    case "uint32":
      return view.getUint32(0, false);
    case "float32":
      return view.getFloat32(0, false);
    case "float64":
      return view.getFloat64(0, false);
  }
}

/**
 * Encode a typed value into one or more register words for writing.
 * Returns words in big-endian order (network byte order).
 */
export function encodeValue(
  value: number | boolean,
  datatype: ModbusDatatype,
  byteOrder: ModbusByteOrder,
): Uint16Array {
  const count = registerCount(datatype);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);

  switch (datatype) {
    case "boolean":
      view.setUint16(0, value ? 1 : 0, false);
      break;
    case "int16":
      view.setInt16(0, Number(value), false);
      break;
    case "uint16":
      view.setUint16(0, Number(value), false);
      break;
    case "int32":
      view.setInt32(0, Number(value), false);
      break;
    case "uint32":
      view.setUint32(0, Number(value), false);
      break;
    case "float32":
      view.setFloat32(0, Number(value), false);
      break;
    case "float64":
      view.setFloat64(0, Number(value), false);
      break;
  }

  // Convert bytes to words using big-endian bit shifts (NOT Uint16Array constructor,
  // which uses native/little-endian byte order on x86 and would corrupt the words).
  const asWords = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    asWords[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  }

  // All byte-order transformations are self-inverse, so encodeValue uses the
  // same arrangeBytes logic as decodeRegisters (ABCD→ABCD, DCBA→DCBA, etc.)
  const arranged = arrangeBytes(asWords, byteOrder);

  const words = new Uint16Array(count);
  const arrangedView = new DataView(arranged.buffer);
  for (let i = 0; i < count; i++) {
    words[i] = arrangedView.getUint16(i * 2, false);
  }
  return words;
}
