// Solana side of the relay: the escrow wallet that holds every token's mining
// pool, launch verification, and claim payouts.
//
// v1 is custodial (one relay-held escrow key), the same trust model as the KMC
// bridge today. Every credit is in the public audit log; v2 moves pools into an
// on-chain Merkle-claim program.
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

export const CLUSTER = process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet";

export function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://${CLUSTER === "mainnet" ? "mainnet" : "devnet"}.helius-rpc.com/?api-key=${key}`;
  return CLUSTER === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

export function loadKeypair(file: string): Keypair {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const kp = Keypair.generate();
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`generated ${file} -> ${kp.publicKey.toBase58()}`);
    return kp;
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export interface MintInfo {
  programId: PublicKey;
  decimals: number;
  supply: bigint;
}

export class Escrow {
  conn: Connection;
  constructor(
    public key: Keypair,
    url = rpcUrl(),
  ) {
    this.conn = new Connection(url, "confirmed");
  }
  get address() {
    return this.key.publicKey;
  }

  async mintInfo(mint: PublicKey): Promise<MintInfo> {
    const acc = await this.conn.getAccountInfo(mint);
    if (!acc) throw new Error("mint not found");
    const m = await getMint(this.conn, mint, "confirmed", acc.owner);
    return { programId: acc.owner, decimals: m.decimals, supply: m.supply };
  }

  /**
   * Verify a launch: the tx succeeded and moved `mint` into the escrow's token
   * account. Returns the amount the escrow received (the mining pool).
   */
  async verifyLaunch(sig: string, mint: string): Promise<{ pool: bigint; creator: string; blockTime: number }> {
    const tx = await this.conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) throw new Error("launch tx not found (yet)");
    if (tx.meta?.err) throw new Error("launch tx failed");
    const owner = this.address.toBase58();
    const pre = tx.meta?.preTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
    const post = tx.meta?.postTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
    const pool = BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
    if (pool <= 0n) throw new Error("launch tx did not fund the mining escrow");
    const creator = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58() ?? "";
    return { pool, creator, blockTime: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000 };
  }

  async balance(mint: PublicKey, programId: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(mint, this.address, true, programId);
    const r = await this.conn.getTokenAccountBalance(ata).catch(() => null);
    return BigInt(r?.value.amount ?? "0");
  }

  /** Pay `amount` raw units of `mint` to `to` from the escrow. */
  async pay(mint: PublicKey, to: PublicKey, amount: bigint): Promise<string> {
    const info = await this.mintInfo(mint);
    const from = getAssociatedTokenAddressSync(mint, this.address, true, info.programId);
    const dest = getAssociatedTokenAddressSync(mint, to, true, info.programId);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      createAssociatedTokenAccountIdempotentInstruction(this.address, dest, to, mint, info.programId),
      createTransferCheckedInstruction(from, mint, dest, this.address, amount, info.decimals, [], info.programId),
    );
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.address;
    tx.sign(this.key);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`payout failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }
}
