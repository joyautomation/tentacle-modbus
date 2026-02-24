/**
 * Modbus TCP MBAP (Modbus Application Protocol) header encoding/decoding.
 *
 * MBAP Header layout (7 bytes):
 *   Bytes 0-1: Transaction Identifier (big-endian uint16)
 *   Bytes 2-3: Protocol Identifier    (always 0x0000)
 *   Bytes 4-5: Length                 (big-endian uint16 — number of bytes following)
 *   Byte  6:   Unit Identifier        (slave address)
 *
 * Total frame = 7 (MBAP) + PDU bytes
 * Length field = 1 (unit ID byte) + PDU length
 */

export type MbapHeader = {
  transactionId: number;
  length: number; // bytes remaining after header (1 + PDU)
  unitId: number;
};

/**
 * Encode a complete Modbus TCP frame: MBAP header + PDU.
 * @param transactionId  16-bit transaction counter
 * @param unitId         Modbus unit/slave ID
 * @param pdu            Function code + data bytes
 */
export function encodeFrame(
  transactionId: number,
  unitId: number,
  pdu: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(7 + pdu.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, transactionId, false); // Transaction ID
  view.setUint16(2, 0, false);             // Protocol ID (always 0)
  view.setUint16(4, 1 + pdu.length, false); // Length = unitId byte + PDU
  frame[6] = unitId;
  frame.set(pdu, 7);
  return frame;
}

/**
 * Decode the 6-byte MBAP header prefix.
 * Returns the transactionId, declared length, and unitId.
 * Caller should have at least 7 bytes available.
 */
export function decodeMbapHeader(buf: Uint8Array): MbapHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    transactionId: view.getUint16(0, false),
    length: view.getUint16(4, false),
    unitId: buf[6],
  };
}

/** Total frame byte length given the MBAP length field */
export function frameLength(mbapLength: number): number {
  return 6 + mbapLength; // 6 MBAP prefix bytes + length field value
}
