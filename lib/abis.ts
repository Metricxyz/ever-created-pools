// Shared ABI fragments and well-known contract addresses.
import type { Address } from "viem";

// Deterministically deployed at this exact address on 1000+ EVM chains; verified live (non-empty
// eth_getCode, identical bytecode length) on all 10 chains here before relying on it.
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ERC20_METADATA_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// MetricOmmPoolDataProvider — reads any MetricOmmPool's bin state via extsload, decoded against
// the storage layout v2/v3/v4 pools use (NOT v1 — see OLD_ERA_BIN_SLOTS below). Deterministically
// deployed via CREATE2 at this address on all 10 chains here; verified live (non-empty
// eth_getCode, identical bytecode length) on all of them, same bar as MULTICALL3_ADDRESS above.
export const DATA_PROVIDER_ADDRESS: Address = "0x95ab07bcef6463712213d0845962ff4293e5acf7";

export const DATA_PROVIDER_ABI = [
  {
    type: "function",
    name: "binState",
    stateMutability: "view",
    inputs: [
      { name: "pool", type: "address" },
      { name: "binIdx", type: "int16" },
    ],
    outputs: [
      { name: "token0BalanceScaled", type: "uint104" },
      { name: "token1BalanceScaled", type: "uint104" },
      { name: "lengthE6", type: "uint16" },
      { name: "addFeeBuyE6", type: "uint16" },
      { name: "addFeeSellE6", type: "uint16" },
    ],
  },
  {
    type: "function",
    name: "binTotalShares",
    stateMutability: "view",
    inputs: [
      { name: "pool", type: "address" },
      { name: "binIdx", type: "int16" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// v1 pools predate DataProvider's storage layout, so their bins are read via the pool's own
// `extsload` directly instead — same BinState bit-packing, just these different base slot
// numbers (sourced from metric-core's genesis PoolStateLibrary.sol).
export const OLD_ERA_BIN_SLOTS = {
  binsStates: 2n,
  binsTotalShares: 3n,
} as const;

export const EXTSLOAD_ABI = [
  {
    type: "function",
    name: "extsload",
    stateMutability: "view",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
