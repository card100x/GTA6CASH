// Register a new play-to-earn coin with the running relay.
// 1. Send the pool tokens to the escrow wallet (shown at the top of `npm start`).
// 2. Run, e.g.:
//    npx tsx scripts/add-token.ts --mint <CA> --name "GTA Six" --symbol GTASIX --pool 50000000 --days 30
// Defaults: GTA V on Steam (Enhanced + Legacy) and Xbox (also matches GTA VI), NO cap on wins per day,
// anti-bot checks on (seen in-game twice in a row; Steam account 30+ days old). --no-rules turns those off too.
// Talks to the live relay on Fly by default (--url to override, e.g. http://localhost:8787).
// Then set SITE_MINT=<CA> in .env (or leave it: the site shows the newest coin).
import "dotenv/config";

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const body = {
  mint: arg("mint"),
  name: arg("name"),
  symbol: arg("symbol"),
  image: arg("image"),
  pool: Number(arg("pool")),
  periodDays: Number(arg("days", "30")),
  perDraw: arg("per-draw") ? Number(arg("per-draw")) : undefined, // fixed tokens per draw; no period
  steam: (arg("steam", "3240220,271590") ?? "").split(",").filter(Boolean),
  xbox: (arg("xbox", "grand theft auto v") ?? "").split(",").filter(Boolean),
  rules: args.includes("--no-rules") ? { minAccountAgeDays: 0, maxWinsPerDay: 0, requireTwoSamples: false } : { maxWinsPerDay: 0 }, // no earnings cap
};
if (!body.mint || !body.name || !body.symbol || !(body.pool > 0)) {
  console.error('usage: npx tsx scripts/add-token.ts --mint <CA> --name "<name>" --symbol <TICKER> --pool <tokens> [--days 30] [--steam ids] [--xbox names] [--image url] [--no-rules]');
  process.exit(1);
}
const base = arg("url", "https://gtasix-relay.fly.dev");
const r = await fetch(`${base}/api/admin/token`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-token": process.env.ADMIN_TOKEN ?? "" },
  body: JSON.stringify(body),
});
const j = await r.json();
if (!r.ok) {
  console.error("failed:", j.error ?? j);
  process.exit(1);
}
console.log(`registered ${j.symbol} (${j.mint}): pool ${Number(j.pool) / 1e6} over ${Math.round(j.periodMs / 86400000)} days`);
