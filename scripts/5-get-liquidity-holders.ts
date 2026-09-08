#!/usr/bin/env node
// Step 5 of the pipeline (see README.md's "Pipeline overview") — a thin CLI entry point around
// lib/liquidity-events.ts, lib/bin-state-reader.ts, and lib/liquidity-holders.ts. Reads
// outputs/pools-with-balances.json + tokens.jsonc and writes outputs/liquidity-holders.json: for
// every account that still holds any liquidity, across every pool and every chain, their
// bin-by-bin share counts and an estimated USD value per pool. See lib/liquidity-holders.ts for
// the estimation method.
//
// RPC endpoint resolution (Alchemy only, see lib/env.ts): built from ALCHEMY_API_KEY in .env +
// this chain's Alchemy network slug. A chain with no ALCHEMY_API_KEY, or no known Alchemy
// network, is skipped with a warning.
//
// Usage:
//   node scripts/5-get-liquidity-holders.ts
//   node scripts/5-get-liquidity-holders.ts --chains 1,8453 --factory 0xA327...

import type { Address, PublicClient } from "viem";
import { parseArgs, type CliArgs } from "../lib/cli.ts";
import { loadDotEnv } from "../lib/env.ts";
import { createClientResolver } from "../lib/rpc.ts";
import { readBalancesFile } from "../lib/balances-file.ts";
import { readTokensFile } from "../lib/tokens-file.ts";
import { scanLiquidityEventsPhase } from "../lib/liquidity-events.ts";
import { fetchBinStatesPhase } from "../lib/bin-state-reader.ts";
import { computeLiquidityHolders, writeLiquidityHoldersFile } from "../lib/liquidity-holders.ts";
import { safeErrorMessage } from "../lib/errors.ts";
import type { FactoryBalances } from "../lib/types.ts";

function scopeBalances(balances: FactoryBalances[], args: CliArgs): FactoryBalances[] {
  return balances
    .filter((f) => !args.factory || f.factory.toLowerCase() === (args.factory as Address).toLowerCase())
    .map((f) => ({ ...f, chains: f.chains.filter((c) => !args.chains || args.chains.includes(c.chainId)) }))
    .filter((f) => f.chains.length > 0);
}

async function main(): Promise<void> {
  await loadDotEnv();
  const args: CliArgs = parseArgs(process.argv.slice(2));
  const getClient: (chainId: number) => PublicClient | null = createClientResolver();

  const balances = scopeBalances(await readBalancesFile(), args);
  const tokenChains = await readTokensFile();

  const accountBinShares = await scanLiquidityEventsPhase(balances, getClient);
  const binStates = await fetchBinStatesPhase(accountBinShares, getClient);
  const { result, stats } = computeLiquidityHolders(accountBinShares, binStates, balances, tokenChains);
  await writeLiquidityHoldersFile(result);

  console.log(`\n${stats.distinctAccounts} account(s) hold liquidity across ${stats.distinctPoolPositions} pool position(s).`);
  console.log(`  total (account, bin) share position(s): ${stats.totalAccountBinPositions}`);
  console.log(`  bin(s) with unknown/unpriceable value: ${stats.binsWithUnknownValue}`);
}

main().catch((err) => {
  console.error(safeErrorMessage(err));
  process.exit(1);
});
