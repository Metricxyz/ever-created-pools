#!/usr/bin/env node
// Step 4 of the pipeline (see README.md's "Pipeline overview") — a thin CLI entry point around
// lib/significant-pools.ts. Reads outputs/pools-with-balances.json + tokens.jsonc (pure data
// transform, no RPC/network calls) and writes outputs/significant-pools.json. See
// lib/significant-pools.ts for the filtering/sorting rules.
//
// Usage: node scripts/4-get-significant-pools.ts

import { computeSignificantPools, writeSignificantPools, type SignificantPoolsComputation } from "../lib/significant-pools.ts";
import { readBalancesFile } from "../lib/balances-file.ts";
import { readTokensFile } from "../lib/tokens-file.ts";

async function main(): Promise<void> {
  const balances = await readBalancesFile();
  const tokenChains = await readTokensFile();
  const { result, stats }: SignificantPoolsComputation = computeSignificantPools(balances, tokenChains);
  await writeSignificantPools(result);

  console.log(`Read ${stats.totalIn} pool(s) from outputs/pools-with-balances.json.`);
  console.log(`  significant (>= $10 estimated value): ${stats.keptKnown}`);
  console.log(`  other — both balances zero: ${stats.zeroBalance}`);
  console.log(`  other — value known and < $10: ${stats.belowThreshold}`);
  console.log(`  other — value could not be estimated: ${stats.otherUnknown}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
