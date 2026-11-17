// $GGG play-to-earn site. Plain JS; talks to the KMC relay at /api.
// Which coin this site is for comes from the relay (SITE_MINT in relay/.env).
const SITE = await fetch("/api/site").then((r) => r.json()).catch(() => ({}));
const MINT = SITE.mint ?? "CbNEGX1EqVy1BQN12NbanuCubvWZULBztXwNd7QDpump";
const SYM = SITE.symbol ?? "GGG";
// swap the $GGG placeholder in the page's static text for the live symbol
if (SYM !== "GGG") {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode()); ) if (n.nodeValue.includes("GGG")) n.nodeValue = n.nodeValue.replaceAll("GGG", SYM);
  document.title = document.title.replaceAll("GGG", SYM);
}
const STEAM_PRODUCER = "76561198779127606"; // KittyMine's Steam account
const DEC = 6;

const $ = (s) => document.querySelector(s);
const set = (s, v) => { const e = $(s); if (e) e.textContent = v; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tokens = (raw, dec = DEC) => Number(BigInt(raw ?? 0)) / 10 ** dec;
const fmt = (raw) => {
  const n = typeof raw === "number" ? raw : tokens(raw);
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toFixed(n < 10 ? 2 : 0);
};
const full = (raw, dec = DEC) => tokens(raw, dec).toLocaleString(undefined, { maximumFractionDigits: 2 });
const short = (s) => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const ago = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), bad ? 8000 : 4000);
}

async function api(path, body) {
  const r = await fetch("/api/" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return data;
}
const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast("Couldn't copy", true));

// the stash lives on /play now; Steam login still returns to /ggg/#account
const PAGE = document.body.dataset.page ?? "home";
if (PAGE === "home" && location.hash === "#account") location.replace("/play" + location.search + "#account");

// static links
document.querySelectorAll("[data-buy]").forEach((a) => (a.href = `https://pump.fun/coin/${MINT}`));
set("#ca", MINT);
const clock = () => set("#phone-time", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
clock();
setInterval(clock, 15_000);
document.querySelectorAll("[data-producer]").forEach((a) => (a.href = `https://steamcommunity.com/profiles/${STEAM_PRODUCER}`));
if ($("#copy")) $("#copy").onclick = () => copy(MINT, "Contract address");
document.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, b.dataset.what ?? "Copied text")));

// errors coming back from "Sign in through Steam"
const qs = new URLSearchParams(location.search);
if (qs.get("login_error")) {
  toast(qs.get("login_error"), true);
  history.replaceState(null, "", location.pathname + location.hash);
}

// ---------- live stats + payouts ----------
async function refresh() {
  const [t, ingame, cfg] = await Promise.all([
    api(`tokens/${MINT}`).catch(() => null),
    api("ingame").catch(() => null),
    refresh.cfg ? Promise.resolve(refresh.cfg) : api("config").catch(() => null),
  ]);
  refresh.cfg = cfg;
  if (cfg?.escrow && $("#escrow")) {
    const a = $("#escrow");
    a.textContent = cfg.escrow;
    a.href = `https://solscan.io/account/${cfg.escrow}`;
  }
  refresh.t = t;
  refresh.ingame = ingame;
  if (!t) {
    if ($("#draws")) $("#draws").textContent = "Rewards server is offline right now. Try again in a bit.";
    return;
  }
  const left = tokens(t.pool) - tokens(t.distributed);
  // fixed amount per win (perDraw) or the old time-based drip
  const perDay = t.perDraw ? tokens(t.perDraw) : tokens(t.pool) / (t.periodMs / 86_400_000);
  const gameIds = new Set(t.games.steam);
  const xboxNames = t.games.xbox ?? [];
  const playing = (ingame?.Steam ?? []).filter((p) => gameIds.has(String(p.gameId))).length + (ingame?.Xbox ?? []).filter((p) => xboxNames.some((n) => String(p.gameId ?? "").toLowerCase().includes(n))).length;
  set("#s-left", fmt(Math.max(0, left)));
  set("#hud-cash", Math.floor(Math.max(0, left)).toLocaleString("en-US"));
  set("#s-rate", fmt(perDay));
  set("#s-playing", String(playing));
  set("#s-earners", String(t.players));
  if (!$("#draws")) return;

  const d = t.recentDraws ?? [];
  $("#draws").innerHTML = d.length
    ? d
        .slice(0, 8)
        .map(
          (x) => `<div class="notif"><div class="notif-ic">$</div><div class="notif-b">
            <div class="notif-h"><span>${esc(x.source)} · block #${x.height}</span><span>${ago(x.at)}</span></div>
            <div class="notif-t">Winner paid <span class="amt">+${fmt(x.amount)} $${SYM}</span></div>
            <div class="dim">${esc(short(x.winner))} · ${x.candidates} in the draw</div></div></div>`,
        )
        .join("")
    : `<div class="notif"><div class="notif-ic">$</div><div class="notif-b"><div class="notif-t">No wins yet</div><div class="dim">Be the first: hop into GTA.</div></div></div>`;
}
refresh();
setInterval(refresh, 30_000);

// ---------- account (log in with Steam) ----------
let me = null;
const STEAM_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15.5" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="15.5" r="2.2" fill="currentColor"/><path d="M8.5 15.5 15.5 9" stroke="currentColor" stroke-width="2"/></svg>`;

function parseSteamId(s) {
  const m = s.trim().match(/(7656\d{13})/);
  return m ? m[1] : null;
}

async function loadAccount() {
  if (!$("#acct")) {
    me = await api("me").catch(() => null);
    set("#loginbtn", me ? "My account" : "Log in");
    return;
  }
  try {
    me = await api("me");
  } catch (e) {
    me = null;
    if (e.status !== 401) {
      $("#acct").innerHTML = `<span class="dim">Account server is offline right now.</span>`;
      return;
    }
  }
  set("#loginbtn", me ? "My account" : "Log in");
  me ? renderAccount() : renderLogin();
  if (me && $("#chkid") && !$("#chkid").value) $("#chkid").value = me.id;
}

function renderLogin(only) {
  $("#acct").innerHTML = `${only ? `<div class="acct-switch"><button class="btn small ghost" id="backstash">← Back to my stash</button></div><p class="kicker" style="margin-top:0">Add your ${only === "xbox" ? "Xbox" : "Steam"} account</p>` : ""}<div class="acct-grid${only ? " one" : ""}">
    <div${only === "xbox" ? " hidden" : ""}>
      <h2>Steam</h2>
      <p class="dim" style="margin-top:0">Log in to collect your winnings. You get your own $${SYM} wallet automatically; no Phantom or crypto setup needed.</p>
      <a class="btn steam-btn" href="/api/auth/steam">${STEAM_ICON} Sign in through Steam</a>
      <p class="hint">Opens Steam's own login page. We never see your password.</p>
      <div class="or">or use a login code</div>
      <label for="sid">Your SteamID64 or profile link</label>
      <div class="row2"><input id="sid" type="text" placeholder="76561198…" autocomplete="off" /><button class="btn" id="codebtn">Get code</button></div>
      <p class="hint">You'll put the code in your Steam Real Name. Find your ID at steamid.io.</p>
      <div id="codeout"></div>
    </div>
    <div${only === "steam" ? " hidden" : ""}>
      <h2>Xbox</h2>
      <p class="dim" style="margin-top:0">Friend <strong>TheKittyMine</strong> on Xbox first, then log in with your gamertag.</p>
      <label for="xgt">Your Xbox gamertag</label>
      <div class="row2"><input id="xgt" type="text" placeholder="Gamertag" autocomplete="off" /><button class="btn xbox-btn" id="xcodebtn">Log in with Xbox</button></div>
      <p class="hint">You get a short code to put in your Xbox Bio (Xbox app → Profile → Customize → Bio). Remove it after you're logged in.</p>
      <div id="xcodeout"></div>
    </div>
  </div>`;
  if (only) $("#backstash").onclick = () => renderAccount();
  $("#codebtn").onclick = () => startCode("#sid", "#codeout", "#xcodeout");
  $("#xcodebtn").onclick = () => startCode("#xgt", "#xcodeout", "#codeout");
}

async function startCode(inSel, outSel, otherSel) {
  const input = $(inSel).value.trim();
  if (!input) return toast(inSel === "#xgt" ? "Enter your Xbox gamertag." : "Enter your SteamID64.", true);
  try {
    const r = await api("auth/code", { id: inSel === "#sid" ? (parseSteamId(input) ?? input) : input });
    const id = r.id;
    $(otherSel).innerHTML = "";
    $(outSel).innerHTML = `<div style="margin-top:6px">Put this in your <strong>${esc(r.where)}</strong>, then save:</div>
      <div class="code">${esc(r.code)}</div> <button class="btn small ghost" id="copycode">Copy</button>
      <div class="dim" id="codestatus" style="margin-top:8px">Waiting for the code to show up on your profile…</div>`;
    $("#copycode").onclick = () => copy(r.code, "Code");
    pollCode(id, r.code, r.expiresAt);
  } catch (e) {
    toast(e.message, true);
  }
}

async function pollCode(id, code, exp) {
  pollCode.run = (pollCode.run ?? 0) + 1;
  const run = pollCode.run;
  while (Date.now() < exp && run === pollCode.run) {
    await sleep(10_000);
    if (!$("#codestatus") || run !== pollCode.run) return;
    try {
      const r = await api("auth/check", { id, code });
      if (r.ok) {
        toast("Logged in! You can remove the code from your profile now.");
        return loadAccount();
      }
    } catch (e) {
      $("#codestatus").textContent = e.message;
      return;
    }
  }
  if ($("#codestatus")) $("#codestatus").textContent = "Code expired. Get a new one.";
}

function renderAccount() {
  const g = me.tokens.find((t) => t.mint === MINT) ?? { winnings: "0", balance: "0", decimals: DEC, symbol: SYM };
  const hasWin = BigInt(g.winnings) > 0n;
  const otherName = me.platform === "xbox" ? "Steam" : "Xbox";
  const switchBar = `<div class="acct-switch">
      <span class="plat-badge ${me.platform}">${me.platform === "xbox" ? "Xbox" : "Steam"}</span>
      ${me.other
        ? `<button class="btn small ${me.other.platform === "xbox" ? "xbox-btn" : "steam-btn"}" id="switchacct">Switch to ${otherName} ⇄</button>`
        : `<button class="btn small ghost" id="addacct">+ Add ${otherName}</button>`}
    </div>`;
  $("#acct").innerHTML = `${switchBar}<div class="acct-grid">
    <div>
      <h2>Your $${SYM}</h2>
      <div class="subrow"><span class="dim">Winnings to collect</span><strong>${full(g.winnings, g.decimals)} $${SYM}</strong></div>
      <button class="btn" id="collect" ${hasWin ? "" : "disabled"} style="margin:6px 0 16px">Collect into my wallet</button>
      <div class="subrow"><span class="dim">In your wallet</span><span class="big" style="margin:0;font-size:34px">${full(g.balance, g.decimals)}</span></div>
      <div class="subrow"><span class="dim">Wallet</span><span><span class="mono">${esc(short(me.wallet))}</span> <button class="linkish" id="copyw">copy</button> · <a href="https://solscan.io/account/${esc(me.wallet)}" target="_blank" rel="noopener">Solscan</a></span></div>
      <div class="subrow"><span class="dim">${me.platform === "xbox" ? "Xbox" : "Steam"}</span><span><span class="mono">${esc(me.id)}</span> · <button class="linkish" id="logout">Log out</button></span></div>
    </div>
    <div>
      <h2>Withdraw</h2>
      <label for="wto">Send to (any Solana wallet, e.g. Phantom)</label>
      <input id="wto" type="text" placeholder="Wallet address" autocomplete="off" />
      <label for="wamt" style="margin-top:12px">Amount ($${SYM})</label>
      <div class="row2"><input id="wamt" type="text" inputmode="decimal" placeholder="0" autocomplete="off" /><button class="btn small ghost" id="wmax">Max</button></div>
      <button class="btn" id="wgo" style="margin-top:12px" ${BigInt(g.balance) > 0n ? "" : "disabled"}>Withdraw</button>
      <p class="hint">No SOL needed. We pay the network fee. Max 10 withdrawals a day.</p>
      ${me.withdrawals.length ? `<div class="tablewrap"><table><tr><th>Sent</th><th>To</th><th></th></tr>${me.withdrawals.map((w) => `<tr><td>${full(w.amount, g.decimals)}</td><td class="mono">${esc(short(w.to))}</td><td><a href="https://solscan.io/tx/${esc(w.sig)}" target="_blank" rel="noopener">tx</a></td></tr>`).join("")}</table></div>` : ""}
      <div class="or">advanced</div>
      <button class="linkish danger" id="export">Export private key${me.exported ? " (exported before)" : ""}</button>
      <div id="exportout"></div>
    </div>
  </div>`;
  $("#copyw").onclick = () => copy(me.wallet, "Wallet address");
  if ($("#switchacct")) $("#switchacct").onclick = async () => {
    try {
      await api("auth/switch", {});
      await loadAccount();
      toast(`Switched to your ${me.platform === "xbox" ? "Xbox" : "Steam"} account`);
    } catch (e) {
      toast(e.message, true);
    }
  };
  if ($("#addacct")) $("#addacct").onclick = () => renderLogin(me.platform === "xbox" ? "steam" : "xbox");
  $("#logout").onclick = async () => {
    await api("auth/logout", {}).catch(() => {});
    await loadAccount();
    if (me) toast(`Logged out. You're on your ${me.platform === "xbox" ? "Xbox" : "Steam"} account now.`);
  };
  $("#collect").onclick = async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Collecting…";
    try {
      const r = await api("me/collect", { mint: MINT });
      toast(`Collected ${full(r.amount)} $${SYM} into your wallet!`);
    } catch (e) {
      toast(e.message, true);
    }
    loadAccount();
  };
  $("#wmax").onclick = () => ($("#wamt").value = String(tokens(g.balance, g.decimals)));
  $("#wgo").onclick = async (ev) => {
    const to = $("#wto").value.trim();
    const amt = $("#wamt").value.trim().replace(",", ".");
    if (!to) return toast("Paste the wallet address to send to.", true);
    if (!(Number(amt) > 0)) return toast("Enter an amount.", true);
    const isMax = Number(amt) >= tokens(g.balance, g.decimals);
    if (!confirm(`Send ${amt} $${SYM} to ${to}?\n\nDouble-check the address: sends can't be undone.`)) return;
    ev.target.disabled = true;
    ev.target.textContent = "Sending…";
    try {
      const r = await api("me/withdraw", { mint: MINT, to, amount: isMax ? "all" : amt });
      toast(`Sent ${full(r.amount)} $${SYM}!`);
    } catch (e) {
      toast(e.message, true);
    }
    loadAccount();
  };
  $("#export").onclick = () => {
    $("#exportout").innerHTML = `<div class="secret">
        <strong>Anyone with this key owns your wallet.</strong> Never share it or paste it into a website. Only import it into a wallet app like Phantom (Add account → Import private key).
      </div>
      <button class="btn small" id="reveal">I understand, show my key</button>`;
    $("#reveal").onclick = async () => {
      try {
        const r = await api("me/export", { confirm: "EXPORT" });
        $("#exportout").innerHTML = `<div class="secret mono" id="sk">${esc(r.secretKey)}</div>
          <button class="btn small ghost" id="copysk">Copy key</button> <button class="btn small ghost" id="hidesk">Hide</button>`;
        $("#copysk").onclick = () => copy(r.secretKey, "Private key");
        $("#hidesk").onclick = () => ($("#exportout").innerHTML = "");
      } catch (e) {
        toast(e.message, true);
      }
    };
  };
}
loadAccount();
setInterval(() => {
  // refresh balances, but don't wipe a half-typed withdrawal or a shown key
  if (me && $("#wto") && !$("#wto")?.value && !$("#wamt")?.value && !$("#sk")) loadAccount();
}, 60_000);

// ---------- KMCoin -> $GGG trade ----------
async function loadTrades() {
  if (!$("#trade")) return;
  const d = await api("trades").catch(() => null);
  const sec = $("#trade");
  if (!d) return void (sec.hidden = true);
  sec.hidden = false;
  $("#trate").textContent = Number(d.rate).toLocaleString("en-US");
  $("#copytw").onclick = () => copy(d.kmcWallet, "KittyMine wallet number");
  if (d.available !== null) {
    const left = tokens(d.available);
    $("#tavail").textContent = `Trade pool: ${fmt(left)} $${SYM} available (enough for ${fmt(left / d.rate)} KMCoin).`;
  }
  const label = { resolving: "confirming sender…", "waiting-funds": "waiting for pool top-up", credited: "✓ credited", unclaimable: "no Steam/Xbox account" };
  $("#tlist").innerHTML = d.recent.length
    ? `<div class="tablewrap"><table><tr><th>Block</th><th>From</th><th>KMCoin</th><th>$${SYM}</th><th>Status</th></tr>${d.recent
        .map((x) => `<tr><td>#${x.height}</td><td class="mono">@${esc(x.fromWallet)}</td><td>${(Number(BigInt(x.kmc) / 10000000000n) / 10000).toLocaleString("en-US")}</td><td>${fmt(x.out)}</td><td class="${x.status === "credited" ? "ok" : "dim"}">${label[x.status] ?? x.status}</td></tr>`)
        .join("")}</table></div>`
    : `<span class="dim">No trades yet.</span>`;
}
loadTrades();
setInterval(loadTrades, 60_000);


// ---------- GTA VI on Xbox countdown (launches 00:00 local time, Nov 19 2026) ----------
(function gta6Clock() {
  if (!$("#gta6")) return;
  const launch = new Date(2026, 10, 19, 0, 0, 0).getTime();
  const pad = (n) => String(n).padStart(2, "0");
  const tick = () => {
    const ms = launch - Date.now();
    if (ms <= 0) {
      $("#gta6").classList.add("live");
      $("#g6title").textContent = "GTA VI is out: mine $" + SYM + " on Xbox now";
      $("#g6lead").textContent = "Every minute you play GTA VI on Xbox Series X|S puts you in the draw. Friend TheKittyMine on Xbox, log in with your gamertag, and play.";
      $("#g6clock").innerHTML = '<div class="cd" style="grid-column:1/-1"><span class="cdv">LIVE</span><span class="cdk">GTA VI counts on Xbox</span></div>';
      return true;
    }
    const s = Math.floor(ms / 1000);
    $("#cd-d").textContent = Math.floor(s / 86400);
    $("#cd-h").textContent = pad(Math.floor((s % 86400) / 3600));
    $("#cd-m").textContent = pad(Math.floor((s % 3600) / 60));
    $("#cd-s").textContent = pad(s % 60);
    return false;
  };
  if (!tick()) {
    const id = setInterval(() => tick() && clearInterval(id), 1000);
  }
})();

// ---------- "Am I in the draw?" checker (play page) ----------
if ($("#chkgo")) {
  $("#chkgo").onclick = async () => {
    const raw = $("#chkid").value.trim();
    const out = $("#chkout");
    if (!raw) return toast("Enter your SteamID64, or log in first.", true);
    const id = parseSteamId(raw) ?? raw;
    out.innerHTML = `<span class="dim">Checking…</span>`;
    const [ingame, t] = await Promise.all([api("ingame").catch(() => null), api(`tokens/${MINT}`).catch(() => null)]);
    if (!ingame || !t) return void (out.innerHTML = `<span class="bad-t">The rewards server didn't answer. Try again in a minute.</span>`);
    const all = [...(ingame.Steam ?? []).map((p) => ({ ...p, src: "Steam" })), ...(ingame.Xbox ?? []).map((p) => ({ ...p, src: "Xbox" }))];
    const p = all.find((x) => x.id === id);
    const steamIds = new Set(t.games.steam ?? []);
    const xboxNames = t.games.xbox ?? [];
    const counts = p && (p.src === "Steam" ? steamIds.has(String(p.gameId)) : xboxNames.some((n) => String(p.gameId ?? "").toLowerCase().includes(n)));
    if (counts) out.innerHTML = `<div class="chk ok"><b>✓ You're in the draw.</b> KittyMine sees you playing <strong>${esc(p.game)}</strong> on ${p.src}. Keep playing: a winner is drawn about every minute.</div>`;
    else if (p) out.innerHTML = `<div class="chk warn"><b>Almost.</b> KittyMine sees you, but you're playing <strong>${esc(p.game || "something else")}</strong>. Only GTA counts. Start GTA and check again in a minute.</div>`;
    else out.innerHTML = `<div class="chk bad"><b>We can't see you in a game right now.</b> Check that: (1) KittyMine accepted your friend request, (2) your game status is public, (3) GTA is running. Status updates about once a minute.${id.startsWith("7656") ? "" : " <br>Xbox players: log in first, then check. We need your Xbox ID, not your gamertag."}</div>`;
  };
}

// ---------- platform tabs (play page) ----------
const tabs = document.querySelectorAll("[data-tab]");
if (tabs.length) {
  const show = (name, scroll) => {
    tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
    if (scroll) $("#platform").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  tabs.forEach((b) => (b.onclick = () => { show(b.dataset.tab); history.replaceState(null, "", "#" + b.dataset.tab); }));
  const h = location.hash.slice(1);
  show(h === "xbox" ? "xbox" : "steam", h === "xbox" || h === "steam");
}

// ---------- tokenomics: live proof of holder payouts (home) ----------
if ($("#proof")) {
  const loadProof = async () => {
    const s = await fetch("/hapi/state").then((r) => r.json()).catch(() => null);
    if (!s) return void ($("#proof").innerHTML = `<tr><td colspan="4" class="dim">The payout server didn't answer. Try again in a minute.</td></tr>`);
    const q = (raw) => Number(BigInt(raw ?? 0)) / 10 ** (s.quoteDecimals ?? 6);
    const rounds = (s.rounds ?? []).filter((r) => r.payouts.length).slice(0, 6);
    $("#proof").innerHTML = rounds.length
      ? rounds.map((r) => {
          const total = q(r.payouts.reduce((a, p) => a + BigInt(p.amount), 0n));
          const txs = [...new Set(r.payouts.map((p) => p.sig))];
          const usd = s.priceUsd ? ` <span class="dim">($${(total * s.priceUsd).toFixed(2)})</span>` : "";
          return `<tr><td>${ago(r.at)}</td><td><strong>${total.toFixed(total >= 1 ? 3 : 5)} TTWO</strong>${usd}</td><td>${r.payouts.length}</td><td>${txs.map((t, i) => `<a target="_blank" rel="noopener" href="https://solscan.io/tx/${esc(t)}">tx ${i + 1}</a>`).join(" · ")}</td></tr>`;
        }).join("")
      : `<tr><td colspan="4" class="dim">No payouts yet. They start with the first trades.</td></tr>`;
  };
  loadProof();
  setInterval(loadProof, 60_000);
}
