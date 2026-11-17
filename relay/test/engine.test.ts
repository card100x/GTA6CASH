import { test } from "node:test";
import assert from "node:assert/strict";
import { processBlock, pick, claimable, drip, type Snapshots } from "../src/engine.js";
import { emptyState, type Token } from "../src/store.js";
import { completeLinks, linkCode, startLink } from "../src/link.js";
import type { NetworkBlock } from "../src/kittymine.js";
import type { PresenceSnapshot } from "../src/presence.js";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const tok = (mint: string, games: Token["games"], over: Partial<Token> = {}): Token => ({
  mint, name: mint, symbol: mint, creator: "c", launchSig: "s", createdAt: T0, games,
  rules: { minAccountAgeDays: 0, maxWinsPerDay: 0, requireTwoSamples: false },
  pool: (1_000_000n * 10n ** 6n).toString(), periodMs: 10 * DAY, distributed: "0", lastDripAt: null, ...over,
});
const blk = (height: number, source: string, winner: string, at: number): NetworkBlock => ({
  height, hash: (height.toString(16) + "ab").padStart(64, "0"), winner, producer: source === "Steam" ? "P" : "X", source, timestamp: at,
});
const snap = (players: [string, string | null][], createdAt = T0 - 400 * DAY): PresenceSnapshot => ({
  source: "Steam", producer: "P", takenAt: T0, friends: players.map((p) => p[0]),
  players: players.map(([id, gameId]) => ({ id, gameId, createdAt })),
});

test("pick is deterministic and order-independent", () => {
  const a = pick(["3", "1", "2"], "ff".repeat(32), "M");
  assert.equal(a, pick(["2", "3", "1"], "ff".repeat(32), "M"));
});

test("any-game token pays KittyMine's winner; emission is time-based", () => {
  const s = emptyState();
  s.tokens.A = tok("A", { any: true, steam: [], xbox: [] });
  processBlock(s, blk(1, "Steam", "W1", T0 + 60_000), { current: {}, previous: {} });
  processBlock(s, blk(2, "Xbox", "W2", T0 + 120_000), { current: {}, previous: {} });
  // pool 1e12 over 10 days -> per minute = 1e12 * 60000 / 864e6 = 69444444
  assert.equal(s.earned.A.W1, "69444444");
  assert.equal(s.earned.A.W2, "69444444");
  assert.equal(s.draws.length, 2);
});

test("legacy blocks are ignored", () => {
  const s = emptyState();
  s.tokens.A = tok("A", { any: true, steam: [], xbox: [] });
  assert.equal(processBlock(s, blk(1, "Legacy", "mcname", T0 + 60_000), { current: {}, previous: {} }).length, 0);
});

test("game token draws only among friends in its game; nobody eligible = stays in pool", () => {
  const s = emptyState();
  s.tokens.G = tok("G", { any: false, steam: ["730"], xbox: [] });
  const snaps: Snapshots = { current: { Steam: snap([["a", "730"], ["b", "570"], ["c", null]]) }, previous: {} };
  const d = processBlock(s, blk(1, "Steam", "b", T0 + 60_000), snaps);
  assert.equal(d[0].winner, "a");
  assert.equal(d[0].candidates, 1);
  const none: Snapshots = { current: { Steam: snap([["b", "570"]]) }, previous: {} };
  assert.equal(processBlock(s, blk(2, "Steam", "b", T0 + 120_000), none).length, 0);
  assert.equal(s.tokens.G.distributed, "69444444"); // second drip not distributed
  assert.equal(processBlock(s, blk(3, "Xbox", "x", T0 + 180_000), snaps).length, 0); // steam-only token
});

test("anti-farming: two samples, account age, daily cap", () => {
  const s = emptyState();
  s.tokens.G = tok("G", { any: false, steam: ["730"], xbox: [] }, { rules: { minAccountAgeDays: 30, maxWinsPerDay: 1, requireTwoSamples: true } });
  const cur = snap([["a", "730"], ["b", "730"]]);
  cur.players[1].createdAt = T0; // brand-new account
  // a was not in-game in previous sample -> no one eligible
  assert.equal(processBlock(s, blk(1, "Steam", "z", T0 + 60_000), { current: { Steam: cur }, previous: { Steam: snap([]) } }).length, 0);
  const snaps = { current: { Steam: cur }, previous: { Steam: snap([["a", "730"], ["b", "730"]]) } };
  assert.equal(processBlock(s, blk(2, "Steam", "z", T0 + 120_000), snaps)[0].winner, "a");
  assert.equal(processBlock(s, blk(3, "Steam", "z", T0 + 180_000), snaps).length, 0); // a capped, b too new
});

test("drip caps gaps and never exceeds pool", () => {
  const t = tok("A", { any: true, steam: [], xbox: [] }, { lastDripAt: T0 });
  assert.equal(drip(t, T0 + 5 * DAY), (BigInt(t.pool) * 600_000n) / BigInt(t.periodMs));
  t.distributed = (BigInt(t.pool) - 5n).toString();
  assert.equal(drip(t, T0 + 60_000), 5n);
});

test("linking via Steam real name + claims tracked per gaming id", () => {
  const s = emptyState();
  const code = startLink(s, "76561190000000001", "WALLET1", T0);
  assert.equal(code, linkCode("76561190000000001", "WALLET1"));
  assert.deepEqual(completeLinks(s, [{ id: "76561190000000001", gameId: null, realName: `gamer ${code}` }], T0 + 1000), ["76561190000000001"]);
  s.earned.M = { "76561190000000001": "500" };
  s.tokens.M = tok("M", { any: true, steam: [], xbox: [] });
  assert.equal(claimable(s, "WALLET1", "M"), 500n);
  s.claimed.M = { "76561190000000001": "500" };
  s.links["76561190000000001"] = "WALLET2"; // relink can't double-claim
  assert.equal(claimable(s, "WALLET2", "M"), 0n);
});
