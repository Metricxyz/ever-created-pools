// Read/write for outputs/pools-with-balances.json — written by step 2 phase (b), read back by
// step 4. Kept separate from lib/balance-fetcher.ts so the fetch (get) and persist (write)
// responsibilities live in distinct functions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OUTPUTS_DIR, POOLS_WITH_BALANCES_PATH } from "./paths.ts";
import type { FactoryBalances } from "./types.ts";

export async function readBalancesFile(): Promise<FactoryBalances[]> {
  const raw = await readFile(POOLS_WITH_BALANCES_PATH, "utf8");
  return JSON.parse(raw);
}

export async function writeBalancesFile(data: FactoryBalances[]): Promise<void> {
  await mkdir(OUTPUTS_DIR, { recursive: true });
  await writeFile(POOLS_WITH_BALANCES_PATH, JSON.stringify(data, null, 2));
  console.log(`(b) Wrote outputs/pools-with-balances.json`);
}
