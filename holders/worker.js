// $GTA6 holder rewards worker.
//
// Every SNAP_SEC (60s) it snapshots the top TOP_N (100) holders of MINT.
// Every SEND_SEC (300s) it:
//   1. claims the coin's pump.fun creator fees (sweep + distribute_creator_fees); the fee-sharing
//      config sends this wallet its 50% share, paid in the quote token (TTWO)
//   2. tops up its own SOL for gas by swapping a little TTWO, if SOL is low
//   3. splits everything new in the wallet over the minute snapshots since the last round:
//      per snapshot, holder share = holder balance / total held by that snapshot's top 100
//   4. sends every holder whose running total is >= MIN_SEND; smaller amounts carry over
// Everything (snapshots, shares, transactions, totals) is served at GET /api/state for the site.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { OnlinePumpSdk, bondingCurvePda, canonicalPumpPoolPda, feeSharingConfigPda, creatorVaultPda, GLOBAL_PDA, PUMP_EVENT_AUTHORITY_PDA, PUMP_PROGRAM_ID } = require('@pump-fun/pump-sdk');

const env = (k, d) => process.env[k] ?? d;
const MINT = env('MINT') ? new PublicKey(env('MINT')) : null; // set once the coin is live
const QUOTE = new PublicKey(env('QUOTE_MINT', 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo')); // TTWO (Backpack)
const QUOTE_SYMBOL = env('QUOTE_SYMBOL', 'TTWO');
const HELIUS = env('HELIUS_API_KEY');
const RPC = env('RPC_URL', HELIUS ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS}` : 'https://api.mainnet-beta.solana.com');
const SNAP_SEC = +env('SNAP_SEC', 60);
const SEND_SEC = +env('SEND_SEC', 300);
const TOP_N = +env('TOP_N', 100);
const MIN_SEND_USD = +env('MIN_SEND_USD', 0.1);          // smaller running totals carry over to the next round
const GAS_LOW_SOL = +env('GAS_LOW_SOL', 0.05);           // below this, swap TTWO -> SOL
const GAS_TOPUP_SOL = +env('GAS_TOPUP_SOL', 0.1);
const PER_TX = +env('PER_TX', 7);                        // recipients per transaction (ATA create + transfer each)
const DRY_RUN = env('DRY_RUN') === '1';
const PORT = +env('PORT', 8080);
const STATE_FILE = env('STATE_FILE', path.join(__dirname, 'data', 'state.json'));
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function loadKey() {
  const raw = env('HOLDERS_KEY') || fs.readFileSync(env('HOLDERS_KEY_FILE', path.join(__dirname, '..', 'relay', 'keys', 'holders-mainnet.json')), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}
const wallet = loadKey();
const conn = new Connection(RPC, 'confirmed');
const pump = new OnlinePumpSdk(conn);

// wallets that never get holder rewards: pump curve/pool/fee config, this wallet, plus EXCLUDE (dev, buyback, reward pools)
const EXCLUDED = new Set([wallet.publicKey.toBase58(), ...env('EXCLUDE', '').split(',').map((s) => s.trim()).filter(Boolean)]);
if (MINT) for (const k of [bondingCurvePda(MINT), canonicalPumpPoolPda(MINT), feeSharingConfigPda(MINT)]) EXCLUDED.add(k.toBase58());

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let QUOTE_PROGRAM, QUOTE_DEC = 6, MINT_DEC = 6, WALLET_ATA;

// ---------- persistent state ----------
const S = {
  owed: {},          // owner -> raw quote owed (string), carried until >= MIN_SEND
  snaps: [],         // minute snapshots since the last round
  rounds: [],        // newest first, last 300
  totals: { received: '0', paid: '0', gasSwapped: '0', rounds: 0, recipients: 0 },
  accounted: '0',    // quote already split into `owed`; anything above this in the wallet is new income
};
try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); log(`state loaded: ${S.rounds.length} rounds`); } catch { log('fresh state'); }
function save() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
const big = (x) => BigInt(x ?? 0);
const add = (k, v) => (S.totals[k] = (big(S.totals[k]) + big(v)).toString());
const owedTotal = () => Object.values(S.owed).reduce((a, v) => a + big(v), 0n);
const live = { top: [], supply: 0, priceUsd: 0, sol: 0, balance: '0', lastSnapAt: 0, nextSendAt: 0, lastError: null, startedAt: Date.now() };

// ---------- reads ----------
async function quoteBalance() {
  try { return big((await conn.getTokenAccountBalance(WALLET_ATA)).value.amount); } catch { return 0n; }
}
async function price() {
  try {
    const j = await fetch(`https://lite-api.jup.ag/price/v3?ids=${QUOTE.toBase58()},${SOL_MINT}`).then((r) => r.json());
    if (j?.[QUOTE.toBase58()]?.usdPrice > 0) live.priceUsd = j[QUOTE.toBase58()].usdPrice;
    if (j?.[SOL_MINT]?.usdPrice > 0) live.solUsd = j[SOL_MINT].usdPrice;
  } catch { /* keep last */ }
}
const onCurveCache = new Map();
const isWallet = (owner) => {
  if (!onCurveCache.has(owner)) onCurveCache.set(owner, PublicKey.isOnCurve(new PublicKey(owner).toBytes()));
  return onCurveCache.get(owner); // PDAs (pools, vaults, programs) are off-curve
};
async function holderBalances() {
  const owners = new Map();
  const addTo = (o, amt) => owners.set(o, (owners.get(o) ?? 0n) + big(amt));
  if (HELIUS) {
    for (let page = 1; page <= 50; page++) {
      const j = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: MINT.toBase58(), page, limit: 1000 } }) }).then((r) => r.json());
      if (j.error) throw new Error('getTokenAccounts: ' + j.error.message);
      const accs = j.result?.token_accounts ?? [];
      for (const a of accs) addTo(a.owner, a.amount);
      if (accs.length < 1000) break;
    }
  } else {
    const prog = (await conn.getAccountInfo(MINT)).owner;
    const accs = await conn.getParsedProgramAccounts(prog, { filters: [{ memcmp: { offset: 0, bytes: MINT.toBase58() } }] });
    for (const a of accs) { const i = a.account.data.parsed?.info; if (i) addTo(i.owner, i.tokenAmount.amount); }
  }
  return owners;
}
async function snapshot() {
  const owners = await holderBalances();
  const top = [...owners]
    .filter(([o, amt]) => amt > 0n && !EXCLUDED.has(o) && isWallet(o))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : 1))
    .slice(0, TOP_N);
  const total = top.reduce((a, [, v]) => a + v, 0n);
  const list = top.map(([o, v]) => [o, v.toString()]);
  const snap = { t: Date.now(), total: total.toString(), list, hash: sha(JSON.stringify(list)) };
  S.snaps.push(snap);
  S.snaps = S.snaps.slice(-Math.ceil((SEND_SEC * 3) / SNAP_SEC)); // never let a stuck round grow forever
  if (!live.supply) live.supply = Number((await conn.getTokenSupply(MINT)).value.amount);
  live.top = list.map(([owner, amount], i) => ({
    rank: i + 1, owner, amount,
    supplyPct: live.supply ? +((Number(amount) / live.supply) * 100).toFixed(4) : null,
    sharePct: total > 0n ? +((Number(amount) / Number(total)) * 100).toFixed(4) : 0,
  }));
  live.topTotalPct = live.supply ? +((Number(total) / live.supply) * 100).toFixed(3) : null;
  live.lastSnapAt = snap.t;
  save();
}

// ---------- writes ----------
async function send(ixs, label) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  tx.feePayer = wallet.publicKey;
  if (DRY_RUN) { log(`[dry-run] ${label}`); return 'dry-run'; }
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed', maxRetries: 5 });
}
// pump `sweep_creator_fee`: on token-quoted coins the curve holds creator fees until this moves them to the vault
function sweepIx() {
  const curve = bondingCurvePda(MINT), cv = creatorVaultPda(feeSharingConfigPda(MINT));
  const k = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    data: crypto.createHash('sha256').update('global:sweep_creator_fee').digest().subarray(0, 8),
    keys: [k(wallet.publicKey, true, true), k(GLOBAL_PDA), k(MINT), k(QUOTE), k(QUOTE_PROGRAM), k(ASSOCIATED_TOKEN_PROGRAM_ID), k(SystemProgram.programId),
      k(curve, true), k(getAssociatedTokenAddressSync(QUOTE, curve, true, QUOTE_PROGRAM), true),
      k(cv, true), k(getAssociatedTokenAddressSync(QUOTE, cv, true, QUOTE_PROGRAM), true),
      k(PUMP_EVENT_AUTHORITY_PDA), k(PUMP_PROGRAM_ID)],
  });
}
async function claimFees() {
  let pending = 0;
  try {
    const b = (await pump.getCreatorVaultQuoteBalances(feeSharingConfigPda(MINT))).find((x) => x.mint.equals(QUOTE));
    pending = b ? b.total.toNumber() : 0;
    const d = (await conn.getAccountInfo(bondingCurvePda(MINT)))?.data;
    if (d && d.length >= 133) pending += Number(d.readBigUInt64LE(125)); // unswept fees still in the curve
  } catch { /* after graduation the curve read can fail; still try distribute */ }
  live.pendingFees = pending;
  // every 6th round, try anyway: if fees sit somewhere our read doesn't see, distribute still moves them
  if (pending <= 0 && S.totals.rounds % 6 !== 5) return null;
  const { instructions } = await pump.buildDistributeCreatorFeesInstructions(MINT, { quoteMint: QUOTE, quoteTokenProgram: QUOTE_PROGRAM, payer: wallet.publicKey });
  const pre = [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, WALLET_ATA, wallet.publicKey, QUOTE, QUOTE_PROGRAM)];
  try {
    return await send([...pre, ...instructions], 'distribute');
  } catch (e) {
    if (!/6095|0x17cf|CreatorFeesNotSwept/.test(String(e.message) + JSON.stringify(e.logs ?? ''))) throw e;
    return send([...pre, sweepIx(), ...instructions], 'sweep+distribute');
  }
}
// sell a little TTWO for SOL through Jupiter when gas runs low; returns raw TTWO spent
async function gasTopUp() {
  const lamports = await conn.getBalance(wallet.publicKey);
  live.sol = lamports / LAMPORTS_PER_SOL;
  if (live.sol >= GAS_LOW_SOL || !live.priceUsd || !live.solUsd) return 0n;
  const raw = BigInt(Math.ceil(((GAS_TOPUP_SOL * live.solUsd) / live.priceUsd) * 10 ** QUOTE_DEC));
  const bal = await quoteBalance();
  if (raw > bal - owedTotal() || raw <= 0n) { log(`gas low (${live.sol} SOL) and not enough new ${QUOTE_SYMBOL} to swap; top up ${wallet.publicKey.toBase58()}`); return 0n; }
  if (DRY_RUN) { log(`[dry-run] swap ${raw} raw ${QUOTE_SYMBOL} -> SOL`); return 0n; }
  try {
    const q = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${QUOTE.toBase58()}&outputMint=${SOL_MINT}&amount=${raw}&slippageBps=150`).then((r) => r.json());
    if (!q.outAmount) throw new Error(q.error ?? 'no route');
    const { swapTransaction } = await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) }).then((r) => r.json());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await conn.confirmTransaction(sig, 'confirmed');
    log(`gas top-up: ${raw} raw ${QUOTE_SYMBOL} -> ${q.outAmount} lamports ${sig}`);
    add('gasSwapped', raw);
    return raw;
  } catch (e) { log('gas top-up failed:', e.message); return 0n; }
}

async function round() {
  const r = { at: Date.now(), claimSig: null, income: '0', snaps: 0, snapshotHashes: [], payouts: [], carried: '0', errors: [] };
  try { r.claimSig = await claimFees(); } catch (e) { if (live.pendingFees > 0) r.errors.push('claim: ' + String(e.message).slice(0, 200)); else log('forced claim found nothing:', String(e.message).slice(0, 120)); }
  await sleep(1500);
  await gasTopUp();
  const bal = await quoteBalance();
  live.balance = bal.toString();
  // new income = wallet balance minus what's already promised to holders
  const income = bal - owedTotal();
  const snaps = S.snaps.splice(0);
  r.snaps = snaps.length;
  r.snapshotHashes = snaps.map((s) => s.hash);
  if (income > 0n && snaps.length) {
    r.income = income.toString();
    add('received', income);
    const perSnap = income / BigInt(snaps.length);
    for (const s of snaps) {
      const total = big(s.total);
      if (total === 0n) continue;
      for (const [o, amt] of s.list) S.owed[o] = (big(S.owed[o]) + (perSnap * big(amt)) / total).toString();
    }
  }
  const minRaw = live.priceUsd ? BigInt(Math.ceil((MIN_SEND_USD / live.priceUsd) * 10 ** QUOTE_DEC)) : 1n;
  const due = Object.entries(S.owed).filter(([, v]) => big(v) >= minRaw && big(v) > 0n).sort((a, b) => (big(b[1]) > big(a[1]) ? 1 : -1));
  for (let i = 0; i < due.length; i += PER_TX) {
    const batch = due.slice(i, i + PER_TX);
    const ixs = [];
    for (const [o, v] of batch) {
      const owner = new PublicKey(o);
      const ata = getAssociatedTokenAddressSync(QUOTE, owner, false, QUOTE_PROGRAM);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, owner, QUOTE, QUOTE_PROGRAM));
      ixs.push(createTransferCheckedInstruction(WALLET_ATA, QUOTE, ata, wallet.publicKey, big(v), QUOTE_DEC, [], QUOTE_PROGRAM));
    }
    ixs.push(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`GTA6 holders|r=${S.totals.rounds + 1}`) }));
    try {
      const sig = await send(ixs, `pay ${batch.length}`);
      for (const [o, v] of batch) {
        r.payouts.push({ owner: o, amount: v, sig });
        if (!DRY_RUN) { delete S.owed[o]; add('paid', v); }
      }
    } catch (e) { r.errors.push('pay: ' + e.message.slice(0, 200)); }
  }
  r.carried = owedTotal().toString();
  S.totals.rounds++;
  S.totals.recipients += r.payouts.length;
  S.rounds.unshift(r);
  S.rounds = S.rounds.slice(0, 300);
  save();
  log(`round ${S.totals.rounds}: income ${r.income}, ${r.snaps} snaps, paid ${r.payouts.length}, carried ${r.carried}${r.errors.length ? ' errors: ' + r.errors.join('; ') : ''}`);
}

// ---------- HTTP ----------
http.createServer((req, res) => {
  const ok = (data) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (req.url.startsWith('/api/state')) {
    return ok({
      live: Boolean(MINT), mint: MINT?.toBase58() ?? null, wallet: wallet.publicKey.toBase58(), quoteMint: QUOTE.toBase58(), quoteSymbol: QUOTE_SYMBOL, quoteDecimals: QUOTE_DEC,
      pendingFees: live.pendingFees ?? 0, topN: TOP_N, snapSec: SNAP_SEC, sendSec: SEND_SEC, minSendUsd: MIN_SEND_USD, priceUsd: live.priceUsd, sol: live.sol,
      balance: live.balance, owedTotal: owedTotal().toString(), totals: S.totals, topTotalPct: live.topTotalPct ?? null, top: live.top,
      lastSnapAt: live.lastSnapAt, nextSendAt: live.nextSendAt, rounds: S.rounds.slice(0, 50), excluded: [...EXCLUDED],
    });
  }
  if (req.url.startsWith('/api/owed/')) {
    const o = decodeURIComponent(req.url.slice('/api/owed/'.length));
    return ok({ owner: o, owed: S.owed[o] ?? '0', rank: live.top.find((x) => x.owner === o) ?? null });
  }
  res.writeHead(404).end();
}).listen(PORT, () => log(`http :${PORT}`));

// ---------- main ----------
(async () => {
  log(`holder wallet ${wallet.publicKey.toBase58()}, quote ${QUOTE_SYMBOL} ${QUOTE.toBase58()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const qi = await conn.getAccountInfo(QUOTE);
  QUOTE_PROGRAM = qi.owner;
  QUOTE_DEC = qi.data[44];
  WALLET_ATA = getAssociatedTokenAddressSync(QUOTE, wallet.publicKey, false, QUOTE_PROGRAM);
  if (!MINT) { log('MINT not set yet: serving status only. Set the MINT secret once the coin is live.'); return; }
  log(`coin ${MINT.toBase58()}, top ${TOP_N}, snapshot every ${SNAP_SEC}s, send every ${SEND_SEC}s, excluded ${EXCLUDED.size}`);
  let nextSnap = 0;
  live.nextSendAt = Date.now() + SEND_SEC * 1000;
  for (;;) {
    try {
      if (Date.now() >= nextSnap) {
        nextSnap = Date.now() + SNAP_SEC * 1000;
        await price();
        await snapshot();
      }
      if (Date.now() >= live.nextSendAt) {
        live.nextSendAt = Date.now() + SEND_SEC * 1000;
        await round();
      }
      live.lastError = null;
    } catch (e) { live.lastError = e.message; log('loop error:', e.message); }
    await sleep(2000);
  }
})();
