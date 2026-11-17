// Player accounts: log in with Steam, get a Solana wallet we hold for you.
//
// Login, two ways:
//  1. "Sign in through Steam" (Steam's official OpenID): the password is typed on
//     steamcommunity.com, never here. One click.
//  2. Login code: we show a one-time code (kmc-xxxxxxxx), the player puts it in
//     their Steam "real name", we see it through the Steam API -> logged in.
//
// Each Steam account gets one generated wallet. Mining winnings are collected
// into it, and the player can withdraw tokens to any address (the escrow pays
// the network fee) or export the private key to Phantom.
//
// Custody: secret keys are stored AES-256-GCM encrypted (data/accounts-*.json);
// the encryption key lives in keys/wallets-*.key. Whoever has both files has
// every player wallet, so back them up and keep them private.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { isSteamId, isXuid } from "./link.js";
import type { XboxLivePresence } from "./xbox.js";
import type { PresenceProvider } from "./presence.js";
import type { Relay } from "./relay.js";
import { CLUSTER } from "./solana.js";

const SESSION_MS = 30 * 86_400_000;
const CODE_MS = 15 * 60_000;
const COOKIE = "kmc_s";
const ALT = "kmc_s2"; // the other platform's session, so players can switch Steam <-> Xbox
const WITHDRAWALS_PER_DAY = 10;

interface Account {
  id: string; // SteamID64 or Xbox XUID
  wallet: string;
  secret: string; // iv.tag.ciphertext (base64), AES-256-GCM
  createdAt: number;
  lastLogin: number;
  exportedAt?: number;
  withdrawals?: { at: number; mint: string; to: string; amount: string; sig: string }[];
}
interface AccountsFile {
  accounts: Record<string, Account>;
  sessions: Record<string, { id: string; exp: number }>; // sha256(token) -> session
}

export class HttpFail extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class Accounts {
  private file: string;
  private data: AccountsFile;
  private master: Buffer;
  private codes = new Map<string, { code: string; exp: number; lastCheck: number }>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private relay: Relay,
    private steam: PresenceProvider,
    private xbox: XboxLivePresence | null = null,
    dir = "data",
    keyFile = `keys/wallets-${CLUSTER}.key`,
    private log: (...a: unknown[]) => void = console.log,
  ) {
    this.file = path.resolve(dir, `accounts-${CLUSTER}.json`);
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { accounts: {}, sessions: {} };
    const kf = path.resolve(keyFile);
    if (!fs.existsSync(kf)) {
      fs.mkdirSync(path.dirname(kf), { recursive: true });
      fs.writeFileSync(kf, crypto.randomBytes(32).toString("hex"));
      this.log(`generated ${keyFile} (wallet encryption key; back it up)`);
    }
    this.master = Buffer.from(fs.readFileSync(kf, "utf8").trim(), "hex");
    if (this.master.length !== 32) throw new Error(`${keyFile} must hold 32 bytes of hex`);
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const now = Date.now();
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.exp < now) delete this.data.sessions[k];
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.data, null, 1));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  // ---------- keys ----------
  private encrypt(secret: Uint8Array): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.master, iv);
    const ct = Buffer.concat([c.update(secret), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  }
  private keypair(a: Account): Keypair {
    const [iv, tag, ct] = a.secret.split(".").map((s) => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", this.master, iv);
    d.setAuthTag(tag);
    return Keypair.fromSecretKey(Buffer.concat([d.update(ct), d.final()]));
  }

  private ensure(id: string): Account {
    let a = this.data.accounts[id];
    if (!a) {
      const kp = Keypair.generate();
      a = { id, wallet: kp.publicKey.toBase58(), secret: this.encrypt(kp.secretKey), createdAt: Date.now(), lastLogin: Date.now() };
      this.data.accounts[id] = a;
      this.log(`account created for ${id}: ${a.wallet}`);
    }
    // winnings for this Steam account are paid into its account wallet
    if (this.relay.state.links[id] !== a.wallet) {
      this.relay.state.links[id] = a.wallet;
      delete this.relay.state.pendingLinks[id];
      this.relay.store.save();
    }
    a.lastLogin = Date.now();
    return a;
  }

  // ---------- sessions ----------
  private newSession(id: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.data.sessions[sha(token)] = { id, exp: Date.now() + SESSION_MS };
    this.ensure(id);
    this.save();
    return token;
  }
  private cookie(req: http.IncomingMessage, token: string, maxAge: number, name = COOKIE) {
    const secure = String(req.headers["x-forwarded-proto"] ?? "").includes("https") || process.env.PUBLIC_URL?.startsWith("https") ? "; Secure" : "";
    return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure}`;
  }
  private token(req: http.IncomingMessage, name = COOKIE): string | null {
    return String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)`))?.[1] ?? null;
  }
  private byToken(t: string | null): Account | null {
    if (!t) return null;
    const s = this.data.sessions[sha(t)];
    if (!s || s.exp < Date.now()) return null;
    return this.data.accounts[s.id] ?? null;
  }
  private session(req: http.IncomingMessage): Account | null {
    return this.byToken(this.token(req));
  }
  /** Cookies for a fresh login. Logging in on the other platform keeps the old session as the alt one. */
  private loginCookies(req: http.IncomingMessage, token: string, id: string): string[] {
    const out = [this.cookie(req, token, SESSION_MS)];
    const cur = this.token(req);
    const curAcct = this.byToken(cur);
    if (cur && curAcct && isSteamId(curAcct.id) !== isSteamId(id)) out.push(this.cookie(req, cur, SESSION_MS, ALT));
    return out;
  }
  private origin(req: http.IncomingMessage) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
    return `${proto}://${req.headers.host}`;
  }

  // ---------- HTTP ----------
  /** Handles /api/auth/* and /api/me/*. Returns false if the route isn't ours. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL, body: () => Promise<Record<string, unknown>>): Promise<boolean> {
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(data));
    };
    const [a, b] = parts;
    if (a !== "auth" && a !== "me") return false;
    // state-changing calls must be JSON (blocks cross-site form posts)
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpFail(415, "send JSON");

    // --- Steam OpenID ---
    if (a === "auth" && b === "steam" && req.method === "GET" && parts[2] !== "return") {
      const o = this.origin(req);
      const q = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": `${o}/api/auth/steam/return`,
        "openid.realm": o,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      });
      res.writeHead(302, { location: `https://steamcommunity.com/openid/login?${q}` }).end();
      return true;
    }
    if (a === "auth" && b === "steam" && parts[2] === "return" && req.method === "GET") {
      const p = url.searchParams;
      const back = (msg?: string, extra: Record<string, string> = {}) =>
        res.writeHead(302, { location: `/ggg/${msg ? `?login_error=${encodeURIComponent(msg)}` : ""}#account`, ...extra });
      const expectReturn = `${this.origin(req)}/api/auth/steam/return`;
      if (p.get("openid.mode") !== "id_res" || !(p.get("openid.return_to") ?? "").startsWith(expectReturn)) return void back("Steam login was cancelled").end(), true;
      if (p.get("openid.op_endpoint") !== "https://steamcommunity.com/openid/login") return void back("bad Steam response").end(), true;
      const check = new URLSearchParams(p);
      check.set("openid.mode", "check_authentication");
      const r = await fetch("https://steamcommunity.com/openid/login", { method: "POST", body: check, signal: AbortSignal.timeout(15_000) }).then((x) => x.text()).catch(() => "");
      const id = (p.get("openid.claimed_id") ?? "").match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656\d{13})$/)?.[1];
      if (!/is_valid\s*:\s*true/.test(r) || !id) return void back("Steam could not confirm the login").end(), true;
      const token = await this.serial(() => this.newSession(id));
      this.log(`login (steam) ${id}`);
      back(undefined, { "set-cookie": this.loginCookies(req, token, id) } as unknown as Record<string, string>).end();
      return true;
    }

    // --- login code in Steam real name ---
    if (a === "auth" && b === "code" && req.method === "POST") {
      const bd = await body();
      const input = String(bd.id ?? bd.steamId ?? "").trim();
      const steamId = input.match(/(7656\d{13})/)?.[1];
      let id: string | null = steamId ?? null;
      if (!id && this.xbox) id = isXuid(input) ? input : /^[A-Za-z0-9 ]{1,16}(#\d{1,4})?$/.test(input) ? await this.xbox.xuidOf(input) : null;
      if (!id) throw new HttpFail(400, this.xbox ? "enter your SteamID64 (starts with 7656) or your Xbox gamertag" : "enter your 17-digit SteamID64 (starts with 7656)");
      const code = "kmc-" + crypto.randomBytes(4).toString("hex");
      this.codes.set(id, { code, exp: Date.now() + CODE_MS, lastCheck: 0 });
      const platform = isSteamId(id) ? "steam" : "xbox";
      return void send(200, { id, platform, code, where: platform === "steam" ? "Steam profile → Edit Profile → Real Name" : "Xbox profile → Customize profile → Bio", expiresAt: Date.now() + CODE_MS }), true;
    }
    if (a === "auth" && b === "check" && req.method === "POST") {
      const bd = await body();
      const id = String(bd.id ?? bd.steamId ?? "").trim();
      const c = this.codes.get(id);
      if (!c || c.code !== String(bd.code ?? "") || c.exp < Date.now()) throw new HttpFail(400, "code expired; get a new one");
      if (Date.now() - c.lastCheck < 8_000) return void send(200, { ok: false }), true; // API politeness
      c.lastCheck = Date.now();
      const provider = isSteamId(id) ? this.steam : this.xbox;
      if (!provider) throw new HttpFail(400, "Xbox login is off");
      const [p] = await provider.lookup([id]);
      if (!p) throw new HttpFail(404, "account not found (is the profile public?)");
      if (!(p.realName ?? "").toLowerCase().includes(c.code)) return void send(200, { ok: false }), true;
      this.codes.delete(id);
      const token = await this.serial(() => this.newSession(id));
      this.log(`login (code) ${id}`);
      return void send(200, { ok: true }, { "set-cookie": this.loginCookies(req, token, id) } as unknown as Record<string, string>), true;
    }
    if (a === "auth" && b === "logout" && req.method === "POST") {
      const cur = this.token(req);
      if (cur) {
        delete this.data.sessions[sha(cur)];
        this.save();
      }
      // logging out of one platform falls back to the other one, if any
      const alt = this.token(req, ALT);
      const cookies = alt && this.byToken(alt) ? [this.cookie(req, alt, SESSION_MS), this.cookie(req, "", 0, ALT)] : [this.cookie(req, "", 0), this.cookie(req, "", 0, ALT)];
      return void send(200, { ok: true }, { "set-cookie": cookies } as unknown as Record<string, string>), true;
    }
    if (a === "auth" && b === "switch" && req.method === "POST") {
      const cur = this.token(req);
      const alt = this.token(req, ALT);
      if (!alt || !this.byToken(alt)) throw new HttpFail(400, "no other account to switch to; log in with it first");
      const cookies = [this.cookie(req, alt, SESSION_MS), cur && this.byToken(cur) ? this.cookie(req, cur, SESSION_MS, ALT) : this.cookie(req, "", 0, ALT)];
      return void send(200, { ok: true }, { "set-cookie": cookies } as unknown as Record<string, string>), true;
    }

    // --- logged-in account ---
    const acct = this.session(req);
    if (!acct) throw new HttpFail(401, "not logged in");
    if (a === "me" && !b && req.method === "GET") {
      const other = this.byToken(this.token(req, ALT));
      const linked = other && other.id !== acct.id ? { id: other.id, platform: isSteamId(other.id) ? "steam" : "xbox" } : null;
      return void send(200, { ...(await this.view(acct)), other: linked }), true;
    }
    if (a === "me" && b === "collect" && req.method === "POST") {
      const mint = String((await body()).mint ?? "");
      const r = await this.relay.claim(acct.wallet, mint);
      return void send(200, r), true;
    }
    if (a === "me" && b === "withdraw" && req.method === "POST") {
      const bd = await body();
      const r = await this.serial(() => this.withdraw(acct, String(bd.mint ?? ""), String(bd.to ?? ""), String(bd.amount ?? "")));
      return void send(200, r), true;
    }
    if (a === "me" && b === "export" && req.method === "POST") {
      if ((await body()).confirm !== "EXPORT") throw new HttpFail(400, "confirm the export");
      acct.exportedAt = Date.now();
      this.save();
      this.log(`key exported by ${acct.id}`);
      return void send(200, { wallet: acct.wallet, secretKey: bs58.encode(this.keypair(acct).secretKey) }), true;
    }
    throw new HttpFail(404, "not found");
  }

  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async view(a: Account) {
    const escrow = this.relay.escrow;
    const s = this.relay.state;
    const tokens = await Promise.all(
      Object.values(s.tokens).map(async (t) => {
        const earned = BigInt(s.earned[t.mint]?.[a.id] ?? "0");
        const claimed = BigInt(s.claimed[t.mint]?.[a.id] ?? "0");
        let balance = "0";
        let decimals = 6;
        if (escrow) {
          const info = await escrow.mintInfo(new PublicKey(t.mint)).catch(() => null);
          if (info) {
            decimals = info.decimals;
            const ata = getAssociatedTokenAddressSync(new PublicKey(t.mint), new PublicKey(a.wallet), false, info.programId);
            balance = (await escrow.conn.getTokenAccountBalance(ata).catch(() => null))?.value.amount ?? "0";
          }
        }
        return { mint: t.mint, symbol: t.symbol, name: t.name, decimals, winnings: (earned - claimed).toString(), balance };
      }),
    );
    return {
      id: a.id,
      platform: isSteamId(a.id) ? "steam" : "xbox",
      steamId: a.id,
      wallet: a.wallet,
      createdAt: a.createdAt,
      exported: Boolean(a.exportedAt),
      tokens,
      withdrawals: (a.withdrawals ?? []).slice(0, 20),
    };
  }

  private async withdraw(a: Account, mintIn: string, toIn: string, amountIn: string) {
    const escrow = this.relay.escrow;
    if (!escrow) throw new HttpFail(503, "relay has no escrow");
    let mint: PublicKey, to: PublicKey;
    try {
      mint = new PublicKey(mintIn);
      to = new PublicKey(toIn);
    } catch {
      throw new HttpFail(400, "that isn't a valid Solana address");
    }
    if (!this.relay.state.tokens[mint.toBase58()]) throw new HttpFail(400, "unknown token");
    if (to.toBase58() === a.wallet) throw new HttpFail(400, "that's your account wallet already");
    const day = Date.now() - 86_400_000;
    a.withdrawals ??= [];
    if (a.withdrawals.filter((w) => w.at > day).length >= WITHDRAWALS_PER_DAY) throw new HttpFail(429, `max ${WITHDRAWALS_PER_DAY} withdrawals per day`);

    const info = await escrow.mintInfo(mint);
    const owner = this.keypair(a);
    const from = getAssociatedTokenAddressSync(mint, owner.publicKey, false, info.programId);
    const bal = BigInt((await escrow.conn.getTokenAccountBalance(from).catch(() => null))?.value.amount ?? "0");
    let raw: bigint;
    if (amountIn === "all") raw = bal;
    else {
      if (!/^\d+(\.\d+)?$/.test(amountIn)) throw new HttpFail(400, "enter an amount");
      const [w, f = ""] = amountIn.split(".");
      raw = BigInt(w) * 10n ** BigInt(info.decimals) + BigInt((f + "0".repeat(info.decimals)).slice(0, info.decimals) || "0");
    }
    if (raw <= 0n) throw new HttpFail(400, "nothing to withdraw");
    if (raw > bal) throw new HttpFail(400, "that's more than your wallet holds");

    const dest = getAssociatedTokenAddressSync(mint, to, true, info.programId);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      createAssociatedTokenAccountIdempotentInstruction(escrow.address, dest, to, mint, info.programId),
      createTransferCheckedInstruction(from, mint, dest, owner.publicKey, raw, info.decimals, [], info.programId),
    );
    const { blockhash, lastValidBlockHeight } = await escrow.conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = escrow.address; // the escrow pays fees so players never need SOL
    tx.sign(escrow.key, owner);
    const sig = await escrow.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const r = await escrow.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (r.value.err) throw new HttpFail(400, `withdrawal failed: ${JSON.stringify(r.value.err)}`);
    a.withdrawals.unshift({ at: Date.now(), mint: mint.toBase58(), to: to.toBase58(), amount: raw.toString(), sig });
    a.withdrawals.length = Math.min(a.withdrawals.length, 100);
    this.save();
    this.log(`withdraw ${a.id}: ${raw} ${this.relay.state.tokens[mint.toBase58()].symbol} -> ${to.toBase58()} (${sig})`);
    return { sig, amount: raw.toString() };
  }
}
