// Shared data shapes passed between pipeline phases and (de)serialized to/from disk.
import type { Address } from "viem";

export interface FactoryEntry {
  factory: Address;
  chainIds: number[];
  eventSignature: string;
  abiVersion: number;
  // Positionally aligned with chainIds (deploymentBlocks[i] is the deployment block on
  // chainIds[i]) — null where unknown. factories.jsonc is the sole input file for step 2.
  deploymentBlocks?: Array<number | null>;
}

export interface IncompleteRange {
  fromBlock: string;
  toBlock: string;
  error: string;
}

// The handoff between step 2's phases — deliberately minimal, just enough for balances + metadata.
export interface DiscoveredPool {
  factory: Address;
  chainId: number;
  pool: Address;
  token0: Address;
  token1: Address;
}

export interface PoolBalance {
  pool: Address;
  token0: Address;
  token1: Address;
  balance0: string;
  balance1: string;
}
export interface ChainBalances {
  chainId: number;
  pools: PoolBalance[];
}
export interface FactoryBalances {
  factory: Address;
  chains: ChainBalances[];
}

export interface TokenMetadata {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  priceUsd?: number | null;
}
export interface ChainTokens {
  chainId: number;
  tokens: TokenMetadata[];
}

export interface SignificantPool extends PoolBalance {
  valueUsd: number | null;
}
export interface SignificantChain {
  chainId: number;
  pools: SignificantPool[];
  other_pools: SignificantPool[];
}
export interface SignificantFactory {
  factory: Address;
  chains: SignificantChain[];
}

// Step 5's handoff: net LiquidityAdded/Removed (v2-4) or LiquidityModified (v1) share balance for
// one account in one bin of one pool, after replaying that pool's full event history and summing
// across every position salt. Only ever emitted for a strictly positive net (a zero-or-negative
// result means the account no longer holds shares there).
export interface AccountBinShares {
  factory: Address;
  chainId: number;
  pool: Address;
  account: Address;
  bin: number;
  shares: string;
}

// Step 5's other input: the pool's CURRENT on-chain reserves + total outstanding shares for one
// bin (live state, not derived from event replay) — see lib/bin-state-reader.ts.
export interface BinState {
  factory: Address;
  chainId: number;
  pool: Address;
  bin: number;
  token0BalanceScaled: string;
  token1BalanceScaled: string;
  totalShares: string;
}

export interface BinPosition {
  bin: number;
  shares: string;
}
export interface PoolPosition {
  pool: Address;
  chainId: number;
  estimatedValueUsd: number | null;
  binPositions: BinPosition[];
}
export interface LiquidityHolder {
  account: Address;
  positions: PoolPosition[];
}
