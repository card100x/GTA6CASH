# KMC / KittyMine: project analysis (2026-11-16)

Sources: Discord and Telegram logs the user pasted, plus thekittymine.com (/, /protocol, /explorer, /transactions, /player-api), plus DexScreener.

## 1. What it is, in one paragraph
KittyMine ("The Kitty" on Discord, "F M" on Telegram, X @TheKittyMine) runs **KMCoin**, a custom layer-1 ledger that is not built on any existing chain. In this ledger, "mining" means **being visibly in-game on a public gaming API** (Steam, Xbox) while friended to a block-producer account. Separately, **$KMC** is a pump.fun SPL token on Solana. KMCoin balances can be **bridged** (burned on the L1) into $KMC claims on Solana. The pitch is "proof-of-game": rewards and transactions get verified only from public API data, so nobody's gaming-account password is ever needed.

## 2. Two assets
| | KMCoin (L1) | $KMC (Solana) |
|---|---|---|
| What | Custom ledger, numeric wallets (e.g. 529834) | pump.fun SPL token |
| CA / ID | wallet = network block height where your ID first mined | `41fZewbrb8x24yE9KeMJExoVXCDggebPMEwRVvX8pump` |
| Units | 1 KMCoin = 1e14 raw = one block reward | standard SPL |
| Link | bridge burns 10–67 KMCoin (+69 raw gas) | 64 KMC per KMCoin, so 640–4,288 KMC per claim |
| Market | none | Raydium pair `CNzRoUAsWMYaKCL3kcGAgCJbGaKxUw7j5DzWWtgmExMV`, created 2025-02-16 |

$KMC on 2026-11-16: price ≈ $0.0000287, **market cap ≈ $28.6k**, liquidity ≈ $17.9k, 24h volume ≈ $1.2k (1 buy and 3 sells). Effectively dormant.

## 3. How a block works
1. A **producer** holds a source account (Steam `KittyMineCoin`, Xbox `TheKittyMine`). Its **friend list** is the miner set.
2. Block body = source ID + local seq + timestamp + **hash of the sorted friend list** + selected winner + 64-hex proof + `=` ledger hash.
   Example: `498700.<steam ts>.<friendlist-hash digits>....76561199003182465 <proof> =<ledger hash>`
3. Winner: a deterministic shuffle or walk of the friend list, taking the first friend who is **currently in-game**.
4. **Phase I**: `auditHash = SHA256(prevBodyNorm + propBodyNorm)` with a leading-hex difficulty that depends on validator count (1 validator means the test is bypassed). Then a ~149 s maturity queue.
5. Validators re-query the same public API: friend-list hash matches, winner is in-game, txs are valid.
6. **Phase II**: majority plus maturity again, then finalize (apply reward and txs, update the ledger hash). One tx per wallet per block.

Throughput seen: block 529,834 (Nov 3) → 536,320 (Nov 8) is about 1,300 blocks/day, roughly one every 66 s.

## 4. Transactions
Format: `wallet*amount_receiver,gas$txHash~metadata%newPublicKey;` (exact bytes, including the `;`).
The wallet secret stays local (desktop Java player or web console). The player then *publishes* the tx somewhere that only they control:
- **Xbox**: the full tx goes in the Bio (500 chars max). Producers scan 20 friends' Bios per minute.
- **Steam**: the native route only covers first key setup (63-hex pubkey prefix in the "real name" field) and an inferred whole-block bridge. Full txs go through the Xbox Bio, with SHA-256 of the tx (first 63 hex) placed in the Steam real name.
- **Minecraft (legacy)**: the tx is encoded into the right leg of the Java skin (`minecraft_skin_tx.py`) and also put in the Xbox Bio. The UUID comes from the wallet's first block.
- Key renewal is forced at counter 999, 1999, and so on (hash-chain style keys).

Public read API: `GET /api/player-state?wallet=…&player=…` (20 per request, ≥60 s poll, ETag). Read-only.

## 5. Timeline
- **2025-02**: $KMC launched on pump.fun. Mining originally happened on a trusted Minecraft server (plus an Unturned server).
- **2026-08**: Steam added as the "first auditable proof-of-game layer". Website overhaul, disclosures, and dev wallets published.
- **2026-09**: Steam tx verification (real-name field). GitHub scrubbed; open source "soon".
- **2026-10**: Deterministic Steam validator update. Xbox work starts.
- **2026-11-03 → 11-10**: Xbox live. Minecraft server mining retired. Bio-based txs, player tool, X post and walkthrough.
- **Next (dev's words)**: an immutable "smart contract" layer that works with KMCoin like KMC does, i.e. **other tokens on the network**. Also "minimum majority" APIs (Blizzard/Riot/Activision), Roblox, and a reverse bridge (KMC → L1).

## 6. Honest assessment
**What's real and clever**
- Using public profile fields (Bio, Steam real name, Minecraft skin) as a **signed-message channel** is a neat way to authenticate without OAuth or passwords.
- Friend-list hashing makes a block's miner set reproducible from public data **at query time**.
- The dev has shipped steadily for about 2 years and is unusually candid in the disclosures (rolled "whitepaper" back to "working protocol", rollback risks stated).

**What's weak (and matters for anything we build on top)**
- **Centralized in practice.** Producers are the dev's accounts and validators are the dev's nodes (the explorer shows a single oracle). The dev decides who gets friended (Xbox requests are manually accepted). The Xbox adapter uses the dev's Microsoft token.
- **Not re-verifiable later.** Friend lists and presence are *live* API state. Their own protocol page admits that "External APIs are not an immutable historical record". A block from last week can't be independently re-checked today.
- **Sybil and AFK.** Presence ≠ play ≠ unique human. Anyone can idle many free Steam/Xbox accounts in a free game. The only real limit is the dev's friend acceptance.
- **The bridge is custodial.** Burning on the L1 leads to a claim that is paid in $KMC from a dev-controlled pool on Solana. There is no on-chain proof of the L1 burn.
- **Rewards are worth almost nothing right now.** 1 block = 64 KMC ≈ **$0.0018**. About 1,300 blocks/day means the whole network emits ≈ **$2.40/day** at today's price (≈83k KMC/day, if all of it were bridged). There's no real earning incentive at a $28k market cap.
- **UX friction is huge.** !Check, a dedicated user, spent a week trying to get one XUID to show up. Non-default launchers aren't detected, privacy toggles are confusing, and skin swapping is needed for Minecraft txs.

## 7. The opportunity (card's proposal, which the dev is open to)
A **game-mined token launchpad** on top of KittyMine:
- A deployer launches a token (pump.fun integration preferred) and picks which games mine it.
- The deployer buys or funds **10–15% of supply into a mining pool** that is paid out to KittyMine winners playing those games, plus a deployer fee to the KittyMine treasury.
- Trading fees (min 1%) split **50% to creator, holders or a chosen recipient** and **50% to the KMC team (buyback of $KMC or treasury)**.
- Targets mentioned: memecoins tied to games (DacityCoin ~$15M MC, Macca ~$2M, Fortnite "Pirate Shop Token" ~$400k MC). GTA6 on Xbox/PS is the narrative.
- Dev quote: "very doable and in line with the coming smart contract upgrade... adding other blockchains/tokens is easy".

Why it works: it gives $KMC **revenue and buy pressure** that doesn't depend on KMCoin's own emission value. Projects that already have communities supply the mining rewards.

### Design questions to settle before building
1. **Where does the per-token mining pool live?** The simplest and most honest option is a Solana program/escrow holding the 10–15%, released against KittyMine winner attestations signed by the oracle. That makes the trust explicit, since it's the same trust the KMC bridge already has.
2. **Game selection.** Steam and Xbox presence return the game/title ID, so a block winner can be filtered by `titleId ∈ token.games`. This needs a dev-side change (per-token winner selection, or a separate draw per token).
3. **Fee mechanics.** pump.fun creator fees (and the post-migration PumpSwap creator fee) can route to a fee-splitter. Alternatively, Meteora DBC or Raydium LaunchLab give configurable fees. We've already built LaunchLab/DBC overlays (Lilypad, boop.llc, ongram).
4. **Anti-sybil** for a pool with real money in it: minimum account age or gamerscore, one wallet per XUID, and per-wallet caps per epoch.
5. **Claim UX**: link a Solana wallet to the XUID/SteamID once (via a Bio proof, like their pubkey setup), then auto-airdrop or claim from the escrow.

## 8. Unknowns to ask the dev
- $KMC supply split. Which wallet funds bridge payouts, and how big is that pool?
- Is the oracle or player-state API the canonical feed for integrations? Does it expose winning game/title IDs per block?
- Timeline and spec for the "smart contract upgrade". Will he open-source the validator?
- Whether he wants us to build the launchpad front-end and Solana side while he exposes a winner-attestation endpoint.
