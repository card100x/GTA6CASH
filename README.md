# KMC Launchpad

Launch a pump.fun coin that gamers mine by playing, verified by KittyMine proof-of-game.

## What's here
- `relay/`: the one server. It reads KittyMine blocks, runs a draw per coin, tracks earnings, links wallets, pays claims, builds launch transactions, and serves the website.
- `web/`: the website (Coins, Launch, Mine, Coin pages). No build step; the relay serves it.
- `ANALYSIS.md`: what KittyMine is. `LAUNCHPAD_SPEC.md`: the original idea (written for LaunchLab; fees now work through pump.fun fee sharing).

## Run it locally
```
cd relay
npm install
npm start          # http://localhost:8787
npm test           # engine tests
npm run dry        # watch-only: replays live KittyMine blocks with 2 demo coins
```
Settings live in `relay/.env` (see `.env.example`).

## How a launch works
Two transactions, approved in one wallet popup:
1. **Launch**: create the coin on pump.fun, buy 10–15% of supply, move it into the mining escrow (all at once).
2. **Lock**: set pump.fun's creator-fee sharing to 50% creator / 50% KMC and revoke the admin (permanent), then pay the deploy fee.

The relay only starts mining a coin after checking both on-chain.

## Tested
- Engine: 7 unit tests, plus a dry run on the live KittyMine feed.
- Launch: simulated against real mainnet pump.fun (`npx tsx scripts/sim-pump-launch.ts`). The escrow got exactly 10%. The fee split locked at 50/50 with the admin revoked.

## Before going live
1. **Steam API key** (free, steamcommunity.com/dev/apikey) → `STEAM_API_KEY`. Needed for game-specific coins and wallet linking.
2. **KMC fee wallet**: the wallet that gets the $KMC half (the dev's buyback wallet, or ours) → `KMC_FEE_WALLET`. Right now it's a generated test wallet.
3. **Lookup table**: fund `keys/admin-mainnet.json` with ~0.01 SOL, then
   `npx tsx scripts/lookup-table.ts <escrow> <KMC_FEE_WALLET> --send` → set `KMC_LOOKUP_TABLE`.
4. Fund the escrow with ~0.05 SOL for claim fees.
5. Host the relay (e.g. Fly.io with a volume for `data/`), then do one small real launch end-to-end.

## Trust model (v1)
Mining pools sit in one relay-held escrow wallet, the same trust as the KMC bridge today. Every draw is public at `/api/draws` and reproducible from KittyMine block hashes and Steam presence. v2 moves pools into an on-chain claim program.
