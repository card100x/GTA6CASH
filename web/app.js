// KMC Launchpad front-end. Plain JS, no build step. Talks to the relay at /api.
import { Keypair, VersionedTransaction } from "https://esm.sh/@solana/web3.js@1.98.4";

const STEAM_PRODUCER = "76561198779127606"; // KittyMine's Steam account (KittyMineCoin)
const XBOX_PRODUCER_NAME = "TheKittyMine";
const GAMES = [
  ["730", "Counter-Strike 2"],
  ["570", "Dota 2"],
  ["252490", "Rust"],
  ["271590", "GTA V"],
  ["578080", "PUBG"],
  ["1172470", "Apex Legends"],
  ["359550", "Rainbow Six Siege"],
  ["2357570", "Overwatch 2"],
  ["1085660", "Destiny 2"],
  ["440", "Team Fortress 2"],
];
const gameName = (id) => GAMES.find((g) => g[0] === id)?.[1] ?? `App ${id}`;

const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (raw, dec = 6) => {
  const n = Number(BigInt(raw ?? 0)) / 10 ** dec;
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(n < 10 ? 2 : 0);
};
const short = (s) => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const ago = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), bad ? 9000 : 4500);
}

async function api(path, body) {
  const r = await fetch("/api/" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

// ---------- wallet (Phantom / any window.solana wallet) ----------
const provider = () => window.phantom?.solana ?? window.solana ?? null;
let wallet = null;
async function connect() {
  const p = provider();
  if (!p) {
    toast("No Solana wallet found. Install Phantom (phantom.app).", true);
    throw new Error("no wallet");
  }
  const r = await p.connect();
  wallet = r.publicKey.toString();
  renderWallet();
  return wallet;
}
function renderWallet() {
  $("#wallet").textContent = wallet ? short(wallet) : "Connect wallet";
}
$("#wallet").onclick = () => connect().then(route).catch(() => {});
provider()?.connect?.({ onlyIfTrusted: true }).then((r) => { wallet = r.publicKey.toString(); renderWallet(); route(); }).catch(() => {});

// ---------- router ----------
let config = null;
async function route() {
  config ??= await api("config").catch(() => ({}));
  $("#cluster").textContent = config.cluster ? `network: ${config.cluster}` : "";
  const [, page, arg] = (location.hash || "#/").split("/");
  document.querySelectorAll(".top nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${page ?? ""}`));
  try {
    if (page === "launch") return renderLaunch();
    if (page === "mine") return renderMine();
    if (page === "coin" && arg) return renderCoin(arg);
    return renderHome();
  } catch (e) {
    app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();

// ---------- home ----------
function coinCard(t) {
  const pct = t.pool === "0" ? 0 : Number((BigInt(t.distributed) * 10000n) / BigInt(t.pool)) / 100;
  const games = t.games.any ? ["Any game"] : t.games.steam.map(gameName);
  return `<a class="panel coin" href="#/coin/${esc(t.mint)}">
    <div class="head">${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy" />` : `<div class="avatar"></div>`}
      <div><h3>${esc(t.name)}</h3><div class="dim">$${esc(t.symbol)}</div></div></div>
    <div class="tags">${games.slice(0, 3).map((g) => `<span class="tag hot">🎮 ${esc(g)}</span>`).join("")}${games.length > 3 ? `<span class="tag">+${games.length - 3}</span>` : ""}</div>
    <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
    <div class="dim" style="font-size:13px">${fmt(t.distributed)} of ${fmt(t.pool)} mined · ${t.players} players</div>
  </a>`;
}

async function renderHome() {
  app.innerHTML = `<section class="hero">
      <div>
        <h1>Play games.<br/>Mine coins.</h1>
        <p>Launch a pump.fun coin where part of the supply can only be earned by playing the games you pick. Gamers mine it through KittyMine's proof-of-game. No passwords, nothing to install.</p>
        <div class="cta"><a class="btn" href="#/launch">Launch a coin</a><a class="btn ghost" href="#/mine">Start mining</a></div>
      </div>
      <div class="panel steps">
        <div class="step"><b>1</b><div><strong>Creator launches</strong><div class="dim">${config.minPoolPct ?? 10}–${config.maxPoolPct ?? 15}% of supply goes into a mining pool.</div></div></div>
        <div class="step"><b>2</b><div><strong>Gamers play</strong><div class="dim">Friend KittyMine on Steam and play the coin's games.</div></div></div>
        <div class="step"><b>3</b><div><strong>Winners get paid</strong><div class="dim">Every KittyMine block, one player wins a drip of the pool.</div></div></div>
        <div class="step"><b>4</b><div><strong>Fees buy $KMC</strong><div class="dim">The pump.fun creator fee is split 50/50 between the creator and KMC, locked on-chain.</div></div></div>
      </div>
    </section>
    <div class="stats" id="stats"></div>
    <h2>Coins being mined</h2>
    <div class="grid" id="coins"><div class="empty">Loading…</div></div>`;
  const [tokens, status] = await Promise.all([api("tokens").catch(() => []), api("status").catch(() => null)]);
  if (status) {
    const inGame = (status.presence?.Steam?.inGame ?? 0) + (status.presence?.Xbox?.inGame ?? 0);
    $("#stats").innerHTML = [
      ["KittyMine block", status.cursor ? `#${status.cursor}` : "—"],
      ["Coins", tokens.length],
      ["Gamers in-game now", status.presence?.Steam?.enabled ? inGame : "—"],
    ].map(([k, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");
  }
  $("#coins").innerHTML = tokens.length
    ? tokens.sort((a, b) => b.createdAt - a.createdAt).map(coinCard).join("")
    : `<div class="empty panel" style="grid-column:1/-1">No coins yet. <a href="#/launch">Be the first.</a></div>`;
}

// ---------- launch ----------
function renderLaunch() {
  const min = config.minPoolPct ?? 10, max = config.maxPoolPct ?? 15;
  app.innerHTML = `<h1 style="font-size:36px">Launch a play-to-mine coin</h1>
  <p class="dim" style="margin-top:-4px">Your coin launches on pump.fun. You buy ${min}–${max}% of supply at launch; it goes straight into the mining pool for gamers.</p>
  <form id="lf" class="two" autocomplete="off">
    <div class="panel">
      <div class="row">
        <div class="field"><label>Name</label><input type="text" name="name" maxlength="32" required placeholder="Pirate Shop Token" /></div>
        <div class="field"><label>Ticker</label><input type="text" name="symbol" maxlength="13" required placeholder="PIRATE" /></div>
      </div>
      <div class="field"><label>Image</label><input type="file" name="image" accept="image/*" required /></div>
      <div class="field"><label>Description</label><textarea name="description" maxlength="500" placeholder="What is this coin about?"></textarea></div>
      <div class="row">
        <div class="field"><label>X / Twitter <span class="dim">(optional)</span></label><input type="url" name="twitter" placeholder="https://x.com/…" /></div>
        <div class="field"><label>Telegram <span class="dim">(optional)</span></label><input type="url" name="telegram" placeholder="https://t.me/…" /></div>
      </div>
      <div class="field"><label>Website <span class="dim">(optional)</span></label><input type="url" name="website" placeholder="https://…" /></div>
    </div>
    <div class="panel">
      <div class="field"><label>Which games mine it?</label>
        <div class="games">
          <label><input type="checkbox" name="any" /> 🌐 Any game</label>
          ${GAMES.map(([id, n]) => `<label><input type="checkbox" name="game" value="${id}" /> ${esc(n)}</label>`).join("")}
        </div>
        <input type="text" name="custom" placeholder="Other Steam app IDs, comma separated (e.g. 1245620)" style="margin-top:10px" />
        <div class="hint">"Any game" pays KittyMine's own block winners on Steam and Xbox. Picked games use Steam for now; Xbox titles are coming.</div>
      </div>
      <div class="field"><label>Mining pool</label>
        <div class="range"><input type="range" name="pool" min="${min}" max="${max}" step="${min < 1 ? 0.1 : 1}" value="${min}" /><strong id="poolv">${min}%</strong></div>
      </div>
      <div class="field"><label>Mined over</label>
        <select name="period"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">180 days</option><option value="365">1 year</option></select>
      </div>
      <div class="summary" id="sum">
        <div><span class="dim">Pool buy (≈)</span><strong id="cost">—</strong></div>
        <div><span class="dim">Deploy fee</span><strong>${config.deployFeeSol ?? 0} SOL</strong></div>
        <div><span class="dim">Creator fee split</span><strong>50% you · 50% $KMC</strong></div>
      </div>
      <button class="btn" style="width:100%;margin-top:16px" id="go">Launch</button>
      <div class="progress" id="prog"></div>
    </div>
  </form>`;
  const f = $("#lf");
  const poolCost = (pct) => {
    // pump.fun curve: 1.073B virtual tokens / 30 SOL virtual, 1% fee-ish on top
    const vT = 1_073_000_000, vS = 30, out = pct * 10_000_000;
    return ((vS * vT) / (vT - out) - vS) * 1.0125;
  };
  const upd = () => {
    $("#poolv").textContent = f.pool.value + "%";
    $("#cost").textContent = `${poolCost(Number(f.pool.value)).toFixed(2)} SOL`;
  };
  f.pool.oninput = upd;
  upd();
  f.onsubmit = (e) => {
    e.preventDefault();
    launch(f).catch((err) => {
      console.error(err);
      toast(err.message, true);
      $("#go").disabled = false;
    });
  };
}

async function launch(f) {
  const steam = [...f.querySelectorAll('input[name="game"]:checked')].map((i) => i.value);
  const custom = f.custom.value.split(",").map((s) => s.trim()).filter((s) => /^\d{1,10}$/.test(s));
  const games = { any: f.any.checked, steam: [...new Set([...steam, ...custom])], xbox: [] };
  if (!games.any && games.steam.length === 0) throw new Error("Pick at least one game (or Any game).");
  if (!f.image.files[0]) throw new Error("Add an image.");
  if (!wallet) await connect();
  $("#go").disabled = true;

  const steps = ["Uploading image", "Building transactions", "Approve in your wallet", "Launching on pump.fun", "Locking the 50/50 fee split", "Starting the mining pool"];
  const prog = $("#prog");
  const show = (i) => (prog.innerHTML = steps.map((s, j) => `<div class="${j < i ? "done" : j === i ? "now" : ""}">${j < i ? "✓" : j === i ? "…" : "·"} ${s}</div>`).join(""));

  show(0);
  const fd = new FormData();
  fd.append("file", f.image.files[0]);
  for (const k of ["name", "symbol", "description", "twitter", "telegram", "website"]) fd.append(k, f[k].value.trim());
  fd.append("showName", "true");
  const up = await fetch("/api/upload", { method: "POST", body: fd }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.metadataUri) throw new Error(d.error || "Image upload failed");
    return d;
  });

  show(1);
  const mint = Keypair.generate();
  const built = await api("launch/build", {
    creator: wallet,
    mint: mint.publicKey.toBase58(),
    name: f.name.value.trim(),
    symbol: f.symbol.value.trim(),
    uri: up.metadataUri,
    poolPct: Number(f.pool.value),
  });

  show(2);
  const launchTx = VersionedTransaction.deserialize(b64ToBytes(built.launchTx));
  const lockTx = VersionedTransaction.deserialize(b64ToBytes(built.lockTx));
  const [signedLaunch, signedLock] = await provider().signAllTransactions([launchTx, lockTx]);
  signedLaunch.sign([mint]);

  show(3);
  const { sig: launchSig } = await api("send", { tx: bytesToB64(signedLaunch.serialize()) });
  show(4);
  await api("send", { tx: bytesToB64(signedLock.serialize()) });

  show(5);
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      await api("tokens", {
        mint: mint.publicKey.toBase58(),
        launchSig,
        name: f.name.value.trim(),
        symbol: f.symbol.value.trim(),
        image: up.metadata?.image,
        games,
        periodDays: Number(f.period.value),
      });
      show(6);
      toast("Launched! Mining has started.");
      location.hash = `#/coin/${mint.publicKey.toBase58()}`;
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw new Error(`Coin is live on pump.fun but the mining pool didn't start: ${lastErr?.message}. Mint: ${mint.publicKey.toBase58()}`);
}

// ---------- coin ----------
async function renderCoin(mint) {
  app.innerHTML = `<div class="empty">Loading…</div>`;
  const t = await api(`tokens/${encodeURIComponent(mint)}`);
  const pct = Number((BigInt(t.distributed) * 10000n) / BigInt(t.pool)) / 100;
  const days = Math.round(t.periodMs / 86400000);
  const games = t.games.any ? ["Any game (KittyMine winners)"] : t.games.steam.map(gameName);
  app.innerHTML = `<div class="two">
    <div class="panel">
      <div class="coin"><div class="head">${t.image ? `<img src="${esc(t.image)}" alt="" />` : `<div class="avatar"></div>`}
        <div><h2 style="margin:0">${esc(t.name)}</h2><div class="dim">$${esc(t.symbol)} · <span class="mono">${esc(short(t.mint))}</span></div></div></div></div>
      <div class="tags" style="margin:14px 0">${games.map((g) => `<span class="tag hot">🎮 ${esc(g)}</span>`).join("")}</div>
      <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="summary" style="margin-top:14px">
        <div><span class="dim">Mining pool</span><strong>${fmt(t.pool)} $${esc(t.symbol)}</strong></div>
        <div><span class="dim">Mined so far</span><strong>${fmt(t.distributed)} (${pct.toFixed(2)}%)</strong></div>
        <div><span class="dim">Mined over</span><strong>${days} days</strong></div>
        <div><span class="dim">Players who earned</span><strong>${t.players}</strong></div>
      </div>
      <div class="cta" style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <a class="btn" href="https://pump.fun/coin/${esc(t.mint)}" target="_blank" rel="noopener">Trade on pump.fun</a>
        <a class="btn ghost" href="#/mine">Mine this coin</a>
      </div>
    </div>
    <div class="panel">
      <h3>Top miners</h3>
      ${t.topEarners.length ? `<table><tr><th>Player</th><th>Mined</th></tr>${t.topEarners.map((e) => `<tr><td class="mono">${esc(short(e.id))}${e.linked ? "" : ' <span class="dim">(not linked)</span>'}</td><td>${fmt(e.amount)}</td></tr>`).join("")}</table>` : `<div class="dim">No one has mined yet.</div>`}
    </div>
  </div>
  <div class="panel" style="margin-top:16px">
    <h3>Recent blocks</h3>
    ${t.recentDraws.length ? `<table><tr><th>KittyMine block</th><th>Winner</th><th>Amount</th><th>Eligible</th><th></th></tr>${t.recentDraws.slice(0, 25).map((d) => `<tr><td>#${d.height} <span class="dim">${esc(d.source)}</span></td><td class="mono">${esc(short(d.winner))}</td><td>${fmt(d.amount)}</td><td>${d.candidates}</td><td class="dim">${ago(d.at)}</td></tr>`).join("")}</table>` : `<div class="dim">Waiting for the first block…</div>`}
  </div>`;
}

// ---------- mine ----------
async function renderMine() {
  app.innerHTML = `<h1 style="font-size:36px">Mine coins by playing</h1>
  <div class="two">
    <div class="panel steps">
      <div class="step"><b>1</b><div><strong>Friend KittyMine</strong><div class="dim">Add <a href="https://steamcommunity.com/profiles/${STEAM_PRODUCER}" target="_blank" rel="noopener">KittyMineCoin on Steam</a> or <strong>${XBOX_PRODUCER_NAME}</strong> on Xbox, and wait for them to accept.</div></div></div>
      <div class="step"><b>2</b><div><strong>Make your profile public</strong><div class="dim">Steam: Privacy settings → profile and game details Public. Launch games through Steam itself.</div></div></div>
      <div class="step"><b>3</b><div><strong>Play</strong><div class="dim">Every KittyMine block, each coin picks a winner among friends playing its games. Earnings wait for you until you link a wallet.</div></div></div>
      <div class="step"><b>4</b><div><strong>Link your wallet & claim</strong><div class="dim">Prove the Steam account is yours with a short code in your profile name. No password needed.</div></div></div>
    </div>
    <div class="panel">
      <h3>Link your Steam account</h3>
      <div class="field"><label>Your SteamID64</label><input type="text" id="sid" placeholder="7656119…" inputmode="numeric" />
        <div class="hint">Find it at steamid.io (17 digits starting with 7656). Xbox linking is coming soon.</div></div>
      <button class="btn" id="linkbtn">${wallet ? "Get my link code" : "Connect wallet to link"}</button>
      <div id="linkout" style="margin-top:14px"></div>
    </div>
  </div>
  <div class="panel" style="margin-top:16px">
    <h3>Your earnings</h3>
    <div id="earn" class="dim">${wallet ? "Loading…" : "Connect your wallet to see what you can claim."}</div>
  </div>`;
  $("#linkbtn").onclick = async () => {
    try {
      if (!wallet) await connect();
      const id = $("#sid").value.trim();
      const r = await api("link", { gamingId: id, wallet });
      $("#linkout").innerHTML = `<div>Put this code anywhere in your <strong>${esc(r.where)}</strong>:</div>
        <div style="margin:10px 0"><span class="code">${esc(r.code)}</span></div>
        <div class="dim" id="linkstatus">Waiting for the code to show up (checked about every 30 seconds)…</div>`;
      pollLink(id);
    } catch (e) {
      toast(e.message, true);
    }
  };
  if (wallet) loadEarnings();
}

async function pollLink(id) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const p = await api(`player/${id}`).catch(() => null);
    const el = $("#linkstatus");
    if (!el) return;
    if (p?.wallet === wallet) {
      el.innerHTML = `<span style="color:var(--accent)">✓ Linked! You can change your profile name back now.</span>`;
      loadEarnings();
      return;
    }
  }
}

async function loadEarnings() {
  const el = $("#earn");
  if (!el) return;
  const w = await api(`wallet/${wallet}`).catch(() => null);
  if (!w) return void (el.textContent = "Couldn't load earnings.");
  if (w.ids.length === 0) return void (el.textContent = "No gaming account linked to this wallet yet.");
  el.innerHTML = `<div class="hint" style="margin:0 0 10px">Linked: ${w.ids.map((i) => `<span class="mono">${esc(i)}</span>`).join(", ")}</div>` +
    (w.tokens.length
      ? `<table><tr><th>Coin</th><th>Claimable</th><th></th></tr>${w.tokens.map((t) => `<tr><td>${esc(t.name)} <span class="dim">$${esc(t.symbol)}</span></td><td>${fmt(t.claimable)}</td><td><button class="btn small" data-claim="${esc(t.mint)}">Claim</button></td></tr>`).join("")}</table>`
      : `<div>Nothing to claim yet. Keep playing!</div>`);
  el.querySelectorAll("[data-claim]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api("claim", { wallet, mint: b.dataset.claim });
        toast(`Claimed ${fmt(r.amount)}!`);
        loadEarnings();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    };
  });
}
