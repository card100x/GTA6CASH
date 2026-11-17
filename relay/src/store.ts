// Relay state, persisted as one JSON file (atomic writes). Amounts are raw token
// units kept as decimal strings so nothing loses precision.
import fs from "node:fs";
import path from "node:path";

export interface TokenGames {
  any: boolean; // true = every game counts (pays KittyMine's own block winner)
  steam: string[]; // Steam appids
  xbox: string[]; // Xbox titleIds
}

export interface TokenRules {
  minAccountAgeDays: number; // Steam account age, when public (0 = off)
  maxWinsPerDay: number; // per gaming ID, per token (0 = off)
  requireTwoSamples: boolean; // must be seen in-game in 2 consecutive presence samples
}

export interface Token {
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  creator: string;
  launchSig: string;
  createdAt: number;
  games: TokenGames;
  rules: TokenRules;
  pool: string; // raw units locked in escrow for mining
  periodMs: number; // emission period (time-based drip)
  perDraw?: string; // if set: fixed raw units per draw instead of the time-based drip (no period, runs until the pool is empty)
  distributed: string; // raw units credited to players so far
  lastDripAt: number | null; // timestamp of the last block that dripped emission
}

export interface Draw {
  height: number;
  mint: string;
  source: string;
  winner: string;
  amount: string;
  candidates: number;
  candidatesHash: string; // sha256 of the sorted candidate list, for audits
  at: number;
}

export interface Claim {
  wallet: string;
  mint: string;
  amount: string;
  sig: string | null;
  status: "pending" | "sent" | "failed";
  at: number;
  error?: string;
}

export interface State {
  version: 1;
  cursor: number | null; // last processed KittyMine height
  tokens: Record<string, Token>;
  earned: Record<string, Record<string, string>>; // mint -> gamingId -> raw
  claimed: Record<string, Record<string, string>>; // mint -> gamingId -> raw
  links: Record<string, string>; // gamingId -> wallet
  pendingLinks: Record<string, { wallet: string; code: string; at: number }>; // gamingId -> request
  draws: Draw[]; // most recent first, capped
  claims: Claim[]; // most recent first, capped
  wins: Record<string, number>; // `${mint}:${id}:${utcDay}` -> count
}

export function emptyState(): State {
  return {
    version: 1,
    cursor: null,
    tokens: {},
    earned: {},
    claimed: {},
    links: {},
    pendingLinks: {},
    draws: [],
    claims: [],
    wins: {},
  };
}

export class Store {
  state: State;
  constructor(private file: string | null) {
    this.state = file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as State) : emptyState();
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

export const add = (a: string | undefined, b: bigint) => (BigInt(a ?? "0") + b).toString();
