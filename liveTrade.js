/**
 * Live swaps from the WORKER only (Railway, 24/7, no Phantom popup).
 * The private key MUST come from Railway Variables, never from GitHub.
 *
 * ENABLE_LIVE_TRADES=1   turn live trading on (anything else = off, only signals/logs)
 * PRIVATE_KEY=           base58 secret OR JSON array [1,2,3,...]
 *                        → use a SEPARATE wallet that only the bot uses, with a small amount
 *
 * Optional variables (defaults in brackets):
 * TRADE_AMOUNT_SOL (0.01)      SOL per buy
 * SLIPPAGE_BPS (300)           max slippage, 300 = 3%
 * MIN_SOL_RESERVE (0.01)       always keep this much SOL for fees
 * MAX_BUYS_PER_DAY (6)         stop buying after this many buys per UTC day
 * MAX_DAILY_LOSS_SOL (0.05)    stop buying for the rest of the UTC day after this loss
 * MIN_LIQUIDITY_USD (20000)    don't buy in pools with less liquidity
 * MAX_ROUND_TRIP_PCT (8)       don't buy if buying + selling right away would cost more than this (honeypot check)
 * SAFETY_CHECK (1)             check mint/freeze authority + round trip before every buy
 * PRIORITY_FEE_MAX_LAMPORTS (200000)  max priority fee per swap, helps transactions land
 * RPC_URL                      your own RPC (Helius/QuickNode) is much more reliable than the public one
 */
const web3 = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.decode ? bs58mod : bs58mod.default;   // bs58 v5 and v6 export differently

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_HOSTS = ['https://lite-api.jup.ag/swap/v1', 'https://api.jup.ag/swap/v1'];

function env(name, fallback){ const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' ? v : fallback; }
function liveEnabled(){
  const v = (process.env.ENABLE_LIVE_TRADES || '0').toLowerCase();
  return v === '1' || v === 'true';
}

let keypairCache = null;
function loadKeypair(){
  if (keypairCache) return keypairCache;
  const raw = (process.env.PRIVATE_KEY || '').trim();
  if (!raw || raw.includes('PASTE_') || raw === 'YOUR_PRIVATE_KEY_HERE') throw new Error('PRIVATE_KEY ontbreekt of is nog een placeholder');
  keypairCache = raw.startsWith('[')
    ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
    : web3.Keypair.fromSecretKey(bs58.decode(raw));
  return keypairCache;
}
let connCache = null;
function connection(){
  if (!connCache) connCache = new web3.Connection((process.env.RPC_URL || 'https://api.mainnet-beta.solana.com').trim(), 'confirmed');
  return connCache;
}

async function fetchJson(url, opts, ms = 15000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok){ const e = new Error(res.status + ' ' + text.slice(0, 200)); e.status = res.status; throw e; }
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}
// lite-api first; if it is gone (404/410/403/network), the keyless api.jup.ag
async function jup(path, opts){
  let lastErr;
  for (const host of JUP_HOSTS){
    try { return await fetchJson(host + path, opts); }
    catch (e){ lastErr = e; if (e.status && ![403, 404, 410].includes(e.status)) throw e; }
  }
  throw lastErr;
}
async function quote(inputMint, outputMint, amountRaw){
  const slip = env('SLIPPAGE_BPS', 300);
  return jup('/quote?inputMint=' + inputMint + '&outputMint=' + outputMint + '&amount=' + amountRaw + '&slippageBps=' + slip);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Build, sign, send AND wait for confirmation. Throws if the swap did not land or failed on-chain.
async function swap(quoteResponse, owner){
  const body = {
    quoteResponse, userPublicKey: owner.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: env('PRIORITY_FEE_MAX_LAMPORTS', 200000), priorityLevel: 'high' } }
  };
  let sw;
  try { sw = await jup('/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e){
    if (e.status !== 400) throw e;
    delete body.prioritizationFeeLamports;          // older API versions: retry without priority fee
    sw = await jup('/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  if (!sw.swapTransaction) throw new Error('Jupiter gaf geen swapTransaction');
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64'));
  tx.sign([owner]);
  const conn = connection();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const blockhash = tx.message.recentBlockhash;
  const lastValidBlockHeight = sw.lastValidBlockHeight || (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight;
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf && conf.value && conf.value.err) throw new Error('transactie mislukt on-chain: ' + JSON.stringify(conf.value.err) + ' (' + sig + ')');
  return sig;
}

async function tokenRawBalance(owner, mintStr){
  const resp = await connection().getParsedTokenAccountsByOwner(owner.publicKey, { mint: new web3.PublicKey(mintStr) });
  let raw = 0n;
  resp.value.forEach(acc => { raw += BigInt(acc.account.data.parsed.info.tokenAmount.amount); });
  return raw;
}
async function solBalance(owner){ return (await connection().getBalance(owner.publicKey)) / 1e9; }

// ---------- safety (same checks as the web app) ----------
async function safetyProblems(tokenMint, buyQuote, lamports, info){
  const problems = [];
  const minLiq = env('MIN_LIQUIDITY_USD', 20000);
  if (info && Number.isFinite(info.liquidityUsd) && info.liquidityUsd < minLiq) problems.push('liquiditeit $' + Math.round(info.liquidityUsd) + ' < $' + minLiq);
  if (process.env.SAFETY_CHECK === '0') return problems;
  try {
    const acc = await connection().getParsedAccountInfo(new web3.PublicKey(tokenMint));
    const parsed = acc && acc.value && acc.value.data && acc.value.data.parsed;
    if (!parsed || !parsed.info) problems.push('kon token-gegevens niet lezen');
    else {
      if (parsed.info.mintAuthority) problems.push('maker kan nog tokens bijmaken (mint authority)');
      if (parsed.info.freezeAuthority) problems.push('maker kan wallets bevriezen (freeze authority)');
    }
  } catch (e){ problems.push('mint-check mislukt (' + e.message + ')'); }
  try {
    const back = await quote(tokenMint, SOL_MINT, buyQuote.outAmount);
    const loss = (1 - Number(back.outAmount) / lamports) * 100;
    const max = env('MAX_ROUND_TRIP_PCT', 8);
    if (!(loss <= max)) problems.push('direct terugverkopen kost ' + loss.toFixed(1) + '% (max ' + max + '%)');
  } catch (e){ problems.push('geen verkoop-route gevonden (mogelijke honeypot)'); }
  return problems;
}

// ---------- per-coin state ----------
// Assumption: the bot wallet is ONLY used by the bot. Tokens of a watched coin in it = the bot's position.
const state = new Map();     // mint -> { open, tp1Done, spentSol, busy }
const day = { key: '', buys: 0, pnlSol: 0 };
function today(){ return new Date().toISOString().slice(0, 10); }
function dayStats(){ const k = today(); if (day.key !== k){ day.key = k; day.buys = 0; day.pnlSol = 0; } return day; }

async function getState(mint){
  let s = state.get(mint);
  if (!s){
    s = { open: false, tp1Done: false, spentSol: 0, busy: false, initDone: false };
    state.set(mint, s);
  }
  if (!s.initDone){
    // after a restart: look at the wallet, so the bot never buys twice or forgets a position
    const raw = await tokenRawBalance(loadKeypair(), mint);
    s.open = raw > 0n; s.initDone = true;
    if (!s.open){ s.tp1Done = false; s.spentSol = 0; s.receivedSol = 0; }
    if (s.open) console.log('LIVE', mint.slice(0, 6), 'wallet heeft al tokens → behandeld als open positie');
  }
  return s;
}
function isOpen(mint){ const s = state.get(mint); return !!(s && s.open); }
async function positionOpen(mint){ return (await getState(mint)).open; }

let notifyFn = async msg => console.log(msg);
let journalFn = () => {};
function setJournal(fn){ journalFn = fn; }
// save / restore what the bot knows (positions are always re-checked against the wallet after a restart)
function exportState(){
  const pos = {};
  state.forEach((v, k) => { pos[k] = { open: v.open, tp1Done: v.tp1Done, spentSol: v.spentSol, receivedSol: v.receivedSol || 0 }; });
  return { pos, day: { key: day.key, buys: day.buys, pnlSol: day.pnlSol } };
}
function importState(o){
  if (!o) return;
  Object.entries(o.pos || {}).forEach(([k, v]) => state.set(k, { open: !!v.open, tp1Done: !!v.tp1Done, spentSol: Number(v.spentSol) || 0, receivedSol: Number(v.receivedSol) || 0, busy: false, initDone: false }));
  if (o.day && o.day.key === today()){ day.key = o.day.key; day.buys = Number(o.day.buys) || 0; day.pnlSol = Number(o.day.pnlSol) || 0; }
}
function setNotify(fn){ notifyFn = fn; }
async function say(msg){ try { await notifyFn(msg); } catch (_){ console.log(msg); } }

async function doBuy(mint, s, info){
  const d = dayStats();
  const maxBuys = env('MAX_BUYS_PER_DAY', 6);
  const maxLoss = env('MAX_DAILY_LOSS_SOL', 0.05);
  if (s.open) return say('LIVE BUY overgeslagen: positie op ' + mint.slice(0, 6) + ' staat al open');
  if (d.buys >= maxBuys) return say('LIVE BUY overgeslagen: al ' + d.buys + ' buys vandaag (max ' + maxBuys + ')');
  if (-d.pnlSol >= maxLoss) return say('LIVE BUY overgeslagen: dagverlies ' + (-d.pnlSol).toFixed(4) + ' SOL ≥ max ' + maxLoss + ' — morgen weer');
  const owner = loadKeypair();
  const mult = Math.min(1, Math.max(0.25, Number(info && info.stakeMult) || 1));   // never more than the normal amount
  const buySol = Math.round(env('TRADE_AMOUNT_SOL', 0.01) * mult * 1e6) / 1e6;
  const reserve = env('MIN_SOL_RESERVE', 0.01);
  const bal = await solBalance(owner);
  if (bal < buySol + reserve) return say('LIVE BUY overgeslagen: SOL-saldo ' + bal.toFixed(4) + ' < ' + (buySol + reserve).toFixed(4) + ' (inzet + reserve)');
  const lamports = Math.floor(buySol * 1e9);
  const q = await quote(SOL_MINT, mint, lamports);
  const problems = await safetyProblems(mint, q, lamports, info);
  if (problems.length) return say('LIVE BUY geweigerd door veiligheidscheck (' + mint.slice(0, 6) + '): ' + problems.join(' · '));
  const sig = await swap(q, owner);
  const raw = await tokenRawBalance(owner, mint);
  if (raw <= 0n) throw new Error('buy bevestigd maar geen tokens ontvangen (' + sig + ')');
  s.open = true; s.tp1Done = false; s.spentSol = buySol; d.buys++;
  await say('✅ LIVE BUY ' + buySol + ' SOL' + (mult < 1 ? ' (verkleind na verliesreeks)' : '') + ' · ' + (info && info.symbol || mint.slice(0, 6)) + ' · https://solscan.io/tx/' + sig);
}

async function doSell(mint, s, label, frac, info){
  const owner = loadKeypair();
  const raw = await tokenRawBalance(owner, mint);
  if (raw <= 0n){ s.open = false; return say('LIVE ' + label + ': geen tokens meer in wallet — positie gesloten'); }
  const amount = frac >= 1 ? raw : raw * BigInt(Math.round(frac * 10000)) / 10000n;
  if (amount <= 0n) return;
  const q = await quote(mint, SOL_MINT, amount.toString());
  const sig = await swap(q, owner);
  const gotSol = Number(q.outAmount) / 1e9;
  if (frac >= 1){
    const pnl = gotSol + (s.receivedSol || 0) - s.spentSol;
    dayStats().pnlSol += pnl;
    try { journalFn({ mint, symbol: (info && info.symbol) || mint.slice(0, 6), spentSol: s.spentSol, gotSol: gotSol + (s.receivedSol || 0), pnlSol: pnl, exit: label, time: Date.now(), sig }); } catch (_){}
    s.open = false; s.tp1Done = false; s.receivedSol = 0;
    await say('💰 LIVE ' + label + ' alles verkocht · ' + (info && info.symbol || mint.slice(0, 6)) + ' · ≈ ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL · https://solscan.io/tx/' + sig);
  } else {
    s.receivedSol = (s.receivedSol || 0) + gotSol;
    await say('💰 LIVE ' + label + ' ' + Math.round(frac * 100) + '% verkocht · ' + (info && info.symbol || mint.slice(0, 6)) + ' · https://solscan.io/tx/' + sig);
  }
}

/**
 * events: [{type:'BUY'|'TP1'|'TP2'|'SL'|'TRAIL'|'EXIT'|'SYNC', ...}]
 * info:   { symbol, liquidityUsd, partialFrac }
 */
async function handleLiveEvents(events, mint, info){
  if (!liveEnabled() || !events || !events.length) return;
  const s = await getState(mint);
  if (s.busy){ console.log('LIVE', mint.slice(0, 6), 'vorige trade nog bezig — overgeslagen:', events.map(e => e.type).join(',')); return; }
  s.busy = true;
  try {
    for (const e of events){
      try {
        if (e.type === 'BUY') await doBuy(mint, s, info);
        else if (!s.open) console.log('LIVE', e.type, 'overgeslagen: geen open bot-positie op', mint.slice(0, 6));
        else if (e.type === 'TP1'){
          if (s.tp1Done){ console.log('LIVE TP1 overgeslagen: al genomen'); continue; }
          await doSell(mint, s, 'TP1', (info && info.partialFrac) || 0.5, info);
          s.tp1Done = true;
        }
        else if (['TP2', 'SL', 'TRAIL', 'EXIT', 'SYNC'].includes(e.type)) await doSell(mint, s, e.type, 1, info);
      } catch (err){
        await say('⚠️ LIVE ' + e.type + ' mislukt (' + mint.slice(0, 6) + '): ' + err.message);
      }
    }
  } finally { s.busy = false; }
}

async function startupReport(){
  if (!liveEnabled()) return 'Live trades UIT (ENABLE_LIVE_TRADES≠1) — alleen signalen.';
  const owner = loadKeypair();
  const bal = await solBalance(owner);
  return 'Live trades AAN · wallet ' + owner.publicKey.toBase58().slice(0, 4) + '…' + owner.publicKey.toBase58().slice(-4)
    + ' · ' + bal.toFixed(4) + ' SOL · inzet ' + env('TRADE_AMOUNT_SOL', 0.01) + ' SOL · max ' + env('MAX_BUYS_PER_DAY', 6)
    + ' buys/dag · max dagverlies ' + env('MAX_DAILY_LOSS_SOL', 0.05) + ' SOL';
}

module.exports = { liveEnabled, handleLiveEvents, loadKeypair, isOpen, positionOpen, setNotify, setJournal, exportState, importState, startupReport, _state: state, _day: day };
