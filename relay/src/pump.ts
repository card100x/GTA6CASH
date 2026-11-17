// Builds a KMC Launchpad launch on pump.fun: two transactions the creator signs
// in one wallet prompt (a single one would be ~1.8KB, over Solana's limit):
//
//   1. create_v2 + first buy of exactly `poolPct`% of supply (creator is the
//      first buyer, so the amount is exact)
//   2. move those tokens into the mining escrow
//   3. create_fee_sharing_config + update_fee_shares_v2:
//      creator fee split 50% creator / 50% KMC, then the admin is revoked,
//      so the split is locked forever on-chain
//   4. optional deploy fee in SOL to the KMC treasury
// launchTx = 1+2 (atomic, so the pool can't go missing), lockTx = 3+4.
// A coin whose split isn't locked is never listed or mined.
//
// Nothing here is custodial except the escrow (v1), which the relay pays out of.
import "dotenv/config";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import type * as PumpSdkTypes from "@pump-fun/pump-sdk";
// The SDK's ESM build breaks on an @coral-xyz/anchor named import; its CJS build works.
const pumpSdk = createRequire(import.meta.url)("@pump-fun/pump-sdk") as typeof PumpSdkTypes;
const { OnlinePumpSdk, PUMP_SDK, getBuySolAmountFromTokenAmount } = pumpSdk;

// Normally 10%. MIN_POOL_PCT in .env can lower it (down to 0.1%) for small test launches.
export const MIN_POOL_PCT = Math.min(10, Math.max(0.1, Number(process.env.MIN_POOL_PCT ?? 10) || 10));
export const MAX_POOL_PCT = 15;
export const CREATOR_SHARE_BPS = 5_000; // 50% of the pump.fun creator fee to the creator
export const TOKEN_DECIMALS = 6;

export interface LaunchParams {
  conn: Connection;
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  poolPct: number; // MIN_POOL_PCT–15
  escrow: PublicKey; // relay escrow wallet that holds mining pools
  kmcFeeWallet: PublicKey; // receives the KMC half of creator fees
  treasury?: PublicKey; // receives the deploy fee
  deployFeeLamports?: number;
  priorityMicroLamports?: number;
  lookupTable?: PublicKey; // KMC's address lookup table (keeps the launch tx under 1232 bytes)
  lookupTableAccount?: AddressLookupTableAccount; // or pass it pre-fetched
}

export interface LaunchBuild {
  /** Unsigned. Creator signs both in one wallet prompt; the mint keypair also signs launchTx.
   *  Send launchTx first, then lockTx. */
  launchTx: VersionedTransaction; // create + buy pool + move pool to escrow (atomic)
  lockTx: VersionedTransaction; // lock 50/50 creator-fee split + deploy fee
  instructions: TransactionInstruction[];
  groups: { compute: TransactionInstruction[]; createAndBuy: TransactionInstruction[]; toEscrow: TransactionInstruction[]; feeSplit: TransactionInstruction[]; deployFee: TransactionInstruction[] };
  poolTokens: bigint; // raw units that land in escrow
  maxSolCost: bigint; // lamports cap for the first buy (incl. pump fees)
  totalSolEstimate: number; // SOL: buy + deploy fee + rent/fees headroom
}

export async function buildPumpLaunch(p: LaunchParams): Promise<LaunchBuild> {
  if (!(p.poolPct >= MIN_POOL_PCT && p.poolPct <= MAX_POOL_PCT)) throw new Error(`mining pool must be ${MIN_POOL_PCT}–${MAX_POOL_PCT}%`);
  if (p.creator.equals(p.kmcFeeWallet)) throw new Error("creator can't be the KMC fee wallet");

  const sdk = new OnlinePumpSdk(p.conn);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  const supply = BigInt(global.tokenTotalSupply.toString());
  const poolTokens = (supply * BigInt(Math.round(p.poolPct * 100))) / 10_000n;
  const amount = new BN(poolTokens.toString());

  const solCost = getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount,
    quoteMint: NATIVE_MINT,
  });
  const maxSolCost = solCost.muln(1005).divn(1000); // 0.5% headroom; creator is first, so cost is exact

  const createAndBuy = await PUMP_SDK.createV2AndBuyInstructions({
    global,
    mint: p.mint,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    creator: p.creator,
    user: p.creator,
    amount,
    solAmount: maxSolCost,
    mayhemMode: false,
  });

  const creatorAta = getAssociatedTokenAddressSync(p.mint, p.creator, false, TOKEN_2022_PROGRAM_ID);
  const escrowAta = getAssociatedTokenAddressSync(p.mint, p.escrow, true, TOKEN_2022_PROGRAM_ID);
  const toEscrow = [
    createAssociatedTokenAccountIdempotentInstruction(p.creator, escrowAta, p.escrow, p.mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(creatorAta, p.mint, escrowAta, p.creator, poolTokens, TOKEN_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  ];

  const feeSplit = [
    // harmless when empty; required first if the buy left fees in the curve's bucket
    await PUMP_SDK.sweepCreatorFeeInstruction({ payer: p.creator, mint: p.mint, creator: p.creator, quoteMint: NATIVE_MINT }),
    await PUMP_SDK.createFeeSharingConfig({ creator: p.creator, mint: p.mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: p.creator,
      mint: p.mint,
      currentShareholders: [p.creator],
      newShareholders: [
        { address: p.creator, shareBps: CREATOR_SHARE_BPS },
        { address: p.kmcFeeWallet, shareBps: 10_000 - CREATOR_SHARE_BPS },
      ],
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    }),
  ];

  const deployFee =
    p.treasury && p.deployFeeLamports
      ? [SystemProgram.transfer({ fromPubkey: p.creator, toPubkey: p.treasury, lamports: p.deployFeeLamports })]
      : [];

  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports ?? 100_000 });
  const compute = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), price];
  const instructions = [
    ...compute,
    ...createAndBuy,
    ...toEscrow,
    ...feeSplit,
    ...deployFee,
  ];

  const table = p.lookupTable ? (await p.conn.getAddressLookupTable(p.lookupTable)).value : null;
  const tables = p.lookupTableAccount ? [p.lookupTableAccount] : table ? [table] : [];
  const { blockhash } = await p.conn.getLatestBlockhash("confirmed");
  const v0 = (ixs: TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: p.creator, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
  const launchTx = v0([...compute, ...createAndBuy, ...toEscrow]);
  const lockTx = v0([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), price, ...feeSplit, ...deployFee]);

  const totalSolEstimate = Number(maxSolCost.toString()) / 1e9 + (p.deployFeeLamports ?? 0) / 1e9 + 0.05;
  return { launchTx, lockTx, instructions, groups: { compute, createAndBuy, toEscrow, feeSplit, deployFee }, poolTokens, maxSolCost: BigInt(maxSolCost.toString()), totalSolEstimate };
}
