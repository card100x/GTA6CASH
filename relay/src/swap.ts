// Swap desk: players send $KMC to the escrow and get another token (e.g. $GGG)
// back at a fixed rate. Both legs are plain Solana transfers, so anyone can
// audit them on Solscan.
//
// Two ways in:
//  - the site builds the transfer (POST /api/swap/build), the wallet signs it,
//    then the site asks for the payout (POST /api/swap/redeem {sig});
//  - anyone sends $KMC to the escrow straight from Phantom: the relay scans the
//    escrow's $KMC account every tick and pays those too.
//
// Payouts only use the escrow's OUT balance that isn't committed to a mining
// pool or owed to miners, so swaps can never eat into mining rewards.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Escrow } from "./solana.js";
import type { Store } from "./store.js";

export interface SwapConfig {
  inMint: string;
  inSymbol: string;
  outMint: string;
  outSymbol: string;
  rate: number; // whole OUT per whole IN
  start: number; // ms; deposits older than this are ignored
  minIn: number; // whole IN tokens
}

export interface SwapRecord {
  sig: string; // the player's deposit
  from: string;
  in: string; // raw IN
  out: string; // raw OUT
  status: "pending" | "sent" | "failed" | "waiting-funds";
  payoutSig: string | null;
  at: number;
  error?: string;
}

export function swapConfigFromEnv(): SwapConfig | null {
  const e = process.env;
  if (!e.SWAP_IN_MINT || !e.SWAP_OUT_MINT || !e.SWAP_RATE) return null;
  return {
    inMint: new PublicKey(e.SWAP_IN_MINT).toBase58(),
    inSymbol: e.SWAP_IN_SYMBOL ?? "KMC",
    outMint: new PublicKey(e.SWAP_OUT_MINT).toBase58(),
    outSymbol: e.SWAP_OUT_SYMBOL ?? "OUT",
    rate: Number(e.SWAP_RATE),
    start: e.SWAP_START ? Date.parse(e.SWAP_START) : 0,
    minIn: Number(e.SWAP_MIN_IN ?? 1),
  };
}

type SwapState = { swaps?: Record<string, SwapRecord>; swapLastSig?: string | null };

export class SwapDesk {
  private lock: Promise<unknown> = Promise.resolve();
  private dec: { in: number; out: number; inProg: PublicKey; outProg: PublicKey } | null = null;

  constructor(
    public cfg: SwapConfig,
    private escrow: Escrow,
    private store: Store,
    private log: (...a: unknown[]) => void = console.log,
  ) {}

  private get st(): SwapState & { swaps: Record<string, SwapRecord> } {
    const s = this.store.state as unknown as SwapState;
    s.swaps ??= {};
    return s as SwapState & { swaps: Record<string, SwapRecord> };
  }

  private async mints() {
    if (!this.dec) {
      const [i, o] = await Promise.all([this.escrow.mintInfo(new PublicKey(this.cfg.inMint)), this.escrow.mintInfo(new PublicKey(this.cfg.outMint))]);
      this.dec = { in: i.decimals, out: o.decimals, inProg: i.programId, outProg: o.programId };
    }
    return this.dec;
  }

  /** raw IN -> raw OUT */
  async quote(rawIn: bigint): Promise<bigint> {
    const d = await this.mints();
    const rateMicro = BigInt(Math.round(this.cfg.rate * 1_000_000));
    const scale = 10n ** BigInt(Math.abs(d.out - d.in));
    let out = (rawIn * rateMicro) / 1_000_000n;
    out = d.out >= d.in ? out * scale : out / scale;
    return out;
  }

  /** OUT tokens in the escrow that aren't reserved for mining pools or unclaimed winnings. */
  async available(): Promise<bigint> {
    const d = await this.mints();
    const bal = await this.escrow.balance(new PublicKey(this.cfg.outMint), d.outProg);
    const s = this.store.state;
    let committed = 0n;
    const t = s.tokens[this.cfg.outMint];
    if (t) {
      committed += BigInt(t.pool) - BigInt(t.distributed); // not mined yet
      for (const [id, v] of Object.entries(s.earned[t.mint] ?? {})) committed += BigInt(v) - BigInt(s.claimed[t.mint]?.[id] ?? "0"); // mined, not claimed
    }
    for (const r of Object.values(this.st.swaps)) if (r.status === "pending" || r.status === "waiting-funds") committed += BigInt(r.out);
    const free = bal - committed;
    return free > 0n ? free : 0n;
  }

  async info() {
    const avail = await this.available().catch(() => null);
    const d = await this.mints().catch(() => null);
    return {
      ...this.cfg,
      escrow: this.escrow.address.toBase58(),
      available: avail?.toString() ?? null,
      outDecimals: d?.out ?? null,
      inDecimals: d?.in ?? null,
    };
  }

  /** Unsigned tx: player -> escrow, `amount` whole IN tokens. The player pays the fee. */
  async build(walletIn: string, amount: number): Promise<{ tx: string; in: string; out: string }> {
    if (!(amount >= this.cfg.minIn)) throw new Error(`minimum swap is ${this.cfg.minIn} ${this.cfg.inSymbol}`);
    const d = await this.mints();
    const wallet = new PublicKey(walletIn);
    const mint = new PublicKey(this.cfg.inMint);
    const rawIn = BigInt(Math.round(amount * 10 ** d.in));
    const out = await this.quote(rawIn);
    const avail = await this.available();
    if (out > avail) throw new Error(`the swap desk only has ${(Number(avail) / 10 ** d.out).toLocaleString()} ${this.cfg.outSymbol} left right now`);
    const from = getAssociatedTokenAddressSync(mint, wallet, true, d.inProg);
    const bal = await this.escrow.conn.getTokenAccountBalance(from).catch(() => null);
    if (BigInt(bal?.value.amount ?? "0") < rawIn) throw new Error(`your wallet doesn't have ${amount.toLocaleString()} ${this.cfg.inSymbol}`);
    const to = getAssociatedTokenAddressSync(mint, this.escrow.address, true, d.inProg);
    const { blockhash } = await this.escrow.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        createAssociatedTokenAccountIdempotentInstruction(wallet, to, this.escrow.address, mint, d.inProg),
        createTransferCheckedInstruction(from, mint, to, wallet, rawIn, d.in, [], d.inProg),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    return { tx: Buffer.from(tx.serialize()).toString("base64"), in: rawIn.toString(), out: out.toString() };
  }

  /** Pay out a deposit. Safe to call twice: each deposit sig pays once. */
  redeem(sig: string): Promise<SwapRecord> {
    const run = this.lock.then(() => this.doRedeem(sig));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async doRedeem(sig: string): Promise<SwapRecord> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new Error("that doesn't look like a transaction signature");
    const existing = this.st.swaps[sig];
    // "failed" stays failed: the payout may have landed even though confirming timed out,
    // so a human checks Solscan before retrying (never risk paying twice).
    if (existing && existing.status !== "waiting-funds") return existing;

    let rec = existing;
    if (!rec) {
      const tx = await this.escrow.conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) throw new Error("transaction not found yet; try again in a few seconds");
      if (tx.meta?.err) throw new Error("that transaction failed on-chain");
      const at = (tx.blockTime ?? 0) * 1000;
      if (at < this.cfg.start) throw new Error("that deposit is from before the swap desk opened");
      const me = this.escrow.address.toBase58();
      const delta = new Map<string, bigint>();
      for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === this.cfg.inMint && b.owner) delta.set(b.owner, (delta.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount));
      for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === this.cfg.inMint && b.owner) delta.set(b.owner, (delta.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      const rawIn = delta.get(me) ?? 0n;
      if (rawIn <= 0n) throw new Error(`that transaction didn't send ${this.cfg.inSymbol} to the swap desk`);
      // the sender is whoever lost exactly that much (fallback: the fee payer)
      const from = [...delta].find(([o, v]) => o !== me && v === -rawIn)?.[0] ?? tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
      if (!from) throw new Error("couldn't tell who sent it");
      if (from === me) throw new Error("that's the desk moving its own funds");
      const d = await this.mints();
      if (rawIn < BigInt(Math.round(this.cfg.minIn * 10 ** d.in))) throw new Error(`below the ${this.cfg.minIn} ${this.cfg.inSymbol} minimum (sent ${Number(rawIn) / 10 ** d.in})`);
      rec = { sig, from, in: rawIn.toString(), out: (await this.quote(rawIn)).toString(), status: "pending", payoutSig: null, at: Date.now() };
      this.st.swaps[sig] = rec;
      this.store.save();
    }

    // funds check excludes this record itself
    rec.status = "failed";
    const avail = await this.available();
    if (BigInt(rec.out) > avail) {
      rec.status = "waiting-funds";
      rec.error = `desk is short on ${this.cfg.outSymbol}; it pays automatically once topped up`;
      this.store.save();
      this.log(`swap ${sig}: waiting for funds (${rec.out} > ${avail})`);
      return rec;
    }
    rec.status = "pending";
    delete rec.error;
    this.store.save();
    try {
      rec.payoutSig = await this.escrow.pay(new PublicKey(this.cfg.outMint), new PublicKey(rec.from), BigInt(rec.out));
      rec.status = "sent";
      this.log(`swap ${rec.from}: ${rec.in} ${this.cfg.inSymbol} -> ${rec.out} ${this.cfg.outSymbol} (${rec.payoutSig})`);
    } catch (e) {
      rec.status = "failed";
      rec.error = (e as Error).message;
      this.log(`swap ${sig} payout failed: ${rec.error}`);
    }
    this.store.save();
    return rec;
  }

  /** Find deposits made straight from a wallet (not through the site) and pay them. Also retries ones waiting for funds. */
  async scan(): Promise<void> {
    const d = await this.mints();
    const ata = getAssociatedTokenAddressSync(new PublicKey(this.cfg.inMint), this.escrow.address, true, d.inProg);
    const s = this.st;
    const sigs = await this.escrow.conn.getSignaturesForAddress(ata, { limit: 50, ...(s.swapLastSig ? { until: s.swapLastSig } : {}) }, "confirmed");
    for (const x of sigs.reverse()) {
      if (!x.err && !s.swaps[x.signature] && (x.blockTime ?? 0) * 1000 >= this.cfg.start) {
        await this.redeem(x.signature).catch((e) => this.log(`swap scan ${x.signature}: ${(e as Error).message}`));
      }
      s.swapLastSig = x.signature;
    }
    for (const r of Object.values(s.swaps)) {
      if (r.status === "waiting-funds") await this.redeem(r.sig).catch(() => undefined);
    }
    this.store.save();
  }

  recent(wallet?: string) {
    return Object.values(this.st.swaps)
      .filter((r) => !wallet || r.from === wallet)
      .sort((a, b) => b.at - a.at)
      .slice(0, 50);
  }
}
