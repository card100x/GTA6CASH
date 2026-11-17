// HTTP server: JSON API under /api, the website (../web) for everything else.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { CLUSTER } from "./solana.js";
import { buildPumpLaunch, MAX_POOL_PCT, MIN_POOL_PCT } from "./pump.js";
import type { Relay } from "./relay.js";
import { HttpFail } from "./accounts.js";

class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const WEB_DIR = process.env.WEB_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Programs a launch/lock tx may touch; /api/send refuses anything else.
const ALLOWED_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fees
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
]);

async function readRaw(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req, 50_000)).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function launchConfig() {
  const env = (k: string) => process.env[k]?.trim() || null;
  return {
    cluster: CLUSTER,
    kmcFeeWallet: env("KMC_FEE_WALLET"),
    treasury: env("KMC_TREASURY") ?? env("KMC_FEE_WALLET"),
    deployFeeSol: Number(process.env.DEPLOY_FEE_SOL ?? 0.1),
    lookupTable: env("KMC_LOOKUP_TABLE"),
    minPoolPct: MIN_POOL_PCT,
    maxPoolPct: MAX_POOL_PCT,
  };
}

export function startServer(relay: Relay, port: number, adminToken?: string) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-admin-token");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      const s = relay.state;
      if (relay.accounts && (await relay.accounts.handle(req, res, parts, url, () => json(req)))) return;
      if (req.method === "GET") {
        if (parts[0] === "status") {
          return send(200, {
            cluster: CLUSTER,
            escrow: relay.escrow?.address.toBase58() ?? null,
            cursor: s.cursor,
            producers: relay.producers,
            presence: Object.fromEntries(
              relay.providers.map((p) => {
                const snap = relay.snaps.current[p.source];
                return [p.source, { enabled: p.enabled, takenAt: snap?.takenAt ?? null, friends: snap?.friends.length ?? 0, inGame: snap?.players.filter((x) => x.gameId).length ?? 0 }];
              }),
            ),
            tokens: Object.keys(s.tokens).length,
            lastTick: relay.lastTick,
          });
        }
        if (parts[0] === "config") return send(200, { ...launchConfig(), escrow: relay.escrow?.address.toBase58() ?? null });
        if (parts[0] === "tokens" && parts.length === 1) {
          return send(200, Object.values(s.tokens).map((t) => {
            const { recentDraws, topEarners, ...v } = relay.tokenView(t);
            return v;
          }));
        }
        if (parts[0] === "tokens" && parts[1]) {
          const t = s.tokens[parts[1]];
          if (!t) throw new HttpError(404, "unknown token");
          return send(200, relay.tokenView(t));
        }
        if (parts[0] === "site") {
          // which coin the public site shows (SITE_MINT), defaulting to the newest registered coin
          const all = Object.values(s.tokens).sort((a, b) => b.createdAt - a.createdAt);
          const t = (process.env.SITE_MINT && s.tokens[process.env.SITE_MINT]) || all[0];
          return send(200, t ? { mint: t.mint, name: t.name, symbol: t.symbol, image: t.image ?? null, games: t.games } : {});
        }
        if (parts[0] === "trades") {
          if (!relay.trades) throw new HttpError(404, "KMCoin trades are off");
          return send(200, { ...(await relay.trades.info()), recent: relay.trades.recent() });
        }
        if (parts[0] === "swap") {
          if (!relay.swap) throw new HttpError(404, "swap desk is off");
          if (parts[1] === "recent") return send(200, relay.swap.recent(url.searchParams.get("wallet") ?? undefined));
          return send(200, await relay.swap.info());
        }
        if (parts[0] === "player" && parts[1]) return send(200, relay.playerView(parts[1]));
        if (parts[0] === "wallet" && parts[1]) return send(200, relay.walletView(parts[1]));
        if (parts[0] === "draws") {
          const mint = url.searchParams.get("mint");
          return send(200, s.draws.filter((d) => !mint || d.mint === mint).slice(0, 200));
        }
        if (parts[0] === "ingame") {
          return send(200, Object.fromEntries(Object.entries(relay.snaps.current).map(([src, snap]) => [src, snap?.players.filter((p) => p.gameId).map((p) => ({ id: p.id, gameId: p.gameId, game: p.gameName })) ?? []])));
        }
      }
      if (req.method === "POST") {
        // pump.fun metadata upload (image + name/symbol/socials) -> { metadataUri }
        if (parts[0] === "upload") {
          // pump.fun's /api/ipfs refuses third-party sites (403), so we host the
          // image + metadata JSON ourselves on catbox.moe (free, no account).
          // Fine for tests; move real launches to Arweave/IPFS later.
          const raw = await readRaw(req, 6_000_000);
          const form = await new Request("http://x/", {
            method: "POST",
            headers: { "content-type": String(req.headers["content-type"] ?? "") },
            body: new Uint8Array(raw),
          }).formData();
          const file = form.get("file");
          if (!(file instanceof Blob)) throw new HttpError(400, "no image");
          const field = (k: string) => String(form.get(k) ?? "").trim();
          const image = await catbox(file, (file as File).name || "image.png");
          const metadata: Record<string, unknown> = {
            name: field("name"),
            symbol: field("symbol"),
            description: field("description"),
            image,
            showName: true,
            createdOn: "https://pump.fun",
          };
          for (const k of ["twitter", "telegram", "website"]) if (field(k)) metadata[k] = field(k);
          const metadataUri = await catbox(new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
          return send(200, { metadataUri, metadata });
        }
        const b = await json(req);
        if (parts[0] === "launch" && parts[1] === "build") return send(200, await buildLaunch(relay, b));
        if (parts[0] === "send") return send(200, await sendTx(relay, String(b.tx ?? "")));
        if (parts[0] === "tokens") return send(200, await relay.registerToken(b as never));
        if (parts[0] === "swap") {
          if (!relay.swap) throw new HttpError(404, "swap desk is off");
          if (parts[1] === "build") return send(200, await relay.swap.build(String(b.wallet), Number(b.amount)));
          if (parts[1] === "redeem") return send(200, await relay.swap.redeem(String(b.sig)));
        }
        if (parts[0] === "link") return send(200, relay.requestLink(String(b.gamingId), String(b.wallet)));
        if (parts[0] === "claim") return send(200, await relay.claim(String(b.wallet), String(b.mint)));
        if (parts[0] === "admin" && parts[1] === "token") {
          if (!adminToken || req.headers["x-admin-token"] !== adminToken) throw new HttpError(403, "forbidden");
          return send(200, await relay.addTokenManual(b as never));
        }
        if (parts[0] === "admin" && parts[1] === "link") {
          if (!adminToken || req.headers["x-admin-token"] !== adminToken) throw new HttpError(403, "forbidden");
          if (CLUSTER === "mainnet") throw new HttpError(403, "force-link is devnet only");
          relay.forceLink(String(b.gamingId), String(b.wallet));
          return send(200, { ok: true });
        }
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError || e instanceof HttpFail ? e.status : 400;
      send(status, { error: (e as Error).message });
    }
  });
  server.listen(port, () => console.log(`relay on http://localhost:${port}`));
  return server;
}

async function buildLaunch(relay: Relay, b: Record<string, unknown>) {
  if (!relay.escrow) throw new HttpError(503, "relay has no escrow");
  const cfg = launchConfig();
  if (!cfg.kmcFeeWallet) throw new HttpError(503, "relay has no KMC_FEE_WALLET");
  const creator = new PublicKey(String(b.creator));
  const name = String(b.name ?? "").trim();
  const symbol = String(b.symbol ?? "").trim().toUpperCase();
  const uri = String(b.uri ?? "");
  if (!name || name.length > 32) throw new HttpError(400, "name: 1–32 characters");
  if (!symbol || symbol.length > 13) throw new HttpError(400, "ticker: 1–13 characters");
  if (!/^https:\/\/\S{1,190}$/.test(uri)) throw new HttpError(400, "upload the coin image first");
  const build = await buildPumpLaunch({
    conn: relay.escrow.conn,
    creator,
    mint: new PublicKey(String(b.mint)),
    name,
    symbol,
    uri,
    poolPct: Number(b.poolPct),
    escrow: relay.escrow.address,
    kmcFeeWallet: new PublicKey(cfg.kmcFeeWallet),
    treasury: cfg.treasury ? new PublicKey(cfg.treasury) : undefined,
    deployFeeLamports: Math.round(cfg.deployFeeSol * 1e9),
    lookupTable: cfg.lookupTable ? new PublicKey(cfg.lookupTable) : undefined,
  });
  for (const tx of [build.launchTx, build.lockTx]) {
    if (tx.serialize().length > 1232) throw new HttpError(503, "launches are not enabled yet (lookup table not set up)");
  }
  const balance = (await relay.escrow.conn.getBalance(creator)) / 1e9;
  if (balance < build.totalSolEstimate) {
    throw new HttpError(400, `your wallet has ${balance.toFixed(3)} SOL; this launch needs about ${build.totalSolEstimate.toFixed(3)} SOL`);
  }
  return {
    launchTx: Buffer.from(build.launchTx.serialize()).toString("base64"),
    lockTx: Buffer.from(build.lockTx.serialize()).toString("base64"),
    poolTokens: build.poolTokens.toString(),
    firstBuySol: Number(build.maxSolCost) / 1e9,
    totalSol: build.totalSolEstimate,
  };
}

async function sendTx(relay: Relay, b64: string) {
  if (!relay.escrow) throw new HttpError(503, "relay has no RPC");
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys;
  for (const ix of tx.message.compiledInstructions) {
    if (!ALLOWED_PROGRAMS.has(keys[ix.programIdIndex].toBase58())) throw new HttpError(400, "transaction not allowed");
  }
  const conn = relay.escrow.conn;
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new HttpError(400, `transaction failed: ${JSON.stringify(r.value.err)}`);
  return { sig };
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let file = path.resolve(WEB_DIR, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html"); // e.g. /ggg → web/ggg/index.html
  const inside = file.startsWith(path.resolve(WEB_DIR));
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB_DIR, "index.html");
  if (!fs.existsSync(target)) return void res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}

/** Upload one file to catbox.moe; returns its public https URL. */
async function catbox(file: Blob, name: string): Promise<string> {
  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("fileToUpload", file, name);
  const r = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd, signal: AbortSignal.timeout(60_000) });
  const url = (await r.text()).trim();
  if (!r.ok || !/^https:\/\/files\.catbox\.moe\/\S+$/.test(url)) throw new HttpError(502, `image upload failed (${r.status}): ${url.slice(0, 120)}`);
  return url;
}
