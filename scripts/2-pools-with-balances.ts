#!/usr/bin/env node
// Step 2 of the pipeline (see README.md's "Pipeline overview") — a thin CLI entry point around
// lib/pool-scanner.ts, lib/balance-fetcher.ts, and lib/token-metadata-fetcher.ts. Runs three
// phases in sequence; each phase's lib function only computes/fetches (no disk I/O), and this
// script writes each phase's result via its own dedicated write function immediately after:
//   (a) scanPools()          — discovered pools, kept in memory only (no output file)
//   (b) fetchBalancesPhase() -> writeBalancesFile()  — outputs/pools-with-balances.json
//   (c) fetchMetadataPhase() -> mergeTokenMetadata() -> writeTokensFile() — tokens.jsonc.
//       mergeTokenMetadata() carries any existing priceUsd (including a manually-entered one
//       for a token neither price source in step 3 can resolve) forward onto the freshly
//       fetched name/symbol/decimals, so rerunning step 2 never wipes prices out.
//
// RPC endpoint resolution (Alchemy only, see lib/env.ts): built from ALCHEMY_API_KEY in .env +
// this chain's Alchemy network slug. A chain with no ALCHEMY_API_KEY, or no known Alchemy
// network, is skipped with a warning.
//
// Usage:
//   node scripts/2-pools-with-balances.ts
//   node scripts/2-pools-with-balances.ts --chains 1,8453 --factory 0xA327...
//   (scoping applies to phase (a); phases (b)/(c) then only see whatever (a) discovered)

import type { PublicClient } from "viem";
import { parseArgs, type CliArgs } from "../lib/cli.ts";
import { loadDotEnv } from "../lib/env.ts";
import { createClientResolver } from "../lib/rpc.ts";
import { scanPools } from "../lib/pool-scanner.ts";
import { fetchBalancesPhase } from "../lib/balance-fetcher.ts";
import { writeBalancesFile } from "../lib/balances-file.ts";
import { fetchMetadataPhase } from "../lib/token-metadata-fetcher.ts";
import { mergeTokenMetadata, readTokensFile, writeTokensFile } from "../lib/tokens-file.ts";
import { safeErrorMessage } from "../lib/errors.ts";
import type { ChainTokens, DiscoveredPool } from "../lib/types.ts";

async function main(): Promise<void> {
  await loadDotEnv();
  const args: CliArgs = parseArgs(process.argv.slice(2));
  const getClient: (chainId: number) => PublicClient | null = createClientResolver();

  const discovered: DiscoveredPool[] = await scanPools(args, getClient);

  const balances = await fetchBalancesPhase(discovered, getClient);
  await writeBalancesFile(balances);

  const freshTokens = await fetchMetadataPhase(discovered, getClient);
  const existingTokens: ChainTokens[] = await readTokensFile();
  await writeTokensFile(mergeTokenMetadata(existingTokens, freshTokens));

  console.log("\nStep 2 complete. Next: node scripts/3-get-token-prices.ts");
}

main().catch((err) => {
  console.error(safeErrorMessage(err));
  process.exit(1);
});
