/**
 * Block-read grouping algorithm.
 *
 * Groups a list of tags sharing a function code into minimal contiguous
 * address blocks, reducing the number of Modbus requests per scan cycle.
 *
 * Tags within MAX_GAP addresses of the current block end are merged into
 * that block rather than starting a new request. This trades a small amount
 * of extra data read (the gap registers, which are discarded) for fewer
 * round trips.
 */

import type { ModbusTagConfig } from "../../types/config.ts";
import { registerCount } from "./decode.ts";

export const MAX_GAP = 10;

export type ReadBlock = {
  startAddr: number;
  /** Total register/coil count spanning all tags in the block */
  count: number;
  tags: Array<{
    config: ModbusTagConfig;
    /** Word offset of this tag's first register within the block */
    wordOffset: number;
  }>;
};

/**
 * Group tags (all with the same functionCode) into minimal read blocks.
 * Tags must all share the same function code — caller is responsible for
 * pre-filtering.
 */
export function buildBlocks(tags: ModbusTagConfig[]): ReadBlock[] {
  if (tags.length === 0) return [];

  const sorted = [...tags].sort((a, b) => a.address - b.address);
  const blocks: ReadBlock[] = [];
  let block: ReadBlock | null = null;

  for (const tag of sorted) {
    const regs = registerCount(tag.datatype);
    const tagEnd = tag.address + regs;

    if (block === null || tag.address > block.startAddr + block.count + MAX_GAP) {
      block = { startAddr: tag.address, count: regs, tags: [] };
      blocks.push(block);
    } else {
      const newEnd = Math.max(block.startAddr + block.count, tagEnd);
      block.count = newEnd - block.startAddr;
    }

    block.tags.push({ config: tag, wordOffset: tag.address - block.startAddr });
  }

  return blocks;
}
