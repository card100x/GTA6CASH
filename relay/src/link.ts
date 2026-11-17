// Wallet linking: prove you own a Steam/Xbox account by putting a short code
// (bound to your Solana wallet) in your profile. Same trick KittyMine uses for
// KMCoin keys: no passwords, no OAuth.
//   Steam: "Real name" field contains the code
//   Xbox:  Bio contains the code (needs Xbox presence, not built yet)
import { sha256 } from "./engine.js";
import type { PlayerPresence } from "./presence.js";
import type { State } from "./store.js";

export const LINK_TTL_MS = 24 * 3_600_000;

export function linkCode(gamingId: string, wallet: string): string {
  return "kmc-" + sha256(`link:${gamingId}:${wallet}`).slice(0, 8);
}

export function isSteamId(id: string) {
  return /^7656\d{13}$/.test(id);
}
export function isXuid(id: string) {
  return /^2535\d{12}$/.test(id);
}

export function startLink(state: State, gamingId: string, wallet: string, now = Date.now()) {
  const code = linkCode(gamingId, wallet);
  state.pendingLinks[gamingId] = { wallet, code, at: now };
  return code;
}

/** Complete any pending links whose code now shows up in the player's profile. */
export function completeLinks(state: State, players: PlayerPresence[], now = Date.now()): string[] {
  const done: string[] = [];
  for (const p of players) {
    const req = state.pendingLinks[p.id];
    if (!req) continue;
    if (now - req.at > LINK_TTL_MS) {
      delete state.pendingLinks[p.id];
      continue;
    }
    if ((p.realName ?? "").toLowerCase().includes(req.code)) {
      state.links[p.id] = req.wallet;
      delete state.pendingLinks[p.id];
      done.push(p.id);
    }
  }
  return done;
}
