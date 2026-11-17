// The mining engine: turns KittyMine network blocks into per-token payouts.
//
// For every KittyMine block, every active token "drips" emission for the time
// since its last block (pool / period × Δt), then picks ONE winner:
//   • game-specific tokens: a deterministic draw among the producer's friends
//     who are in one of the token's games right now (from the presence snapshot)
//   • any-game tokens: KittyMine's own block winner (already verified in-game by
//     KittyMine's validators)
// Draw = sorted candidate IDs, index = sha256(blockHash + ":" + mint) mod n.
// Anyone with the same block + friend list + presence gets the same winner.
// If nobody is eligible, the drip stays in the pool (the pool simply lasts longer).
import crypto from "node:crypto";
import type { NetworkBlock } from "./kittymine.js";
import type { PresenceSnapshot } from "./presence.js";
import { sortIds } from "./presence.js";
import { add, type Draw, type State, type Token } from "./store.js";

export const MAX_DRIP_GAP_MS = 10 * 60_000; // relay downtime / quiet periods don't dump emission
export const FIRST_DRIP_MS = 60_000;
const MAX_DRAWS = 5_000;

export interface Snapshots {
  current: Partial<Record<"Steam" | "Xbox", PresenceSnapshot>>;
  previous: Partial<Record<"Steam" | "Xbox", PresenceSnapshot>>;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function pick(candidates: string[], blockHash: string, mint: string): string {
  const sorted = sortIds(candidates);
  const seed = BigInt("0x" + sha256(`${blockHash}:${mint}`));
  return sorted[Number(seed % BigInt(sorted.length))];
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function remaining(t: Token): bigint {
  return BigInt(t.pool) - BigInt(t.distributed);
}

/** Emission due for this block, and the new drip timestamp. */
export function drip(t: Token, at: number): bigint {
  if (t.perDraw) {
    const fixed = BigInt(t.perDraw);
    const left = remaining(t);
    return fixed > left ? left : fixed;
  }
  const from = t.lastDripAt ?? Math.max(t.createdAt, at - FIRST_DRIP_MS);
  const dt = Math.min(Math.max(at - from, 0), MAX_DRIP_GAP_MS);
  const due = (BigInt(t.pool) * BigInt(Math.floor(dt))) / BigInt(t.periodMs);
  const left = remaining(t);
  return due > left ? left : due;
}

function relevant(t: Token, b: NetworkBlock): boolean {
  if (b.source === "Steam") return t.games.any || t.games.steam.length > 0;
  if (b.source === "Xbox") return t.games.any || t.games.xbox.length > 0;
  return false; // Legacy (old Minecraft names) can't link a wallet
}

/** Steam: exact appid. Xbox: titleIds differ per console, so games are lowercase name fragments ("grand theft auto v"). */
export function playsOneOf(src: "Steam" | "Xbox", gameId: string, games: string[]): boolean {
  if (src === "Steam") return games.includes(gameId);
  const g = gameId.toLowerCase();
  return games.some((f) => f && g.includes(f.toLowerCase()));
}

export function candidatesFor(t: Token, b: NetworkBlock, snaps: Snapshots, state: State): string[] {
  const src = b.source as "Steam" | "Xbox";
  const day = utcDay(b.timestamp);
  const capOk = (id: string) =>
    !t.rules.maxWinsPerDay || (state.wins[`${t.mint}:${id}:${day}`] ?? 0) < t.rules.maxWinsPerDay;

  const games = src === "Steam" ? t.games.steam : t.games.xbox;
  if (games.length === 0) {
    // any-game token: follow KittyMine's verified winner
    return t.games.any && capOk(b.winner) ? [b.winner] : [];
  }

  const snap = snaps.current[src];
  if (!snap || (b.producer && snap.producer !== b.producer)) return [];
  const prev = snaps.previous[src];
  const inGame = (s: PresenceSnapshot | undefined) =>
    new Set((s?.players ?? []).filter((p) => p.gameId && playsOneOf(src, p.gameId, games)).map((p) => p.id));
  const now = inGame(snap);
  const before = t.rules.requireTwoSamples ? inGame(prev) : now;
  const friends = new Set(snap.friends);
  const minAge = t.rules.minAccountAgeDays * 86_400_000;

  return snap.players
    .filter((p) => friends.has(p.id) && now.has(p.id) && before.has(p.id))
    // account age: Steam shares it (hidden = not eligible); Xbox never does, so the rule can't apply there
    .filter((p) => !minAge || src === "Xbox" || (p.createdAt !== undefined && b.timestamp - p.createdAt >= minAge))
    .map((p) => p.id)
    .filter(capOk);
}

/** Apply one KittyMine block to every active token. Returns the draws made. */
export function processBlock(state: State, b: NetworkBlock, snaps: Snapshots): Draw[] {
  const made: Draw[] = [];
  for (const t of Object.values(state.tokens)) {
    if (b.timestamp < t.createdAt || remaining(t) <= 0n || !relevant(t, b)) continue;
    const amount = drip(t, b.timestamp);
    t.lastDripAt = b.timestamp;
    if (amount <= 0n) continue;
    const cands = candidatesFor(t, b, snaps, state);
    if (cands.length === 0) continue; // stays in the pool
    const winner = pick(cands, b.hash, t.mint);
    t.distributed = add(t.distributed, amount);
    (state.earned[t.mint] ??= {})[winner] = add(state.earned[t.mint][winner], amount);
    const wk = `${t.mint}:${winner}:${utcDay(b.timestamp)}`;
    state.wins[wk] = (state.wins[wk] ?? 0) + 1;
    made.push({
      height: b.height,
      mint: t.mint,
      source: b.source,
      winner,
      amount: amount.toString(),
      candidates: cands.length,
      candidatesHash: sha256(sortIds(cands).join(",")),
      at: b.timestamp,
    });
  }
  state.draws.unshift(...made.reverse());
  if (state.draws.length > MAX_DRAWS) state.draws.length = MAX_DRAWS;
  return made;
}

/** Drop win counters older than 2 days. */
export function pruneWins(state: State, now = Date.now()) {
  const keep = new Set([utcDay(now), utcDay(now - 86_400_000)]);
  for (const k of Object.keys(state.wins)) if (!keep.has(k.slice(-10))) delete state.wins[k];
}

/** Unclaimed balance per gaming ID linked to `wallet` (claims are tracked per gaming ID,
 *  so relinking an ID to another wallet can never double-pay). */
export function claimableById(state: State, wallet: string, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [id, w] of Object.entries(state.links)) {
    if (w !== wallet) continue;
    const left = BigInt(state.earned[mint]?.[id] ?? "0") - BigInt(state.claimed[mint]?.[id] ?? "0");
    if (left > 0n) out.set(id, left);
  }
  return out;
}

export function claimable(state: State, wallet: string, mint: string): bigint {
  let sum = 0n;
  for (const v of claimableById(state, wallet, mint).values()) sum += v;
  return sum;
}
