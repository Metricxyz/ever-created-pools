// Shared filesystem locations, resolved relative to this file (lib/), one directory up from the
// repo root — every module here computes paths off ROOT rather than process.cwd(), so scripts
// work regardless of what directory they're invoked from.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..");
export const OUTPUTS_DIR = path.join(ROOT, "outputs");
export const FACTORIES_JSONC_PATH = path.join(ROOT, "factories.jsonc");
export const TOKENS_JSONC_PATH = path.join(ROOT, "tokens.jsonc");
export const POOLS_WITH_BALANCES_PATH = path.join(OUTPUTS_DIR, "pools-with-balances.json");
export const SIGNIFICANT_POOLS_PATH = path.join(OUTPUTS_DIR, "significant-pools.json");
export const LIQUIDITY_HOLDERS_PATH = path.join(OUTPUTS_DIR, "liquidity-holders.json");
export function abiPath(abiVersion: number): string {
  return path.join(ROOT, "abis", String(abiVersion), "MetricOmmPoolFactory.json");
}
export function poolAbiPath(abiVersion: number): string {
  return path.join(ROOT, "abis", String(abiVersion), "MetricOmmPool.json");
}
