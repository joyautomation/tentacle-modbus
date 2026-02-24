/**
 * Modbus TCP configuration types for tentacle-modbus
 */

/** Modbus register space / function code group */
export type ModbusFunctionCode = "coil" | "discrete" | "holding" | "input";

/** Typed value widths supported per tag */
export type ModbusDatatype =
  | "boolean"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

/**
 * Register byte order for multi-register datatypes.
 * Letters represent byte positions within the final value:
 *   A = most-significant byte of most-significant word
 *   B = least-significant byte of most-significant word
 *   C = most-significant byte of least-significant word
 *   D = least-significant byte of least-significant word
 *
 * ABCD = big-endian (standard Modbus, default)
 * DCBA = little-endian
 * BADC = big-endian byte-swapped (common in some PLCs)
 * CDAB = little-endian byte-swapped
 */
export type ModbusByteOrder = "ABCD" | "BADC" | "CDAB" | "DCBA";

/** Configuration for a single Modbus tag */
export type ModbusTagConfig = {
  id: string;
  description?: string;
  /** 0-based register or coil address */
  address: number;
  functionCode: ModbusFunctionCode;
  datatype: ModbusDatatype;
  /** Overrides device-level byteOrder for this tag only */
  byteOrder?: ModbusByteOrder;
  /** Whether writes to this tag are permitted via modbus.command.{id} */
  writable?: boolean;
};

/** Subscribe request sent to modbus.subscribe */
export type ModbusSubscribeRequest = {
  deviceId: string;
  host: string;
  /** Default: 502 */
  port?: number;
  /** Modbus unit ID / slave address. Default: 1 */
  unitId?: number;
  /** Device-level byte order default. Default: "ABCD" */
  byteOrder?: ModbusByteOrder;
  /** Poll interval in ms. Default: 1000 */
  scanRate?: number;
  tags: ModbusTagConfig[];
  subscriberId: string;
};

/** Unsubscribe request sent to modbus.unsubscribe */
export type ModbusUnsubscribeRequest = {
  deviceId: string;
  tagIds: string[];
  subscriberId: string;
};

export type NatsConfig = {
  servers: string | string[];
  user?: string;
  pass?: string;
  token?: string;
};
