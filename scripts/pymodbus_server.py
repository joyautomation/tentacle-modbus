#!/usr/bin/env python3
"""
Minimal Modbus TCP server for CI smoke testing.

Holding and input registers 0-199 are initialised with value = address
(register 0 = 0, register 1 = 1, ..., register 199 = 199).
All coils and discrete inputs start as False.

Listens on 127.0.0.1:5502.
Prints "READY" to stdout once the server is up so CI can wait for it.

Usage:
  pip install "pymodbus>=3.5,<3.6"
  python scripts/pymodbus_server.py
"""

import sys
import asyncio

try:
    from pymodbus.server import StartAsyncTcpServer
    from pymodbus.datastore import (
        ModbusSequentialDataBlock,
        ModbusSlaveContext,
        ModbusServerContext,
    )
except ImportError as e:
    print(f"ERROR: pymodbus import failed: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    sys.exit(1)

HOST = "127.0.0.1"
PORT = 5502
COUNT = 200


async def main() -> None:
    store = ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [False] * COUNT),
        co=ModbusSequentialDataBlock(0, [False] * COUNT),
        hr=ModbusSequentialDataBlock(0, list(range(COUNT))),
        ir=ModbusSequentialDataBlock(0, list(range(COUNT))),
        zero_mode=True,
    )
    context = ModbusServerContext(slaves=store, single=True)

    # Signal readiness to the parent process / CI step
    print(f"READY on {HOST}:{PORT}", flush=True)

    await StartAsyncTcpServer(context=context, address=(HOST, PORT))


if __name__ == "__main__":
    asyncio.run(main())
