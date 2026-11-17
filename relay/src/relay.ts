import { MIN_POOL_PCT } from "./pump.js";
// The relay: polls KittyMine + presence, runs the engine, handles links and claims.
import { PublicKey } from "@solana/web3.js";
import { claimableById, processBlock, pruneWins, remaining, type Snapshots } from "./engine.js";
import { fetchBlocksAfter, fetchBlocks, type NetworkBlock } from "./kittymine.js";
import { completeLinks, isSteamId, isXuid, startLink } from "./link.js";
import type { PresenceProvider } from "./presence.js";
import type { Escrow } from "./solana.js";
import { checkFeeSplit } from "./pumpcheck.js";
import { add, type Store, type Token, type TokenGames, type TokenRules } from "./store.js";
import type { SwapDesk } from "./swap.js";
import type { Accounts } from "./accounts.js";
import type { TradeDesk } from "./trades.js";

// Producer accounts seen in KittyMine's feed (learned at runtime too).
export const DEFAULT_PRODUCERS = { Steam: "76561198779127606", Xbox: "2535418625213019" };

export const DEFAULT_RULES: TokenRules = { minAccountAgeDays: 30, maxWinsPerDay: 50, requireTwoSamples: true };

export interface RegisterInput {
  mint: string;
  launchSig: string;
  name: string;
  symbol: string;
  image?: string;
  games: Partial<TokenGames>;
  periodDays: number;
  rules?: Partial<TokenRules>;
}

type Log = (...a: unknown[]) => void;

export class Relay {
  snaps: Snapshots = { current: {}, previous: {} };
  producers: Record<"Steam" | "Xbox", string> = { ...DEFAULT_PRODUCERS };
  lastTick: { at: number; blocks: number; draws: number; errors: string[] } | null = null;
  private claimLock: Promise<unknown> = Promise.resolve();
  swap: SwapDesk | null = null;
  accounts: Accounts | null = null;
  trades: TradeDesk | null = null;

  constructor(
    public store: Store,
    public providers: PresenceProvider[],
    public escrow: Escrow | null,
    private fetchAfter: (h: number) => Promise<NetworkBlock[]> = fetchBlocksAfter,
    private log: Log = console.log,
  ) {}

  get state() {
    return this.store.state;
  }

  async tick(): Promise<void> {
    const errors: string[] = [];
    // 1. presence
    for (const p of this.providers) {
      if (!p.enabled) continue;
      try {
        const snap = await p.snapshot(this.producers[p.source]);
        this.snaps.previous[p.source] = this.snaps.current[p.source];
        this.snaps.current[p.source] = snap;
      } catch (e) {
        errors.push(`${p.source} presence: ${(e as Error).message}`);
      }
    }
    // 2. wallet links (Steam real-name codes)
    try {
      await this.checkLinks();
    } catch (e) {
      errors.push(`links: ${(e as Error).message}`);
    }
    // 3. blocks
    let blocks: NetworkBlock[] = [];
    let draws = 0;
    try {
      if (this.state.cursor === null) {
        const { blocks: latest } = await fetchBlocks(1);
        this.state.cursor = latest[0]?.height ?? null;
        this.log(`starting at KittyMine height ${this.state.cursor}`);
      } else {
        blocks = await this.fetchAfter(this.state.cursor);
      }
      for (const b of blocks) {
        if ((b.source === "Steam" || b.source === "Xbox") && b.producer) this.producers[b.source] = b.producer;
        this.trades?.onBlock(b);
        const made = processBlock(this.state, b, this.snaps);
        draws += made.length;
        for (const d of made) {
          const t = this.state.tokens[d.mint];
          this.log(`#${d.height} ${t.symbol}: ${d.winner} +${d.amount} (${d.candidates} eligible)`);
        }
        this.state.cursor = b.height;
      }
    } catch (e) {
      errors.push(`blocks: ${(e as Error).message}`);
    }
    // 4a. KMCoin trades: credit tokens for KMCoin sent to our KittyMine wallet
    if (this.trades) {
      try {
        await this.trades.settle();
      } catch (e) {
        errors.push(`trades: ${(e as Error).message}`);
      }
    }
    // 4b. swap desk: pay $KMC deposits sent straight from a wallet
    if (this.swap) {
      try {
        await this.swap.scan();
      } catch (e) {
        errors.push(`swap: ${(e as Error).message}`);
      }
    }
    pruneWins(this.state);
    this.store.save();
    this.lastTick = { at: Date.now(), blocks: blocks.length, draws, errors };
    for (const e of errors) this.log("warn:", e);
  }

  private async checkLinks() {
    const pending = Object.keys(this.state.pendingLinks);
    if (pending.length === 0) return;
    const steam = this.providers.find((p) => p.source === "Steam" && p.enabled);
    const known = this.snaps.current.Steam?.players ?? [];
    const knownIds = new Set(known.map((p) => p.id));
    const missing = pending.filter((id) => isSteamId(id) && !knownIds.has(id));
    const extra = steam && missing.length ? await steam.lookup(missing) : [];
    for (const id of completeLinks(this.state, [...known, ...extra])) {
      this.log(`linked ${id} -> ${this.state.links[id]}`);
    }
  }

  async registerToken(input: RegisterInput): Promise<Token> {
    if (!this.escrow) throw new Error("relay has no escrow configured");
    const mint = new PublicKey(input.mint).toBase58();
    if (this.state.tokens[mint]) throw new Error("token already registered");
    const games: TokenGames = {
      any: Boolean(input.games.any),
      steam: (input.games.steam ?? []).map(String).filter((g) => /^\d{1,10}$/.test(g)).slice(0, 25),
      xbox: (input.games.xbox ?? []).map(String).filter((g) => /^\d{1,12}$/.test(g)).slice(0, 25),
    };
    if (!games.any && games.steam.length + games.xbox.length === 0) throw new Error("pick at least one game");
    const days = Number(input.periodDays);
    if (!(days >= 7 && days <= 365)) throw new Error("emission period must be 7–365 days");
    const { pool, creator, blockTime } = await this.escrow.verifyLaunch(input.launchSig, mint);
    const feeWallet = process.env.KMC_FEE_WALLET;
    if (!feeWallet) throw new Error("relay has no KMC_FEE_WALLET configured");
    await checkFeeSplit(this.escrow.conn, new PublicKey(mint), new PublicKey(feeWallet));
    const { supply } = await this.escrow.mintInfo(new PublicKey(mint));
    const minBps = BigInt(Math.round(MIN_POOL_PCT * 100));
    if (pool * 10_000n < supply * minBps) throw new Error(`mining pool must be at least ${MIN_POOL_PCT}% of supply`);
    const t: Token = {
      mint,
      name: String(input.name ?? "").slice(0, 32),
      symbol: String(input.symbol ?? "").slice(0, 10),
      image: input.image ? String(input.image).slice(0, 300) : undefined,
      creator,
      launchSig: input.launchSig,
      createdAt: Math.max(blockTime, Date.now() - 5 * 60_000),
      games,
      rules: { ...DEFAULT_RULES, ...input.rules },
      pool: pool.toString(),
      periodMs: days * 86_400_000,
      distributed: "0",
      lastDripAt: null,
    };
    this.state.tokens[mint] = t;
    this.store.save();
    this.log(`registered ${t.symbol} ${mint}: pool ${pool} over ${days}d`, games);
    return t;
  }

  /**
   * Admin: start mining a coin whose pool tokens were sent to the escrow by hand
   * (no pump.fun launch-through-us, no fee-split check). The pool must be covered
   * by escrow tokens not already reserved for this coin's miners.
   */
  async addTokenManual(input: { mint: string; name: string; symbol: string; image?: string; steam?: string[]; xbox?: string[]; any?: boolean; periodDays: number; pool: number; perDraw?: number; rules?: Partial<TokenRules> }) {
    if (!this.escrow) throw new Error("relay has no escrow configured");
    const mint = new PublicKey(input.mint).toBase58();
    if (this.state.tokens[mint]) throw new Error("token already registered");
    const info = await this.escrow.mintInfo(new PublicKey(mint));
    const bal = await this.escrow.balance(new PublicKey(mint), info.programId);
    const pool = BigInt(Math.round(Number(input.pool) * 10 ** info.decimals));
    if (!(pool > 0n)) throw new Error("pool must be > 0");
    if (pool > bal) throw new Error(`escrow holds only ${Number(bal) / 10 ** info.decimals} of this token; send the pool to ${this.escrow.address.toBase58()} first`);
    const perDraw = input.perDraw ? BigInt(Math.round(Number(input.perDraw) * 10 ** info.decimals)) : null;
    const days = perDraw ? 365 : Number(input.periodDays);
    if (!(days > 0 && days <= 365)) throw new Error("periodDays: 1-365");
    const games: TokenGames = {
      any: Boolean(input.any),
      steam: (input.steam ?? []).map(String).filter((g) => /^\d{1,10}$/.test(g)),
      xbox: (input.xbox ?? []).map((g) => String(g).toLowerCase().trim()).filter(Boolean),
    };
    if (!games.any && games.steam.length + games.xbox.length === 0) throw new Error("pick at least one game");
    const t: Token = {
      mint,
      name: String(input.name).slice(0, 32),
      symbol: String(input.symbol).slice(0, 10),
      image: input.image ? String(input.image).slice(0, 300) : undefined,
      creator: this.escrow.address.toBase58(),
      launchSig: "manual",
      createdAt: Date.now(),
      games,
      rules: { ...DEFAULT_RULES, ...input.rules },
      pool: pool.toString(),
      periodMs: Math.round(days * 86_400_000),
      ...(perDraw ? { perDraw: perDraw.toString() } : {}),
      distributed: "0",
      lastDripAt: null,
    };
    this.state.tokens[mint] = t;
    this.store.save();
    this.log(`registered (manual) ${t.symbol} ${mint}: pool ${pool} over ${days}d`, games);
    return t;
  }

  requestLink(gamingId: string, wallet: string) {
    const id = String(gamingId).trim();
    if (!isSteamId(id) && !isXuid(id)) throw new Error("enter a SteamID64 (7656…) or Xbox XUID (2535…)");
    const w = new PublicKey(wallet).toBase58();
    const code = startLink(this.state, id, w);
    this.store.save();
    return {
      code,
      where: isSteamId(id) ? "Steam profile → Edit Profile → Real name" : "Xbox profile → Bio",
      xboxSupported: !isXuid(id) || this.providers.some((p) => p.source === "Xbox" && p.enabled),
    };
  }

  /** Dev/test only: link without a profile proof. */
  forceLink(gamingId: string, wallet: string) {
    this.state.links[String(gamingId)] = new PublicKey(wallet).toBase58();
    delete this.state.pendingLinks[String(gamingId)];
    this.store.save();
  }

  /** Pay out everything `wallet` has earned for `mint`. Serialized. */
  claim(wallet: string, mint: string): Promise<{ sig: string; amount: string }> {
    const run = this.claimLock.then(() => this.doClaim(wallet, mint));
    this.claimLock = run.catch(() => undefined);
    return run;
  }

  private async doClaim(walletIn: string, mintIn: string) {
    if (!this.escrow) throw new Error("relay has no escrow configured");
    const wallet = new PublicKey(walletIn).toBase58();
    const mint = new PublicKey(mintIn).toBase58();
    if (!this.state.tokens[mint]) throw new Error("unknown token");
    const parts = claimableById(this.state, wallet, mint);
    let amount = 0n;
    for (const v of parts.values()) amount += v;
    if (amount <= 0n) throw new Error("nothing to claim");
    // book it first so a crash mid-send can't double-pay; roll back on failure
    const claimed = (this.state.claimed[mint] ??= {});
    for (const [id, v] of parts) claimed[id] = add(claimed[id], v);
    const rec = { wallet, mint, amount: amount.toString(), sig: null as string | null, status: "pending" as const, at: Date.now() };
    this.state.claims.unshift(rec);
    this.state.claims.length = Math.min(this.state.claims.length, 2_000);
    this.store.save();
    try {
      const sig = await this.escrow.pay(new PublicKey(mint), new PublicKey(wallet), amount);
      Object.assign(rec, { sig, status: "sent" });
      this.store.save();
      this.log(`claim ${wallet} ${amount} ${this.state.tokens[mint].symbol}: ${sig}`);
      return { sig, amount: amount.toString() };
    } catch (e) {
      for (const [id, v] of parts) claimed[id] = add(claimed[id], -v);
      Object.assign(rec, { status: "failed", error: (e as Error).message });
      this.store.save();
      throw e;
    }
  }

  tokenView(t: Token) {
    const earners = Object.entries(this.state.earned[t.mint] ?? {})
      .sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1))
      .slice(0, 20)
      .map(([id, amount]) => ({ id, amount, linked: Boolean(this.state.links[id]) }));
    return {
      ...t,
      remaining: remaining(t).toString(),
      players: Object.keys(this.state.earned[t.mint] ?? {}).length,
      topEarners: earners,
      recentDraws: this.state.draws.filter((d) => d.mint === t.mint).slice(0, 50),
    };
  }

  playerView(id: string) {
    const earnings = Object.values(this.state.tokens).map((t) => {
      const earned = BigInt(this.state.earned[t.mint]?.[id] ?? "0");
      const claimed = BigInt(this.state.claimed[t.mint]?.[id] ?? "0");
      return { mint: t.mint, symbol: t.symbol, earned: earned.toString(), unclaimed: (earned - claimed).toString() };
    });
    return {
      id,
      wallet: this.state.links[id] ?? null,
      pendingLink: this.state.pendingLinks[id] ?? null,
      earnings: earnings.filter((e) => e.earned !== "0"),
    };
  }

  walletView(wallet: string) {
    const ids = Object.entries(this.state.links)
      .filter(([, w]) => w === wallet)
      .map(([id]) => id);
    const tokens = Object.values(this.state.tokens)
      .map((t) => {
        let sum = 0n;
        for (const v of claimableById(this.state, wallet, t.mint).values()) sum += v;
        return { mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, claimable: sum.toString() };
      })
      .filter((x) => x.claimable !== "0");
    return { wallet, ids, tokens, claims: this.state.claims.filter((c) => c.wallet === wallet).slice(0, 50) };
  }
}
