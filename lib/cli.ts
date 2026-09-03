// Shared --chains/--factory CLI flag parsing.
import type { Address } from "viem";

export interface CliArgs {
  chains: number[] | null;
  factory: Address | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { chains: null, factory: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chains") {
      out.chains = argv[++i]!.split(",").map((s) => Number(s.trim()));
    } else if (argv[i] === "--factory") {
      out.factory = argv[++i] as Address;
    }
  }
  return out;
}
