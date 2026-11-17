// Shared helpers for admin scripts.
import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { CLUSTER, loadKeypair, rpcUrl } from "./solana.js";

export { CLUSTER };
export const connection = new Connection(rpcUrl(), "confirmed");
export const loadAdmin = () => loadKeypair(`keys/admin-${CLUSTER}.json`);
export const explorerTx = (sig: string) => `https://solscan.io/tx/${sig}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;
