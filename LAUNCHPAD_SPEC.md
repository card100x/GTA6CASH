# KMC Launchpad: play-to-mine tokens on KittyMine (draft v0.1, 2026-11-16)

## One line
Anyone can launch a token where part of the supply can only be **earned by playing chosen games** through the KittyMine proof-of-game network. Half of all trading fees **buy $KMC**.

## Why
- Game memecoins already have communities but give holders nothing to do. DacityCoin is around $15M, Macca around $2M and Fortnite's Pirate Shop Token around $400k, all pure speculation.
- KittyMine has the verification part (public Steam/Xbox data, no passwords) but no economy. Block rewards are worth about $0.002 each.
- Combined: projects bring the rewards and the hype, KittyMine brings the mining, and $KMC gets real revenue. Example: one token doing $500k/day of volume at a 1% fee makes $5k/day, so $2.5k/day goes into $KMC buybacks. That's against a current $KMC market cap of about $28k.

## How it works

### 1. Launch
The deployer fills in:
- Name, ticker and image, as on any launchpad
- **Games** that mine it: Steam app IDs and/or Xbox title IDs (e.g. GTA, Fortnite, Minecraft), or "any game"
- **Mining pool size**: 10–15% of supply (minimum 10%)
- **Emission period**: e.g. 30, 90 or 180 days
- **Fee recipient** for the creator half: creator wallet, holders (via buyback & burn), or any wallet
- A **deploy fee** (e.g. 0.5 SOL) goes to the KittyMine treasury

In the launch transaction, the deployer's initial buy of 10–15% of supply goes **straight into a per-token escrow** owned by the program. The deployer never holds those tokens.

### 2. Trading fees
- At least 1% fee on every trade.
- **50%** goes to the creator's chosen recipient and **50%** to the KMC side (automatic $KMC buyback, or the treasury, as the dev chooses).
- The fee applies on the bonding curve and keeps applying after migration.

### 3. Mining
- Players friend the KittyMine producer accounts, exactly as they do today, and play.
- Every KittyMine network block, **each token runs its own draw** among friends who are currently in one of *that token's* games. The draw is seeded by the network block hash, so anyone can reproduce it.
- Winners are credited `pool / number of blocks in the emission period` of that token.
- The method is the same as KittyMine's: the friend list is hashed, presence is checked against the public API, and the selection is deterministic. Anyone can audit it.

### 4. Linking a Solana wallet
- One-time proof using KittyMine's own trick: put a short code derived from your Solana address in your Xbox bio or Steam real-name field. The relay sees it and links that ID to that wallet.
- One wallet per gaming ID and one gaming ID per wallet.

### 5. Claiming
- Earnings accrue continuously. Once a day a **Merkle root of all balances is posted on-chain**, and players claim from the escrow with their proof.
- Unclaimed tokens stay claimable, and anything undistributed at the end of the period stays in escrow for later.

### 6. Anti-farming (real money is in the pool, so this matters)
- Minimum account quality: Steam level/account age, Xbox gamerscore. The deployer picks a preset.
- Presence must be seen in **2 consecutive samples** (no quick join-and-leave).
- Per-ID daily cap per token.
- The deployer can restrict mining to paid games, so free-to-play idling doesn't count.

## Build plan
**v1 (we build it, no protocol change needed from KittyMine)**
- Launch and fees: a configurable bonding curve (Meteora DBC or Raydium LaunchLab) gives the 1% fee and the 50/50 split, with fees continuing after migration. We've shipped launchpads on both before.
  - pump.fun fees are fixed and can't be set to 1%. A pump.fun route (dev-buy into escrow plus routing pump's creator fee into a 50/50 splitter) can be an extra option with lower fees but pump.fun's attention.
- Escrow plus a Merkle claim program on Solana.
- A mining relay that reads the public KittyMine producer friend lists, polls presence (game IDs), runs per-token draws seeded by KittyMine block hashes, and publishes the daily roots and a public audit log.
- Site: launch page, token pages with each pool's live emission, a player page (link wallet, claim), and a leaderboard.

**v2 (with the KittyMine dev)**
- The KittyMine validator exposes signed per-block data: height, block hash, eligible in-game set with game IDs. The relay then just verifies his feed.
- The mining pools and fee split move onto KittyMine's upcoming immutable smart-contract layer.

## What we need from the KittyMine dev
1. Approval, plus a choice of branding (KittyMine-branded or an independent partner).
2. The treasury / $KMC buyback wallet that receives the 50%.
3. Access to finalized block hashes per height (already in the explorer feed?) and ideally the in-game set with game IDs per block.
4. For Xbox: the relay needs its own Xbox Live token to read friend presence. It would be cleaner if his validator published presence snapshots.

## Open decisions
- Fee split between buyback and treasury inside the KMC 50%
- Size of the deploy fee
- Default emission period
- Whether KittyMine block winners also get a small bonus in every pool
