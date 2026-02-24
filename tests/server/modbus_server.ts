/**
 * Minimal Modbus TCP server for use as a test fixture.
 *
 * Maintains in-memory register/coil maps. Handles all eight function codes
 * used by tentacle-modbus. Supports error injection for testing exception
 * responses and connection drops.
 *
 * Usage:
 *   const server = new ModbusTestServer();
 *   await server.start();
 *   server.setHolding(0, 0x4049, 0x0FDB); // π as FLOAT32 ABCD words
 *   // ... run client code against server.port ...
 *   await server.stop();
 */

export type RecordedRequest = {
  fc: number;
  addr: number;
  count: number;
  /** For write requests, the values written */
  values?: number[] | boolean[];
};

export class ModbusTestServer {
  private listener: Deno.TcpListener | null = null;
  private conns = new Set<Deno.TcpConn>();

  /** Register / coil stores — set before starting client requests */
  readonly coils = new Map<number, boolean>();
  readonly discretes = new Map<number, boolean>();
  /** uint16 words, keyed by 0-based address */
  readonly holding = new Map<number, number>();
  readonly input = new Map<number, number>();

  /** Requests received (useful for assertion in tests) */
  readonly requests: RecordedRequest[] = [];

  /** FC → exception code: next request for this FC returns an exception */
  private pendingExceptions = new Map<number, number>();

  /** Number of connections to drop (close without responding) */
  private dropConnections = 0;

  // ─── Configuration helpers ─────────────────────────────────────────────

  setHolding(startAddr: number, ...words: number[]): this {
    for (let i = 0; i < words.length; i++) this.holding.set(startAddr + i, words[i]);
    return this;
  }

  setInput(startAddr: number, ...words: number[]): this {
    for (let i = 0; i < words.length; i++) this.input.set(startAddr + i, words[i]);
    return this;
  }

  setCoil(addr: number, value: boolean): this {
    this.coils.set(addr, value);
    return this;
  }

  setDiscrete(addr: number, value: boolean): this {
    this.discretes.set(addr, value);
    return this;
  }

  /** Inject an exception response for the next request with this function code */
  injectException(fc: number, exceptionCode: number): this {
    this.pendingExceptions.set(fc, exceptionCode);
    return this;
  }

  /** Drop the next N connections immediately after accepting (before any response) */
  dropNextConnections(n = 1): this {
    this.dropConnections += n;
    return this;
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  get port(): number {
    return (this.listener!.addr as Deno.NetAddr).port;
  }

  async start(): Promise<void> {
    this.listener = Deno.listen({ port: 0, transport: "tcp" });
    this.acceptLoop();
  }

  async stop(): Promise<void> {
    for (const conn of this.conns) {
      try { conn.close(); } catch { /* ignore */ }
    }
    this.conns.clear();
    try { this.listener?.close(); } catch { /* ignore */ }
    this.listener = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private acceptLoop(): void {
    (async () => {
      for await (const conn of this.listener!) {
        if (this.dropConnections > 0) {
          this.dropConnections--;
          conn.close();
          continue;
        }
        this.conns.add(conn);
        this.handleConn(conn).finally(() => this.conns.delete(conn));
      }
    })().catch(() => {});
  }

  private async handleConn(conn: Deno.TcpConn): Promise<void> {
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(chunk);
        if (n === null) break;

        const next = new Uint8Array(buf.length + n);
        next.set(buf);
        next.set(chunk.subarray(0, n), buf.length);
        buf = next;

        while (buf.length >= 7) {
          const txId = (buf[0] << 8) | buf[1];
          const mbapLength = (buf[4] << 8) | buf[5];
          const total = 6 + mbapLength;
          if (buf.length < total) break;

          const unitId = buf[6];
          const pdu = buf.slice(7, total);
          buf = buf.slice(total);

          const response = this.handlePdu(pdu);
          if (response === null) {
            conn.close();
            return;
          }

          const frame = new Uint8Array(7 + response.length);
          frame[0] = (txId >> 8) & 0xff;
          frame[1] = txId & 0xff;
          frame[2] = 0; frame[3] = 0;
          frame[4] = ((1 + response.length) >> 8) & 0xff;
          frame[5] = (1 + response.length) & 0xff;
          frame[6] = unitId;
          frame.set(response, 7);

          await conn.write(frame);
        }
      }
    } catch { /* connection closed */ }
  }

  private handlePdu(pdu: Uint8Array): Uint8Array | null {
    if (pdu.length === 0) return new Uint8Array([0x80 | 0x01, 0x01]);

    const fc = pdu[0];

    if (this.pendingExceptions.has(fc)) {
      const code = this.pendingExceptions.get(fc)!;
      this.pendingExceptions.delete(fc);
      return new Uint8Array([fc | 0x80, code]);
    }

    const view = new DataView(pdu.buffer, pdu.byteOffset);

    switch (fc) {
      case 0x01: return this.handleReadBits(pdu, view, this.coils, 0x01);
      case 0x02: return this.handleReadBits(pdu, view, this.discretes, 0x02);
      case 0x03: return this.handleReadWords(pdu, view, this.holding, 0x03);
      case 0x04: return this.handleReadWords(pdu, view, this.input, 0x04);
      case 0x05: return this.handleWriteCoil(pdu, view);
      case 0x06: return this.handleWriteRegister(pdu, view);
      case 0x0F: return this.handleWriteMultipleCoils(pdu, view);
      case 0x10: return this.handleWriteMultipleRegisters(pdu, view);
      default:   return new Uint8Array([fc | 0x80, 0x01]); // illegal function
    }
  }

  private handleReadBits(
    _pdu: Uint8Array,
    view: DataView,
    store: Map<number, boolean>,
    fc: number,
  ): Uint8Array {
    const addr = view.getUint16(1, false);
    const count = view.getUint16(3, false);
    this.requests.push({ fc, addr, count });

    const byteCount = Math.ceil(count / 8);
    const resp = new Uint8Array(2 + byteCount);
    resp[0] = fc;
    resp[1] = byteCount;
    for (let i = 0; i < count; i++) {
      if (store.get(addr + i)) resp[2 + Math.floor(i / 8)] |= (1 << (i % 8));
    }
    return resp;
  }

  private handleReadWords(
    _pdu: Uint8Array,
    view: DataView,
    store: Map<number, number>,
    fc: number,
  ): Uint8Array {
    const addr = view.getUint16(1, false);
    const count = view.getUint16(3, false);
    this.requests.push({ fc, addr, count });

    const resp = new Uint8Array(2 + count * 2);
    resp[0] = fc;
    resp[1] = count * 2;
    const respView = new DataView(resp.buffer);
    for (let i = 0; i < count; i++) {
      respView.setUint16(2 + i * 2, store.get(addr + i) ?? 0, false);
    }
    return resp;
  }

  private handleWriteCoil(_pdu: Uint8Array, view: DataView): Uint8Array {
    const addr = view.getUint16(1, false);
    const raw = view.getUint16(3, false);
    const value = raw === 0xFF00;
    this.coils.set(addr, value);
    this.requests.push({ fc: 0x05, addr, count: 1, values: [value] });
    // Echo request
    const resp = new Uint8Array(5);
    new DataView(resp.buffer).setUint16(1, addr, false);
    new DataView(resp.buffer).setUint16(3, raw, false);
    resp[0] = 0x05;
    return resp;
  }

  private handleWriteRegister(_pdu: Uint8Array, view: DataView): Uint8Array {
    const addr = view.getUint16(1, false);
    const value = view.getUint16(3, false);
    this.holding.set(addr, value);
    this.requests.push({ fc: 0x06, addr, count: 1, values: [value] });
    // Echo request
    const resp = new Uint8Array(5);
    const rv = new DataView(resp.buffer);
    resp[0] = 0x06;
    rv.setUint16(1, addr, false);
    rv.setUint16(3, value, false);
    return resp;
  }

  private handleWriteMultipleCoils(pdu: Uint8Array, view: DataView): Uint8Array {
    const addr = view.getUint16(1, false);
    const count = view.getUint16(3, false);
    const values: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const val = ((pdu[6 + Math.floor(i / 8)] >> (i % 8)) & 1) === 1;
      this.coils.set(addr + i, val);
      values.push(val);
    }
    this.requests.push({ fc: 0x0F, addr, count, values });
    const resp = new Uint8Array(5);
    const rv = new DataView(resp.buffer);
    resp[0] = 0x0F;
    rv.setUint16(1, addr, false);
    rv.setUint16(3, count, false);
    return resp;
  }

  private handleWriteMultipleRegisters(pdu: Uint8Array, view: DataView): Uint8Array {
    const addr = view.getUint16(1, false);
    const count = view.getUint16(3, false);
    const values: number[] = [];
    const pduView = new DataView(pdu.buffer, pdu.byteOffset);
    for (let i = 0; i < count; i++) {
      const word = pduView.getUint16(6 + i * 2, false);
      this.holding.set(addr + i, word);
      values.push(word);
    }
    this.requests.push({ fc: 0x10, addr, count, values });
    const resp = new Uint8Array(5);
    const rv = new DataView(resp.buffer);
    resp[0] = 0x10;
    rv.setUint16(1, addr, false);
    rv.setUint16(3, count, false);
    return resp;
  }
}
