// Verifies a pump.fun coin's creator-fee split is locked: KMC wallet holds
// `bps` of the creator fee and the sharing-config admin is revoked.
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import type * as PumpSdkTypes from "@pump-fun/pump-sdk";

const pump = createRequire(import.meta.url)("@pump-fun/pump-sdk") as typeof PumpSdkTypes;

export async function checkFeeSplit(conn: Connection, mint: PublicKey, kmcFeeWallet: PublicKey, bps = 5_000) {
  const info = await conn.getAccountInfo(pump.feeSharingConfigPda(mint));
  if (!info) throw new Error("creator-fee split not set up yet (send the second launch transaction)");
  const sc = pump.PUMP_SDK.decodeSharingConfig(info) as unknown as {
    adminRevoked: boolean;
    shareholders: { address: PublicKey; shareBps: number }[];
  };
  const kmc = sc.shareholders.find((s) => s.address.equals(kmcFeeWallet));
  if (!kmc || kmc.shareBps !== bps) throw new Error(`creator-fee split must give the KMC wallet ${bps / 100}%`);
  if (!sc.adminRevoked) throw new Error("creator-fee split is not locked");
  return sc.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
}
