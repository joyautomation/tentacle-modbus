/**
 * Modbus TCP Client
 *
 * Manages a single TCP connection to one Modbus slave.
 * Provides promise-based request/response matching via the MBAP transaction ID.
 * Handles fragmented TCP reads via an internal accumulation buffer.
 */

import { decodeMbapHeader, encodeFrame, frameLength } from "./protocol.ts";
import { log } from "../utils/logger.ts";

type PendingRequest = {
  resolve: (pdu: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: number;
};

export class ModbusClient {
  private conn: Deno.TcpConn | null = null;
  private txId = 0;
  private pending = new Map<number, PendingRequest>();
  private buf = new Uint8Array(0);
  private aborted = false;
  private generation = 0;

  get connected(): boolean {
    return this.conn !== null;
  }

  async connect(host: string, port: number): Promise<void> {
    // Clean up any stale connection before reconnecting
    if (this.conn) this.handleDisconnect();
    this.aborted = false;
    this.generation++;
    const gen = this.generation;
    this.conn = await Deno.connect({ hostname: host, port, transport: "tcp" });
    this.readLoop().catch((err) => {
      if (this.generation !== gen) return; // stale readLoop from a previous connection
      if (!this.aborted) {
        log.modbus.warn(`Read loop error: ${err}`);
      }
      this.handleDisconnect();
    });
  }

  async disconnect(): Promise<void> {
    this.aborted = true;
    this.handleDisconnect();
  }

  /**
   * Send a PDU to the slave and await the response PDU.
   * The MBAP header is prepended automatically.
   */
  async request(unitId: number, pdu: Uint8Array, timeoutMs = 3000): Promise<Uint8Array> {
    if (!this.conn) throw new Error("Not connected");

    const txId = this.nextTxId();
    const frame = encodeFrame(txId, unitId, pdu);

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(txId);
        reject(new Error(`Modbus request timed out (txId=${txId})`));
      }, timeoutMs);

      this.pending.set(txId, { resolve, reject, timer });

      this.conn!.write(frame).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(txId);
        reject(err);
      });
    });
  }

  private nextTxId(): number {
    this.txId = (this.txId + 1) & 0xffff;
    return this.txId;
  }

  private handleDisconnect(): void {
    const err = new Error("Modbus connection closed");
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.buf = new Uint8Array(0);
    try {
      this.conn?.close();
    } catch { /* ignore */ }
    this.conn = null;
  }

  private async readLoop(): Promise<void> {
    const conn = this.conn!;
    const chunk = new Uint8Array(4096);

    while (!this.aborted) {
      const n = await conn.read(chunk);
      if (n === null) break; // EOF

      // Append to accumulation buffer
      const next = new Uint8Array(this.buf.length + n);
      next.set(this.buf);
      next.set(chunk.subarray(0, n), this.buf.length);
      this.buf = next;

      // Dispatch any complete frames
      while (this.buf.length >= 7) {
        const header = decodeMbapHeader(this.buf);
        const total = frameLength(header.length); // 6 + length

        if (this.buf.length < total) break; // Frame not yet complete

        // Extract response PDU (everything after the 7-byte MBAP header)
        const responsePdu = this.buf.slice(7, total);
        this.buf = this.buf.slice(total);

        this.dispatch(header.transactionId, responsePdu);
      }
    }
  }

  private dispatch(txId: number, pdu: Uint8Array): void {
    const pending = this.pending.get(txId);
    if (!pending) {
      log.modbus.warn(`Received response for unknown txId=${txId}`);
      return;
    }
    this.pending.delete(txId);
    clearTimeout(pending.timer);

    // Check for Modbus exception response (high bit set on function code)
    if (pdu.length >= 2 && (pdu[0] & 0x80) !== 0) {
      pending.reject(new Error(`Modbus exception: FC=0x${(pdu[0] & 0x7f).toString(16)}, code=${pdu[1]}`));
      return;
    }

    pending.resolve(pdu);
  }
}
