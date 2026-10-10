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
 * MAX_SLIPPAGE_BPS (1000)      highest slippage a BUY retry may use · MAX_SELL_SLIPPAGE_BPS (1500) same for sells
 * RPC_URL                      your own RPC (Helius/QuickNode) is much more reliable than the public one
 * JUP_API_KEY                  optional Jupiter API key (then api.jup.ag is used first, with the key)
 * DRY_RUN (0)                  1 = do everything (quote, checks, build the swap) but only SIMULATE it — nothing is sent
 * CLOSE_EMPTY_ACCOUNTS (1)     after selling everything, close the empty token account → the ±0.002 SOL rent comes back
 */
const web3 = require('@solana/web3.js');
const bs58mod = require('bs58');
const bs58 = bs58mod.decode ? bs58mod : bs58mod.default;   // bs58 v5 and v6 export differently

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_HOSTS = ['https://lite-api.jup.ag/swap/v1', 'https://api.jup.ag/swap/v1'];
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PKnpVeMhJqcPxqT'];

function env(name, fallback){ const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== '' ? v : fallback; }
function flagOn(name, fallback){ const v = String(process.env[name] == null || process.env[name] === '' ? (fallback ? '1' : '0') : process.env[name]).toLowerCase(); return v === '1' || v === 'true'; }
function dryRun(){ return flagOn('DRY_RUN', false); }
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
// with JUP_API_KEY: api.jup.ag with the key first. Without: lite-api first, then the keyless api.jup.ag.
// 401/403/404/410 from Jupiter usually means an address changed or a key is needed → tell the owner (at most once an hour)
let jupWarnAt = 0;
async function jup(path, opts){
  const key = (process.env.JUP_API_KEY || '').trim();
  const hosts = key ? [JUP_HOSTS[1], JUP_HOSTS[0]] : JUP_HOSTS;
  let lastErr;
  for (const host of hosts){
    const o = Object.assign({}, opts || {});
    if (key && host === JUP_HOSTS[1]) o.headers = Object.assign({}, o.headers || {}, { 'x-api-key': key });
    try { return await fetchJson(host + path, o); }
    catch (e){ lastErr = e; if (e.status && ![401, 403, 404, 410].includes(e.status)) throw e; }
  }
  if (lastErr && [401, 403, 404, 410].includes(lastErr.status) && Date.now() - jupWarnAt > 3600000){
    jupWarnAt = Date.now();
    say('⚠️ Jupiter weigert (' + lastErr.status + '): kopen/verkopen werkt nu niet. Mogelijk is er een API-key nodig — zet JUP_API_KEY in Railway (gratis via portal.jup.ag).');
  }
  throw lastErr;
}
async function quote(inputMint, outputMint, amountRaw, slipBps){
  const slip = slipBps || env('SLIPPAGE_BPS', 300);
  return jup('/quote?inputMint=' + inputMint + '&outputMint=' + outputMint + '&amount=' + amountRaw + '&slippageBps=' + slip);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_WAIT_MS = () => env('RETRY_WAIT_MS', 1500);

// Build, sign, send AND wait for confirmation. Throws if the swap did not land or failed on-chain.
async function buildSwap(quoteResponse, owner){
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
  return { tx, sw };
}
/** DRY_RUN: let the RPC run the transaction without sending it — proves quote, route, wallet and fees all work */
async function simulateSwap(quoteResponse, owner){
  const { tx } = await buildSwap(quoteResponse, owner);
  const sim = await connection().simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const v = (sim && sim.value) || {};
  return { ok: !v.err, err: v.err ? JSON.stringify(v.err) : '', units: v.unitsConsumed || null, logs: (v.logs || []).slice(-3) };
}
async function swap(quoteResponse, owner){
  const { tx, sw } = await buildSwap(quoteResponse, owner);
  tx.sign([owner]);
  const conn = connection();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const blockhash = tx.message.recentBlockhash;
  const lastValidBlockHeight = sw.lastValidBlockHeight || (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight;
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf && conf.value && conf.value.err) throw new Error('transactie mislukt on-chain: ' + JSON.stringify(conf.value.err) + ' (' + sig + ')');
  return sig;
}

async function tokenAccounts(owner, mintStr){
  const resp = await connection().getParsedTokenAccountsByOwner(owner.publicKey, { mint: new web3.PublicKey(mintStr) });
  return resp.value.map(acc => ({ pubkey: acc.pubkey, program: acc.account.owner, amount: BigInt(acc.account.data.parsed.info.tokenAmount.amount) }));
}
async function tokenRawBalance(owner, mintStr){
  return (await tokenAccounts(owner, mintStr)).reduce((a, x) => a + x.amount, 0n);
}
// SPL-token "CloseAccount" (instruction 9): an EMPTY token account gives its rent (±0.002 SOL) back to the owner
function closeIx(account, owner, program){
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(String(program)),
    keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([9]) });
}
async function closeEmpty(owner, accounts){
  const empty = accounts.filter(a => a.amount === 0n && TOKEN_PROGRAMS.includes(String(a.program)));
  if (!empty.length) return 0;
  const conn = connection();
  let closed = 0;
  for (let i = 0; i < empty.length; i += 10){
    const part = empty.slice(i, i + 10);
    const tx = new web3.Transaction();
    part.forEach(a => tx.add(closeIx(a.pubkey, owner.publicKey, a.program)));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = owner.publicKey;
    tx.sign(owner);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf && conf.value && conf.value.err) throw new Error('lege accounts sluiten mislukt: ' + JSON.stringify(conf.value.err));
    closed += part.length;
  }
  return closed;
}
/** sweep: close every empty token account of the bot wallet (rent that leaked before this fix comes back) */
async function reclaimRent(){
  const owner = loadKeypair(), conn = connection();
  const all = [];
  for (const programId of TOKEN_PROGRAMS){
    try {
      const resp = await conn.getParsedTokenAccountsByOwner(owner.publicKey, { programId: new web3.PublicKey(programId) });
      resp.value.forEach(acc => {
        const mint = acc.account.data.parsed.info.mint;
        if (mint === SOL_MINT) return;   // wrapped SOL is handled by Jupiter
        all.push({ pubkey: acc.pubkey, program: acc.account.owner, amount: BigInt(acc.account.data.parsed.info.tokenAmount.amount), mint });
      });
    } catch (e){ console.log('opruimen:', programId.slice(0, 6), e.message); }
  }
  const empty = all.filter(a => a.amount === 0n);
  if (!empty.length) return { closed: 0, sol: 0 };
  const before = await solBalance(owner);
  const closed = await withWalletLock(() => closeEmpty(owner, empty));
  const after = await solBalance(owner);
  return { closed, sol: Math.max(0, after - before) };
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

// one wallet action at a time (all coins, hunter, copy trades): then "SOL before/after" belongs to exactly that trade
let walletChain = Promise.resolve();
const LOCK_MAX_MS = () => env('WALLET_LOCK_MAX_MS', 180000);
function withWalletLock(fn){
  const run = walletChain.then(fn, fn);
  // never let one stuck RPC call block every other trade forever: the next action may start after LOCK_MAX_MS
  walletChain = Promise.race([run.then(() => {}, () => {}), new Promise(r => { const t = setTimeout(r, LOCK_MAX_MS()); if (t.unref) t.unref(); })]).catch(() => {});
  return run;
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
function tp1Taken(mint){ const s = state.get(mint); return !!(s && s.tp1Done); }
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

async function doBuy(mint, s, info, forceDry){
  const dry = forceDry || dryRun();
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
  if (problems.length) return say((dry ? '🧪 DRY RUN: ' : '') + 'LIVE BUY geweigerd door veiligheidscheck (' + mint.slice(0, 6) + '): ' + problems.join(' · '));
  if (dry){
    const sim = await simulateSwap(q, owner);
    const msg = '🧪 DRY RUN BUY ' + (info && info.symbol || mint.slice(0, 6)) + ' · ' + buySol + ' SOL → ' + q.outAmount + ' (ruwe tokens) · veiligheidscheck ok · simulatie '
      + (sim.ok ? 'GESLAAGD' + (sim.units ? ' (' + sim.units + ' compute units)' : '') : 'MISLUKT: ' + sim.err + (sim.logs.length ? ' · ' + sim.logs.join(' | ').slice(0, 300) : '')) + ' · er is NIETS verstuurd';
    await say(msg);
    return sim;
  }
  const rawBefore = await tokenRawBalance(owner, mint);
  // try, and if it fails (slippage, network busy, expired) try once more with a fresh quote and a bit more slippage —
  // but first check the wallet: if the first attempt landed after all, never buy a second time
  let sig = null, lastErr = null, slip = env('SLIPPAGE_BPS', 300), retried = false;
  for (let attempt = 0; attempt < 2 && !sig; attempt++){
    if (attempt > 0){
      if ((await tokenRawBalance(owner, mint)) > 0n){ sig = '(eerste poging kwam toch aan)'; break; }
      slip = Math.min(env('MAX_SLIPPAGE_BPS', 1000), Math.round(slip * 1.7));
      retried = true;
      await sleep(RETRY_WAIT_MS());
    }
    try { sig = await swap(attempt === 0 ? q : await quote(SOL_MINT, mint, lamports, slip), owner); }
    catch (e){ lastErr = e; console.log('LIVE BUY poging ' + (attempt + 1) + ' mislukt (' + mint.slice(0, 6) + '): ' + e.message); }
  }
  if (!sig && (await tokenRawBalance(owner, mint)) > 0n) sig = '(poging kwam toch aan)';
  if (!sig) throw new Error('koop mislukt na 2 pogingen: ' + (lastErr ? lastErr.message : 'onbekend'));
  const raw = await tokenRawBalance(owner, mint);
  if (raw <= 0n) throw new Error('buy bevestigd maar geen tokens ontvangen (' + sig + ')');
  // what it REALLY cost: the wallet difference (stake + network fee + priority fee + token-account rent)
  let spent = buySol;
  try { const diff = bal - (await solBalance(owner)); if (diff > 0 && diff < buySol * 3) spent = diff; } catch (_){}
  // slippage: tokens we got versus what the quote promised (+ = worse than expected)
  const got = Number(raw - rawBefore), promised = Number(q.outAmount);
  s.slipBuyPct = promised > 0 && got > 0 ? (1 - got / promised) * 100 : null;
  s.open = true; s.tp1Done = false; s.tp2Done = false; s.spentSol = spent; s.stakeSol = buySol; d.buys++;
  await say('✅ LIVE BUY ' + buySol + ' SOL (echt van wallet af: ' + spent.toFixed(5) + ')' + (mult < 1 ? ' (verkleind na verliesreeks)' : '') + (retried ? ' (2e poging, slippage ' + (slip / 100) + '%)' : '') + ' · ' + (info && info.symbol || mint.slice(0, 6)) + ' · ' + (sig.startsWith('(') ? sig : 'https://solscan.io/tx/' + sig));
}

async function doSell(mint, s, label, frac, info){
  const owner = loadKeypair();
  const raw = await tokenRawBalance(owner, mint);
  if (raw <= 0n){ s.open = false; return say('LIVE ' + label + ': geen tokens meer in wallet — positie gesloten'); }
  const amount = frac >= 1 ? raw : raw * BigInt(Math.round(frac * 10000)) / 10000n;
  if (amount <= 0n) return;
  const target = raw - amount;   // what should be left after this sell
  const solBefore = await solBalance(owner);
  let sig = null, q = null, lastErr = null, slip = env('SLIPPAGE_BPS', 300), tries = 0;
  for (let attempt = 0; attempt < 3 && !sig; attempt++){
    if (attempt > 0){
      // the previous try may have landed after all: then don't sell again
      if ((await tokenRawBalance(owner, mint)) <= target + raw / 1000n){ sig = '(vorige poging kwam toch aan)'; break; }
      slip = Math.min(env('MAX_SELL_SLIPPAGE_BPS', 1500), Math.round(slip * 2));
      await sleep(RETRY_WAIT_MS());
    }
    tries = attempt + 1;
    try { q = await quote(mint, SOL_MINT, amount.toString(), slip); sig = await swap(q, owner); }
    catch (e){ lastErr = e; console.log('LIVE ' + label + ' poging ' + (attempt + 1) + ' mislukt (' + mint.slice(0, 6) + '): ' + e.message); }
  }
  if (!sig && (await tokenRawBalance(owner, mint)) <= target + raw / 1000n) sig = '(poging kwam toch aan)';
  if (!sig) throw new Error('verkoop mislukt na 3 pogingen: ' + (lastErr ? lastErr.message : 'onbekend') + ' — de bot probeert het later opnieuw');
  // what really came in (wallet difference); falls back to the quote if the balance can't be read
  let gotSol = q ? Number(q.outAmount) / 1e9 : 0;
  try { const diff = (await solBalance(owner)) - solBefore; if (diff > 0) gotSol = diff; } catch (_){}
  const slipSell = q && Number(q.outAmount) > 0 ? (1 - gotSol / (Number(q.outAmount) / 1e9)) * 100 : null;
  if (frac >= 1){
    // the token account is empty now: close it, the ±0.002 SOL rent comes back (counted in this trade's result)
    let rentBack = 0;
    if (flagOn('CLOSE_EMPTY_ACCOUNTS', true)){
      try {
        const accs = await tokenAccounts(owner, mint);
        const before = await solBalance(owner);
        if (await closeEmpty(owner, accs)) rentBack = Math.max(0, (await solBalance(owner)) - before);
      } catch (e){ console.log('LIVE: leeg token-account sluiten mislukt (' + mint.slice(0, 6) + '): ' + e.message + ' — /opruimen probeert het later'); }
    }
    const pnl = gotSol + rentBack + (s.receivedSol || 0) - s.spentSol;
    dayStats().pnlSol += pnl;
    try { journalFn({ mint, symbol: (info && info.symbol) || mint.slice(0, 6), spentSol: s.spentSol, gotSol: gotSol + rentBack + (s.receivedSol || 0), pnlSol: pnl, exit: label, time: Date.now(), sig,
      stakeSol: s.stakeSol || s.spentSol, rentBack, slipBuyPct: s.slipBuyPct != null ? +s.slipBuyPct.toFixed(2) : null, slipSellPct: slipSell != null ? +slipSell.toFixed(2) : null }); } catch (_){}
    s.open = false; s.tp1Done = false; s.tp2Done = false; s.receivedSol = 0;
    await say('💰 LIVE ' + label + ' alles verkocht' + (tries > 1 ? ' (poging ' + tries + ')' : '') + ' · ' + (info && info.symbol || mint.slice(0, 6)) + ' · ≈ ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL · ' + (sig.startsWith('(') ? sig : 'https://solscan.io/tx/' + sig));
  } else {
    s.receivedSol = (s.receivedSol || 0) + gotSol;
    await say('💰 LIVE ' + label + ' ' + Math.round(frac * 100) + '% verkocht' + (tries > 1 ? ' (poging ' + tries + ')' : '') + ' · ' + (info && info.symbol || mint.slice(0, 6)) + ' · ' + (sig.startsWith('(') ? sig : 'https://solscan.io/tx/' + sig));
  }
}

/**
 * events: [{type:'BUY'|'TP1'|'TP2'|'SL'|'TRAIL'|'EXIT'|'SYNC', ...}]
 * info:   { symbol, liquidityUsd, partialFrac }
 */
async function handleLiveEvents(events, mint, info){
  if (!liveEnabled() || !events || !events.length) return;
  return withWalletLock(() => handleLiveEventsNow(events, mint, info));
}
/** /dryrun: test the whole buy path for one coin with real data — only simulated, never sent, works with live trading off */
async function dryRunBuy(mint, info){
  const s = { open: false, busy: false, initDone: true };
  return withWalletLock(() => doBuy(mint, s, info, true));
}
async function handleLiveEventsNow(events, mint, info){
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
        else if (e.type === 'TP2' && e.frac != null && e.frac < 1){
          // "let it run": sell only part at TP2, the trailing stop handles the rest
          if (s.tp2Done){ console.log('LIVE TP2 (deel) overgeslagen: al genomen'); continue; }
          await doSell(mint, s, 'TP2', e.frac, info);
          s.tp2Done = true;
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

module.exports = { liveEnabled, dryRun, dryRunBuy, reclaimRent, withWalletLock, handleLiveEvents, loadKeypair, isOpen, tp1Taken, positionOpen, setNotify, setJournal, exportState, importState, startupReport, _state: state, _day: day };
