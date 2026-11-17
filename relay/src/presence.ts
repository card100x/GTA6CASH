// Who is in-game right now among a producer account's friends.
// Steam: public Web API (needs a free STEAM_API_KEY). Xbox: needs a signed-in
// Xbox Live token, not built yet; tokens fall back to KittyMine's own winner.

export interface PlayerPresence {
  id: string; // SteamID64 / XUID
  gameId: string | null; // Steam appid / Xbox titleId, null = not in a game
  gameName?: string;
  realName?: string; // Steam "real name" field; used for wallet-link proofs
  createdAt?: number; // account creation (ms), when public
}

export interface PresenceSnapshot {
  source: "Steam" | "Xbox";
  producer: string;
  takenAt: number;
  friends: string[]; // full friend list (sorted)
  players: PlayerPresence[]; // presence for every friend we could read
}

export interface PresenceProvider {
  source: "Steam" | "Xbox";
  enabled: boolean;
  snapshot(producer: string): Promise<PresenceSnapshot>;
  /** One-off lookup (for wallet linking when the player is not a friend yet). */
  lookup(ids: string[]): Promise<PlayerPresence[]>;
}

export function sortIds(ids: string[]): string[] {
  // numeric IDs compared as numbers (length first), names lexicographically
  return [...new Set(ids)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

const STEAM = "https://api.steampowered.com";

export class SteamPresence implements PresenceProvider {
  source = "Steam" as const;
  constructor(private key = process.env.STEAM_API_KEY?.trim() ?? "") {}
  get enabled() {
    return this.key.length > 0;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const q = new URLSearchParams({ key: this.key, format: "json", ...params });
    const res = await fetch(`${STEAM}${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) throw new Error("Steam: friend list is private (401)");
    if (res.status === 403) throw new Error("Steam: API key rejected (403)");
    if (!res.ok) throw new Error(`Steam ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async friends(steamId: string): Promise<string[]> {
    const r = await this.get<{ friendslist?: { friends: { steamid: string }[] } }>("/ISteamUser/GetFriendList/v1/", {
      steamid: steamId,
      relationship: "friend",
    });
    return sortIds((r.friendslist?.friends ?? []).map((f) => f.steamid));
  }

  async lookup(ids: string[]): Promise<PlayerPresence[]> {
    const out: PlayerPresence[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const r = await this.get<{
        response: {
          players: { steamid: string; gameid?: string; gameextrainfo?: string; realname?: string; timecreated?: number }[];
        };
      }>("/ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.slice(i, i + 100).join(",") });
      for (const p of r.response.players) {
        out.push({
          id: p.steamid,
          gameId: p.gameid ?? null,
          gameName: p.gameextrainfo,
          realName: p.realname,
          createdAt: p.timecreated ? p.timecreated * 1000 : undefined,
        });
      }
    }
    return out;
  }

  async snapshot(producer: string): Promise<PresenceSnapshot> {
    const friends = await this.friends(producer);
    const players = await this.lookup(friends);
    return { source: "Steam", producer, takenAt: Date.now(), friends, players };
  }
}

export class XboxPresence implements PresenceProvider {
  source = "Xbox" as const;
  enabled = false;
  async snapshot(): Promise<PresenceSnapshot> {
    throw new Error("Xbox presence not configured");
  }
  async lookup(): Promise<PlayerPresence[]> {
    return [];
  }
}

/** Test/dev provider fed by hand. */
export class StaticPresence implements PresenceProvider {
  enabled = true;
  constructor(
    public source: "Steam" | "Xbox",
    public players: PlayerPresence[],
  ) {}
  async snapshot(producer: string): Promise<PresenceSnapshot> {
    return {
      source: this.source,
      producer,
      takenAt: Date.now(),
      friends: sortIds(this.players.map((p) => p.id)),
      players: this.players.map((p) => ({ ...p })),
    };
  }
  async lookup(ids: string[]) {
    return this.players.filter((p) => ids.includes(p.id));
  }
}
