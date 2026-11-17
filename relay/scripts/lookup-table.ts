// KMC Launchpad's address lookup table: the fixed accounts every launch uses
// (pump.fun global/fee/event accounts, token programs, the KMC fee wallet and
// escrow...). It shrinks a launch from ~1.8KB to well under the 1232-byte limit.
//
//   npx tsx scripts/lookup-table.ts <escrow> <kmcFeeWallet>           dry run: list + size check
//   npx tsx scripts/lookup-table.ts <escrow> <kmcFeeWallet> --send    create it (admin pays ~0.003 SOL)
//
// Mainnet: SOLANA_CLUSTER=mainnet, admin key in keys/admin-mainnet.json.
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { CLUSTER, connection, explorerTx, loadAdmin } from "../src/env.js";
import { buildPumpLaunch } from "../src/pump.js";

const [escrowArg, feeArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!escrowArg || !feeArg) throw new Error("usage: lookup-table.ts <escrow> <kmcFeeWallet> [--send]");
const send = process.argv.includes("--send");
const escrow = new PublicKey(escrowArg);
const kmcFeeWallet = new PublicKey(feeArg);

// Build two launches with different creators/mints; the accounts they share are fixed.
const stand = (s: string) => new PublicKey(s);
const make = (creator: PublicKey) =>
  buildPumpLaunch({
    conn: connection,
    creator,
    mint: Keypair.generate().publicKey,
    name: "Example Coin Name",
    symbol: "EXAMPLE",
    uri: "https://kmc-launchpad.example/metadata/0123456789abcdef0123456789.json",
    poolPct: 10,
    escrow,
    kmcFeeWallet,
    treasury: kmcFeeWallet,
    deployFeeLamports: 1,
  });
const [a, b] = await Promise.all([make(Keypair.generate().publicKey), make(stand("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"))]);
const keysOf = (ixs: typeof a.instructions) => new Set(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())));
const programs = new Set(a.instructions.map((ix) => ix.programId.toBase58()));
const kb = keysOf(b.instructions);
const fixed = [...keysOf(a.instructions)].filter((k) => kb.has(k) && !programs.has(k)).map((k) => new PublicKey(k));
console.log(`${fixed.length} fixed accounts:`);
for (const k of fixed) console.log("  ", k.toBase58());

// Size check with a local (not yet on-chain) table.
const fake = new AddressLookupTableAccount({
  key: Keypair.generate().publicKey,
  state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: fixed },
});
const withTable = await buildPumpLaunch({
  conn: connection, creator: Keypair.generate().publicKey, mint: Keypair.generate().publicKey,
  name: "A Thirty Two Character Long Name", symbol: "THIRTEENCHARS", uri: "https://kmc-launchpad.example/" + "x".repeat(120),
  poolPct: 10, escrow, kmcFeeWallet, treasury: kmcFeeWallet, deployFeeLamports: 1, lookupTableAccount: fake,
});
for (const [label, tx] of [["launch", withTable.launchTx], ["lock", withTable.lockTx]] as const) {
  const size = tx.serialize().length;
  console.log(`${label} tx (max-length name/symbol, long uri) with table: ${size} bytes -> ${size <= 1232 ? "FITS" : "TOO BIG"}`);
}

if (!send) {
  console.log("\ndry run. add --send to create the table on", CLUSTER);
  process.exit(0);
}
const admin = loadAdmin();
const slot = await connection.getSlot("finalized");
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot });
const extendIx = AddressLookupTableProgram.extendLookupTable({ authority: admin.publicKey, payer: admin.publicKey, lookupTable: table, addresses: fixed });
const tx = new VersionedTransaction(
  new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions: [createIx, extendIx] }).compileToV0Message(),
);
tx.sign([admin]);
const sig = await connection.sendTransaction(tx);
await connection.confirmTransaction(sig, "confirmed");
console.log("lookup table:", table.toBase58(), explorerTx(sig));
console.log("set KMC_LOOKUP_TABLE=" + table.toBase58());
