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
