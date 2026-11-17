// Entry point. `npm start` runs the relay; `npm run dry` runs it without an
// escrow or API (watch-only: logs draws against the live KittyMine feed).
import "dotenv/config";
import { Relay } from "./relay.js";
import { SteamPresence, XboxPresence } from "./presence.js";
import { startServer } from "./server.js";
import { CLUSTER, Escrow, loadKeypair } from "./solana.js";
import { Store } from "./store.js";
import { SwapDesk, swapConfigFromEnv } from "./swap.js";
import { Accounts } from "./accounts.js";
import { XboxLivePresence } from "./xbox.js";
import { TradeDesk, tradeConfigFromEnv } from "./trades.js";

const dry = process.argv.includes("--dry");
const POLL_MS = Number(process.env.POLL_SECONDS ?? 30) * 1000;

const store = new Store(dry ? null : (process.env.STATE_FILE ?? "data/state.json"));
const escrow = dry ? null : new Escrow(loadKeypair(process.env.ESCROW_KEY ?? `keys/escrow-${CLUSTER}.json`));
const steam = new SteamPresence();
const xboxLive = new XboxLivePresence();
const xbox = xboxLive.enabled ? xboxLive : new XboxPresence();
const relay = new Relay(store, [steam, xbox], escrow);

if (escrow && steam.enabled) relay.accounts = new Accounts(relay, steam, xbox.enabled ? xboxLive : null, process.env.DATA_DIR ?? "data", process.env.WALLETS_KEY_FILE ?? `keys/wallets-${CLUSTER}.key`);

const tradeCfg = tradeConfigFromEnv();
if (escrow && tradeCfg) {
  relay.trades = new TradeDesk(tradeCfg, escrow, store);
  console.log(`KMCoin trades: send to KittyMine wallet ${tradeCfg.wallet} -> ${tradeCfg.rate} ${tradeCfg.symbol} per KMCoin`);
}

const swapCfg = swapConfigFromEnv();
if (escrow && swapCfg) {
  relay.swap = new SwapDesk(swapCfg, escrow, store);
  console.log(`swap desk: 1 ${swapCfg.inSymbol} -> ${swapCfg.rate} ${swapCfg.outSymbol}`);
}

console.log(`KMC relay | cluster ${CLUSTER} | escrow ${escrow?.address.toBase58() ?? "(dry run)"}`);
console.log(`Steam presence: ${steam.enabled ? "on" : "off (set STEAM_API_KEY)"} | Xbox presence: ${xbox.enabled ? "on" : "off (run scripts/xbox-login.ts)"}`);
if (!dry) startServer(relay, Number(process.env.PORT ?? 8787), process.env.ADMIN_TOKEN);

if (dry) {
  // watch-only demo: two fake tokens so draws show up against the live feed
  const base = { creator: "demo", launchSig: "demo", createdAt: 0, pool: "100000000000000", periodMs: 30 * 86_400_000, distributed: "0", lastDripAt: null, rules: { minAccountAgeDays: 0, maxWinsPerDay: 0, requireTwoSamples: false } };
  store.state.tokens.DEMOANY = { ...base, mint: "DEMOANY", name: "Any game demo", symbol: "ANY", games: { any: true, steam: [], xbox: [] } };
  // 0.1% pool (1M tokens) GTA V test coin: Enhanced + Legacy
  store.state.tokens.DEMOGTA = { ...base, pool: "1000000000000", mint: "DEMOGTA", name: "GTA V test", symbol: "GTA", games: { any: false, steam: ["3240220", "271590"], xbox: [] } };
  store.state.tokens.DEMORUST = { ...base, mint: "DEMORUST", name: "Rust demo", symbol: "RUST", games: { any: false, steam: ["252490"], xbox: [] } };
  store.state.tokens.DEMOCS2 = { ...base, mint: "DEMOCS2", name: "CS2 demo", symbol: "CS2", games: { any: false, steam: ["730"], xbox: [] } };
  if (process.env.DRY_FROM) store.state.cursor = Number(process.env.DRY_FROM);
}

const loop = async () => {
  await relay.tick().catch((e) => console.error("tick failed:", e));
  setTimeout(loop, POLL_MS);
};
loop();
