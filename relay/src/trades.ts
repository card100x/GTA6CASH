// KMCoin -> token trade: players send KMCoin (on KittyMine's own chain) to our
// KittyMine wallet; the relay spots the transfer in KittyMine's public blocks
// and credits them $GGG, which they collect on the site like mining winnings.
//
//   KittyMine transfer text (from the KMCoin Player source):
//     <senderWallet>*<rawAmount>_<receiverWallet>,<gas>$<proof>~<meta>%<key>;
//   1 KMCoin = 100,000,000,000,000 raw units.
//
// The sender's wallet number -> Steam/Xbox ID comes from KittyMine's public
// player feed (/api/player-state?wallet=N). Each transfer pays once (keyed by
// its proof hash). Credits only use escrow tokens that aren't reserved for the
// mining pool or owed to miners.
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { KITTYMINE_BASE, type NetworkBlock } from "./kittymine.js";
import type { Escrow } from "./solana.js";
import { add, type Store } from "./store.js";

export const KMC_UNIT = 100_000_000_000_000n;

export interface TradeConfig {
  wallet: string; // our KittyMine wallet number, e.g. "548645"
  mint: string; // token paid out
  symbol: string;
  rate: number; // whole tokens per 1 KMCoin
  fromHeight: number; // ignore blocks at/below this height
}

export interface Trade {
  proof: string; // transfer proof hash (unique)
  height: number;
  fromWallet: string;
  player: string | null; // Steam/Xbox ID, once known
  kmc: string; // raw KMCoin units
  out: string; // raw token units
  status: "resolving" | "waiting-funds" | "credited" | "unclaimable";
  at: number;
  note?: string;
}

type TradeState = { trades?: Record<string, Trade>; tradeWalletOwners?: Record<string, string> };

export function tradeConfigFromEnv(): TradeConfig | null {
  const e = process.env;
  if (!e.TRADE_KMC_WALLET || !e.TRADE_MINT || !e.TRADE_RATE) return null;
  return {
    wallet: e.TRADE_KMC_WALLET.replace(/^@/, ""),
    mint: new PublicKey(e.TRADE_MINT).toBase58(),
    symbol: e.TRADE_SYMBOL ?? "GGG",
    rate: Number(e.TRADE_RATE),
    fromHeight: Number(e.TRADE_FROM_HEIGHT ?? 0),
  };
}

/** Every transfer to `receiver` inside a block's raw text. */
export function findTransfers(raw: string, receiver: string): { from: string; amount: bigint; proof: string }[] {
  const out: { from: string; amount: bigint; proof: string }[] = [];
  const re = /(\d+)\*(\d+)_(\d+),(\d+)\$([0-9a-fA-F]{16,})/g;
  for (const m of raw.matchAll(re)) {
    if (m[3] === receiver && m[1] !== receiver) out.push({ from: m[1], amount: BigInt(m[2]), proof: m[5].toLowerCase() });
  }
  return out;
}

export class TradeDesk {
  private lastLookup = 0;
  constructor(
    public cfg: TradeConfig,
    private escrow: Escrow,
    private store: Store,
    private log: (...a: unknown[]) => void = console.log,
  ) {}

  private get st() {
    const s = this.store.state as unknown as TradeState;
    s.trades ??= {};
    s.tradeWalletOwners ??= {};
    return s as Required<TradeState>;
  }

  /** Called for every new KittyMine block. */
  onBlock(b: NetworkBlock) {
    if (b.height <= this.cfg.fromHeight || !b.raw) return;
    // Until we've seen a real transfer, keep a copy of any block that carries
    // transactions so the exact format can be checked.
    if ((b.txCount ?? 0) > 0) {
      try {
        fs.mkdirSync(path.resolve("data"), { recursive: true });
        fs.appendFileSync(path.resolve("data/kittymine-tx-blocks.log"), `${b.height} tx=${b.txCount} ${b.raw}\n`);
      } catch {}
    }
    for (const t of findTransfers(b.raw, this.cfg.wallet)) {
      if (this.st.trades[t.proof]) continue;
      const kmcMicro = (t.amount * 1_000_000n) / KMC_UNIT; // KMCoin with 6 decimals
      const rateMicro = BigInt(Math.round(this.cfg.rate * 1_000_000));
      const out = (kmcMicro * rateMicro) / 1_000_000n; // token raw units (6 decimals)
      this.st.trades[t.proof] = { proof: t.proof, height: b.height, fromWallet: t.from, player: this.st.tradeWalletOwners[t.from] ?? null, kmc: t.amount.toString(), out: out.toString(), status: "resolving", at: b.timestamp };
      this.log(`trade seen at #${b.height}: wallet ${t.from} sent ${Number(kmcMicro) / 1e6} KMCoin -> ${Number(out) / 1e6} ${this.cfg.symbol}`);
    }
  }

  /** Resolve senders and credit what we can. Called once per tick. */
  async settle() {
    for (const t of Object.values(this.st.trades)) {
      if (t.status === "credited" || t.status === "unclaimable") continue;
      if (!t.player) {
        if (Date.now() - this.lastLookup < 65_000) continue; // KittyMine asks for >= 60 s between lookups
        this.lastLookup = Date.now();
        const owner = await this.ownerOf(t.fromWallet).catch((e) => {
          t.note = `lookup failed: ${(e as Error).message}`;
          return undefined;
        });
        if (owner === undefined) continue;
        if (owner === null) {
          t.status = "unclaimable";
          t.note = "sender wallet has no Steam/Xbox account (legacy)";
          continue;
        }
        t.player = owner;
        this.st.tradeWalletOwners[t.fromWallet] = owner;
      }
      const free = await this.free();
      if (BigInt(t.out) > free) {
        t.status = "waiting-funds";
        t.note = `escrow is short on ${this.cfg.symbol}; credits automatically once topped up`;
        continue;
      }
      const s = this.store.state;
      (s.earned[this.cfg.mint] ??= {})[t.player] = add(s.earned[this.cfg.mint][t.player], BigInt(t.out));
      t.status = "credited";
      delete t.note;
      this.log(`trade credited: ${t.player} +${Number(t.out) / 1e6} ${this.cfg.symbol} (KittyMine wallet ${t.fromWallet})`);
    }
    this.store.save();
  }

  /** KittyMine wallet number -> Steam/Xbox ID (null = no gaming account). */
  private async ownerOf(wallet: string): Promise<string | null> {
    const r = await fetch(`${KITTYMINE_BASE}/api/player-state?wallet=${encodeURIComponent(wallet)}`, {
      headers: { accept: "application/json", "user-agent": "kmc-launchpad-relay/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { players?: { record?: { player?: string; wallet?: string } | null }[] };
    const rec = j.players?.[0]?.record;
    if (!rec || String(rec.wallet) !== wallet) throw new Error("wallet not in KittyMine's snapshot yet");
    const p = String(rec.player ?? "");
    return /^(7656\d{13}|2535\d{12})$/.test(p) ? p : null;
  }

  /** Escrow tokens not reserved for the mining pool, unclaimed winnings, or this desk's own credits. */
  private async free(): Promise<bigint> {
    const mint = new PublicKey(this.cfg.mint);
    const info = await this.escrow.mintInfo(mint);
    const bal = await this.escrow.balance(mint, info.programId);
    const s = this.store.state;
    let committed = 0n;
    const t = s.tokens[this.cfg.mint];
    if (t) committed += BigInt(t.pool) - BigInt(t.distributed);
    for (const [id, v] of Object.entries(s.earned[this.cfg.mint] ?? {})) committed += BigInt(v) - BigInt(s.claimed[this.cfg.mint]?.[id] ?? "0");
    const f = bal - committed;
    return f > 0n ? f : 0n;
  }

  async info() {
    const free = await this.free().catch(() => null);
    return { kmcWallet: this.cfg.wallet, rate: this.cfg.rate, symbol: this.cfg.symbol, mint: this.cfg.mint, available: free?.toString() ?? null };
  }

  recent() {
    return Object.values(this.st.trades).sort((a, b) => b.height - a.height).slice(0, 50);
  }
}
