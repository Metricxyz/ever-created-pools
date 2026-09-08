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

// MetricOmmPoolDataProvider — a lens contract that reads any MetricOmmPool's bin state via
// extsload, decoded against the CURRENT PoolStateLibrary storage layout (base slots 4/5/6 for
// _binsStates/_binsTotalShares/_positionBinShares — see metric-core's PoolStateLibrary.sol).
// That layout has been stable since it was introduced (predates every v2/v3/v4 factory in
// factories.jsonc) through current HEAD, so this single deployed instance correctly reads any
// v2/v3/v4 pool regardless of which factory created it. It does NOT correctly read v1 pools —
// those predate this layout and use base slots 2/3 instead (see OLD_ERA_BIN_SLOTS below).
// Deterministically deployed via CREATE2 at this exact address on all 10 chains this repo
// supports; verified live (non-empty eth_getCode, identical bytecode length) on all of them
// before relying on it, same bar as MULTICALL3_ADDRESS above.
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

// v1 pools (the only version older than the DataProvider-compatible storage layout) still
// expose bare `extsload` directly (present since the very first deployed version), so their bin
// state has to be read by replicating the pool's OWN slot math instead of using DataProvider.
// Sourced verbatim from metric-core's genesis-commit PoolStateLibrary.sol (the library that has
// always backed every StateView/DataProvider contract) — BINS_STATES_SLOT/BINS_TOTAL_SHARES_SLOT
// were 2/3 at genesis and never moved for as long as the old (pre-DataProvider) layout was live;
// only the newer layout renumbered them to 4/5. The BinState bit-packing itself (token0Balance
// uint104 @ bit 0, token1Balance uint104 @ bit 104, lengthE6 uint16 @ bit 208, addFeeBuyE6 uint16
// @ bit 224, addFeeSellE6 uint16 @ bit 240) is identical between the old and new layouts, so the
// same decode logic in lib/bin-state-reader.ts serves both eras — only these base slot numbers
// differ, and only for the old (v1) layout.
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
