#!/usr/bin/env node
// Step 3 of the pipeline (see README.md's "Pipeline overview") — a thin CLI entry point around
// lib/token-price-fetcher.ts. Adds a priceUsd field to every token in tokens.jsonc (written by
// step 2). See lib/token-price-fetcher.ts for the DeFiLlama-primary/CoinGecko-fallback strategy.
//
// Usage:
//   node scripts/3-get-token-prices.ts
//   node scripts/3-get-token-prices.ts --chains 1,8453

import { parseArgs, type CliArgs } from "../lib/cli.ts";
import { fetchTokenPrices } from "../lib/token-price-fetcher.ts";
import { readTokensFile, writeTokensFile } from "../lib/tokens-file.ts";
import type { ChainTokens } from "../lib/types.ts";

async function main(): Promise<void> {
  const args: CliArgs = parseArgs(process.argv.slice(2));
  const chains: ChainTokens[] = await readTokensFile();
  const { totalTokens, totalPriced } = await fetchTokenPrices(chains, args);
  await writeTokensFile(chains);
  console.log(`\nDone: ${totalPriced}/${totalTokens} priced.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
