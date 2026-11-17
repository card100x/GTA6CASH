// Sanity check: does findTransfers read KittyMine's transfer format?
import { findTransfers } from "../src/trades.js";
const block = "548900.17948.123.76561198779127606.76561198641908636 76561198641908636 abc =def "
  + "529834*300000000000000_548645,1$0f2a9c3b7d1e4f6a8b9c0d1e2f3a4b5c6d7e8f90~null%null; "      // 3 KMCoin to us
  + "529834*1000000000000000_21000001,69$aa11bb22cc33dd44ee55ff6677889900~KMC%null; "           // a bridge: ignore
  + "548645*100000000000000_529834,1$1234567890abcdef1234~null%null;";                        // we sent: ignore
const t = findTransfers(block, "548645");
console.log(JSON.stringify(t, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
if (t.length !== 1 || t[0].from !== "529834" || t[0].amount !== 300000000000000n) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
