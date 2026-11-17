// Xbox Live: sign the relay in with one (read-only) Xbox account, then look at
// KittyMine's Xbox friends and what they're playing - the same idea as Steam,
// where KittyMine's friend list is the player list.
//
// Sign-in uses Microsoft's device-code flow (type a code on microsoft.com/link),
// so no password ever touches this code. The refresh token is kept in
// keys/xbox-<cluster>.json (git-ignored, keep it private).
import fs from "node:fs";
import path from "node:path";
import { CLUSTER } from "./solana.js";
import { sortIds, type PlayerPresence, type PresenceProvider, type PresenceSnapshot } from "./presence.js";

const CLIENT_ID = process.env.XBOX_CLIENT_ID ?? "00000000441cc96b"; // public Xbox live client (device-code capable)
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const TOKEN_FILE = process.env.XBOX_TOKEN_FILE ?? `keys/xbox-${CLUSTER}.json`;

interface Saved {
  refresh: string;
  gamertag?: string;
  xuid?: string;
}

async function form(url: string, body: Record<string, string>) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, j };
}

export async function startDeviceLogin() {
  const { ok, j } = await form("https://login.live.com/oauth20_connect.srf", { client_id: CLIENT_ID, scope: SCOPE, response_type: "device_code" });
  if (!ok || !j.device_code) throw new Error(`device login failed: ${JSON.stringify(j)}`);
  return j as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
}

export async function pollDeviceLogin(deviceCode: string, interval: number, expiresIn: number): Promise<string> {
  const end = Date.now() + expiresIn * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.max(interval, 3) * 1000));
    const { ok, j } = await form("https://login.live.com/oauth20_token.srf", {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (ok && j.refresh_token) return String(j.refresh_token);
    if (j.error && j.error !== "authorization_pending" && j.error !== "slow_down") throw new Error(`login failed: ${j.error_description ?? j.error}`);
  }
  throw new Error("login timed out");
}

export function saveToken(s: Saved) {
  fs.mkdirSync(path.dirname(path.resolve(TOKEN_FILE)), { recursive: true });
  fs.writeFileSync(path.resolve(TOKEN_FILE), JSON.stringify(s, null, 1));
}
function loadToken(): Saved | null {
  const p = path.resolve(TOKEN_FILE);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as Saved) : null;
}

export class XboxClient {
  private auth: { header: string; exp: number; xuid: string; gamertag: string } | null = null;
  constructor(private saved: Saved | null = loadToken()) {}
  get enabled() {
    return Boolean(this.saved?.refresh);
  }

  /** "XBL3.0 x=uhs;token", refreshed when close to expiry. */
  async header(): Promise<string> {
    if (this.auth && this.auth.exp - Date.now() > 5 * 60_000) return this.auth.header;
    if (!this.saved) throw new Error("Xbox not signed in (run: npx tsx scripts/xbox-login.ts)");
    const { ok, j } = await form("https://login.live.com/oauth20_token.srf", { client_id: CLIENT_ID, scope: SCOPE, grant_type: "refresh_token", refresh_token: this.saved.refresh });
    if (!ok || !j.access_token) throw new Error(`Xbox token refresh failed: ${j.error_description ?? j.error ?? "unknown"}`);
    if (j.refresh_token && j.refresh_token !== this.saved.refresh) {
      this.saved.refresh = String(j.refresh_token);
      saveToken(this.saved);
    }
    const post = async (url: string, body: unknown) => {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-xbl-contract-version": "1" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${new URL(url).host} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()) as { Token: string; NotAfter: string; DisplayClaims: { xui: { uhs: string; xid?: string; gtg?: string }[] } };
    };
    const user = await post("https://user.auth.xboxlive.com/user/authenticate", {
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: String(j.access_token) },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    });
    const xsts = await post("https://xsts.auth.xboxlive.com/xsts/authorize", {
      Properties: { SandboxId: "RETAIL", UserTokens: [user.Token] },
      RelyingParty: "http://xboxlive.com",
      TokenType: "JWT",
    });
    const xui = xsts.DisplayClaims.xui[0];
    this.auth = { header: `XBL3.0 x=${xui.uhs};${xsts.Token}`, exp: Date.parse(xsts.NotAfter), xuid: xui.xid ?? "", gamertag: xui.gtg ?? "" };
    return this.auth.header;
  }

  async me() {
    await this.header();
    return { xuid: this.auth!.xuid, gamertag: this.auth!.gamertag };
  }

  private async call<T>(method: "GET" | "POST", url: string, contract: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
      method,
      headers: { authorization: await this.header(), "x-xbl-contract-version": contract, "accept-language": "en-US", accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Xbox ${new URL(url).host}${new URL(url).pathname} -> HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  /** People `xuid` follows / is friends with (as far as their privacy lets us see). */
  async friendsOf(xuid: string): Promise<{ xuid: string; gamertag: string; presence?: string }[]> {
    const r = await this.call<{ people: { xuid: string; gamertag: string; presenceText?: string; isFollowingCaller?: boolean }[] }>(
      "GET",
      `https://peoplehub.xboxlive.com/users/xuid(${xuid})/people/social/decoration/presencedetail`,
      "5",
    );
    return (r.people ?? []).map((p) => ({ xuid: p.xuid, gamertag: p.gamertag, presence: p.presenceText }));
  }

  /** What each xuid is playing right now (null = not in a game / hidden). */
  async presence(xuids: string[]): Promise<Map<string, { titleId: string; name: string } | null>> {
    const out = new Map<string, { titleId: string; name: string } | null>();
    for (let i = 0; i < xuids.length; i += 100) {
      const batch = xuids.slice(i, i + 100);
      const r = await this.call<{ xuid: string; state: string; devices?: { titles?: { id: string; name: string; placement: string; state: string }[] }[] }[]>(
        "POST",
        "https://userpresence.xboxlive.com/users/batch",
        "3",
        { users: batch, level: "all", onlineOnly: false },
      );
      for (const u of r) {
        const titles = (u.devices ?? []).flatMap((d) => d.titles ?? []).filter((t) => t.state === "Active" && t.name && !/^(Home|Online|Xbox App)$/i.test(t.name));
        const game = titles.find((t) => t.placement === "Full") ?? titles[0];
        out.set(u.xuid, game ? { titleId: game.id, name: game.name } : null);
      }
    }
    return out;
  }

  /** Gamertag -> XUID (null if no such gamertag). */
  async xuidOf(gamertag: string): Promise<string | null> {
    try {
      const r = await this.call<{ profileUsers: { id: string }[] }>("GET", `https://profile.xboxlive.com/users/gt(${encodeURIComponent(gamertag.trim())})/profile/settings?settings=Gamertag`, "2");
      return r.profileUsers?.[0]?.id ?? null;
    } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) return null;
      throw e;
    }
  }

  /** Bio + gamertag + account tier for each xuid (Bio is where login codes go). */
  async profiles(xuids: string[]): Promise<Map<string, { gamertag: string; bio: string }>> {
    const out = new Map<string, { gamertag: string; bio: string }>();
    for (let i = 0; i < xuids.length; i += 100) {
      const r = await this.call<{ profileUsers: { id: string; settings: { id: string; value: string }[] }[] }>(
        "POST",
        "https://profile.xboxlive.com/users/batch/profile/settings",
        "2",
        { userIds: xuids.slice(i, i + 100), settings: ["Gamertag", "Bio"] },
      );
      for (const u of r.profileUsers ?? []) {
        const s = Object.fromEntries(u.settings.map((x) => [x.id, x.value]));
        out.set(u.id, { gamertag: s.Gamertag ?? "", bio: s.Bio ?? "" });
      }
    }
    return out;
  }
}

/**
 * Presence provider: KittyMine's Xbox friends and what they're playing.
 * Xbox games are matched by NAME (titleIds differ per console generation), so a
 * token's `games.xbox` list holds lowercase name fragments, e.g. "grand theft auto v".
 */
export class XboxLivePresence implements PresenceProvider {
  source = "Xbox" as const;
  constructor(public x = new XboxClient()) {}
  get enabled() {
    return this.x.enabled;
  }
  xuidOf(gamertag: string) {
    return this.x.xuidOf(gamertag);
  }
  async snapshot(producer: string): Promise<PresenceSnapshot> {
    const friends = sortIds((await this.x.friendsOf(producer)).map((f) => f.xuid));
    const players = await this.lookup(friends, false);
    return { source: "Xbox", producer, takenAt: Date.now(), friends, players };
  }
  async lookup(ids: string[], withBio = true): Promise<PlayerPresence[]> {
    if (ids.length === 0) return [];
    const [pres, prof] = await Promise.all([this.x.presence(ids), withBio ? this.x.profiles(ids) : Promise.resolve(new Map())]);
    return ids.map((id) => {
      const g = pres.get(id) ?? null;
      return { id, gameId: g ? g.name.toLowerCase() : null, gameName: g?.name, realName: prof.get(id)?.bio };
    });
  }
}
