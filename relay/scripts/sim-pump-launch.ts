// Simulates a KMC Launchpad launch against the REAL pump.fun on mainnet without
// signing or spending anything (sigVerify off; any funded wallet stands in as
// the creator).
//
// Without our address lookup table the full launch is too big for one tx, so
// this checks the two halves separately:
//   A) create + buy pool% + move it to escrow  (escrow balance must equal the pool)
//   B) the 50/50 fee-split lock, on a real fresh pump coin, posing as its creator
//
//   npx tsx scripts/sim-pump-launch.ts [poolPct]
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";
import { createRequire } from "node:module";
import type * as PumpSdkTypes from "@pump-fun/pump-sdk";
import { buildPumpLaunch, CREATOR_SHARE_BPS } from "../src/pump.js";

const pump = createRequire(import.meta.url)("@pump-fun/pump-sdk") as typeof PumpSdkTypes;
const conn = new Connection(process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const whale = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const poolPct = Number(process.argv[2] ?? 10);

async function sim(label: string, payer: PublicKey, ixs: TransactionInstruction[], watch: PublicKey[] = []) {
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const size = tx.serialize().length;
  const r = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: watch.map((w) => w.toBase58()) },
  });
  console.log(`\n[${label}] ${size} bytes | err: ${JSON.stringify(r.value.err)} | CU: ${r.value.unitsConsumed}`);
  for (const l of (r.value.logs ?? []).filter((l) => /Instruction:|failed|rror/.test(l))) console.log("   ", l);
  return r.value;
}

// ---------- A: create + buy + escrow ----------
const mint = Keypair.generate().publicKey;
const escrow = Keypair.generate().publicKey;
const kmcFeeWallet = Keypair.generate().publicKey;
const b = await buildPumpLaunch({
  conn, creator: whale, mint, name: "K", symbol: "K", uri: "https://x.co/k",
  poolPct, escrow, kmcFeeWallet,
});
console.log(`pool ${poolPct}% = ${Number(b.poolTokens) / 1e6} tokens; first buy costs up to ${Number(b.maxSolCost) / 1e9} SOL`);
const escrowAta = getAssociatedTokenAddressSync(mint, escrow, true, TOKEN_2022_PROGRAM_ID);
const a = await sim("A create+buy+escrow", whale, [...b.groups.createAndBuy, ...b.groups.toEscrow], [escrowAta]);
const acc = a.accounts?.[0];
if (acc) {
  const amount = AccountLayout.decode(Buffer.from(acc.data[0], "base64").subarray(0, 165)).amount;
  console.log(`    escrow received ${Number(amount) / 1e6} tokens (expected ${Number(b.poolTokens) / 1e6}) -> ${amount === b.poolTokens ? "OK" : "MISMATCH"}`);
}

// ---------- B: fee-split lock on a real fresh coin ----------
const online = new pump.OnlinePumpSdk(conn);
const sigs = await conn.getSignaturesForAddress(pump.PUMP_PROGRAM_ID, { limit: 400 });
let target: { mint: PublicKey; creator: PublicKey } | null = process.env.FEE_TEST_MINT
  ? { mint: new PublicKey(process.env.FEE_TEST_MINT), creator: (await online.fetchBondingCurve(process.env.FEE_TEST_MINT)).creator }
  : null;
let checked = 0;
for (const s of target ? [] : sigs) {
  if (s.err) continue;
  await new Promise((r) => setTimeout(r, 250));
  checked++;
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 } as never).catch((e) => (console.log("   rpc:", String(e).slice(0, 80)), null));
  if (!tx?.meta?.logMessages?.some((l) => l.includes("Instruction: CreateV2") || l.includes("Instruction: Create"))) continue;
  const m = tx.meta.postTokenBalances?.find((x) => x.mint.endsWith("pump"))?.mint;
  if (!m) continue;
  const bc = await online.fetchBondingCurve(m).catch(() => null);
  if (bc && !bc.complete && !(await conn.getAccountInfo(pump.feeSharingConfigPda(new PublicKey(m))))) {
    target = { mint: new PublicKey(m), creator: bc.creator };
    break;
  }
}
if (!target) throw new Error(`no fresh pump coin found in ${checked} recent txs; rerun`);
console.log(`\nusing fresh coin ${target.mint.toBase58()} (creator ${target.creator.toBase58()})`);
const split = [
  await pump.PUMP_SDK.sweepCreatorFeeInstruction({ payer: target.creator, mint: target.mint, creator: target.creator, quoteMint: NATIVE_MINT }),
  await pump.PUMP_SDK.createFeeSharingConfig({ creator: target.creator, mint: target.mint, pool: null }),
  await pump.PUMP_SDK.updateFeeSharesV2({
    authority: target.creator, mint: target.mint, currentShareholders: [target.creator],
    newShareholders: [
      { address: target.creator, shareBps: CREATOR_SHARE_BPS },
      { address: kmcFeeWallet, shareBps: 10_000 - CREATOR_SHARE_BPS },
    ],
    quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID,
  }),
];
const cfg = pump.feeSharingConfigPda(target.mint);
const r = await sim("B fee-split lock", target.creator, split, [cfg]);
const c = r.accounts?.[0];
if (c) {
  const sc = pump.PUMP_SDK.decodeSharingConfig({ data: Buffer.from(c.data[0], "base64") } as never);
  console.log("    sharing config:", JSON.stringify({ adminRevoked: (sc as any).adminRevoked, shareholders: (sc as any).shareholders.map((s: any) => [s.address.toBase58(), s.shareBps]) }));
}
