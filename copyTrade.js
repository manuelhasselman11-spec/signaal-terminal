/**
 * Wallets volgen (copy-trading) — zoals "Quiver Quant", maar dan voor Solana.
 * Op Solana is elke trade meteen openbaar. Deze module kijkt elke paar seconden wat slimme wallets kopen en verkopen.
 *
 * Variables in Railway (standaard tussen haakjes):
 * COPY_WALLETS=            wallets om te volgen, gescheiden door komma's. Een naam erbij mag: adres:naam,adres2:naam2
 *                          (je kunt ze ook via Telegram toevoegen: /volg <adres> <naam>)
 * COPY_MODE (paper)        alert = alleen berichten · paper = berichten + nep-portefeuille · live = ook echt meekopen
 * COPY_SOL (0.05)          inzet per nep-trade; bij live nooit meer dan TRADE_AMOUNT_SOL
 * COPY_MIN_SOL (0.1)       alleen kopen nadoen als de wallet zelf minstens zoveel SOL inzet (geen kruimel-trades)
 * COPY_SL_PCT (25)         verkopen als de koers zoveel % onder je instap zakt
 * COPY_TP_PCT (0)          verkopen bij zoveel % winst (0 = uit, dan verkoop je pas als de wallet verkoopt)
 * COPY_MAX_HOURS (12)      positie uiterlijk na zoveel uur sluiten
 * COPY_COST_PCT (2)        geschatte kosten per nep-trade (slippage + fees), wordt van de nep-winst afgetrokken
 * COPY_LIVE_MIN_TRADES (5) live alleen meekopen met wallets die al zoveel nep-trades hebben gedaan met totaal winst (0 = iedereen)
 * COPY_MAX_OPEN (5)        max aantal open kopieer-posities tegelijk
 * COPY_POLL_MS (15000)     hoe vaak kijken
 */
'use strict';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLES = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '?';

/** Find what a wallet bought or sold in one transaction. Returns a list of {side, mint, tokens, sol, usd}. */
function parseSwap(tx, wallet){
  if (!tx || !tx.meta || tx.meta.err) return [];
  const msg = (tx.transaction && tx.transaction.message) || {};
  const keys = (msg.accountKeys || []).map(k => typeof k === 'string' ? k : (k && k.pubkey) || '');
  const la = tx.meta.loadedAddresses;
  if (la && keys.length < (tx.meta.preBalances || []).length) keys.push(...(la.writable || []), ...(la.readonly || []));
  let sol = 0;
  const i = keys.indexOf(wallet);
  if (i >= 0 && tx.meta.preBalances && tx.meta.postBalances){
    sol = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
    if (i === 0) sol += (tx.meta.fee || 0) / 1e9;   // network fee is not part of the trade
  }
  const d = new Map();
  const add = (b, sign) => {
    if (!b || b.owner !== wallet) return;
    const u = b.uiTokenAmount || {};
    const amt = Number(u.uiAmountString != null ? u.uiAmountString : u.uiAmount) || 0;
    d.set(b.mint, (d.get(b.mint) || 0) + sign * amt);
  };
  (tx.meta.preTokenBalances || []).forEach(b => add(b, -1));
  (tx.meta.postTokenBalances || []).forEach(b => add(b, 1));
  sol += d.get(SOL_MINT) || 0; d.delete(SOL_MINT);            // wrapped SOL counts as SOL
  let usd = 0; STABLES.forEach(m => { usd += d.get(m) || 0; d.delete(m); });
  const ups = [], downs = [];
  d.forEach((v, m) => { if (v > 1e-9) ups.push([m, v]); else if (v < -1e-9) downs.push([m, -v]); });
  const base = { sig: (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) || '', time: (tx.blockTime || 0) * 1000, wallet };
  const out = [];
  if (ups.length === 1 && !downs.length && (sol < -0.0005 || usd < -0.01))
    out.push(Object.assign({}, base, { side: 'BUY', mint: ups[0][0], tokens: ups[0][1], sol: Math.max(0, -sol), usd: Math.max(0, -usd) }));
  else if (downs.length === 1 && !ups.length && (sol > 0.0005 || usd > 0.01))
    out.push(Object.assign({}, base, { side: 'SELL', mint: downs[0][0], tokens: downs[0][1], sol: Math.max(0, sol), usd: Math.max(0, usd) }));
  else if (ups.length === 1 && downs.length === 1){
    // token → token: the old one is sold, the new one bought (SOL amount unknown)
    out.push(Object.assign({}, base, { side: 'SELL', mint: downs[0][0], tokens: downs[0][1], sol: 0, usd: 0 }));
    out.push(Object.assign({}, base, { side: 'BUY', mint: ups[0][0], tokens: ups[0][1], sol: 0, usd: 0 }));
  }
  // anything else (airdrops, plain transfers, LP stuff) is not a trade → ignored
  return out;
}

function createCopy(o = {}){
  const env = o.env || process.env;
  const n = (k, f) => { const v = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : f; };
  const cfg = {
    mode: String(env.COPY_MODE || 'paper').toLowerCase(),
    copySol: n('COPY_SOL', 0.05), minSol: n('COPY_MIN_SOL', 0.1),
    slPct: n('COPY_SL_PCT', 25), tpPct: n('COPY_TP_PCT', 0), maxHours: n('COPY_MAX_HOURS', 12),
    costPct: n('COPY_COST_PCT', 2), liveMinTrades: Math.max(0, Math.floor(n('COPY_LIVE_MIN_TRADES', 5))),
    maxOpen: Math.max(1, Math.floor(n('COPY_MAX_OPEN', 5))), maxWallets: Math.max(1, Math.floor(n('COPY_MAX_WALLETS', 10))),
    pollMs: Math.max(5000, n('COPY_POLL_MS', 15000)), txPause: n('COPY_TX_PAUSE_MS', 150),
  };
  if (!['alert', 'paper', 'live'].includes(cfg.mode)) cfg.mode = 'paper';
  const notify = o.notify || (async m => console.log(m));
  const live = o.live || null;                    // { enabled(), buy(mint, info), sell(mint, info), isOpen(mint), canBuy(mint) }
  const now = o.now || (() => Date.now());
  const rpc = o.rpc || defaultRpc(env);
  const prices = o.prices || defaultPrices;

  let st = { wallets: [], paper: {}, closed: [], feed: [], live: {} };
  String(env.COPY_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => {
    const [addr, ...rest] = s.split(':');
    if (ADDR_RE.test(addr.trim())) addWallet(addr.trim(), rest.join(':').trim(), true);
  });

  function walletOf(addr){ return st.wallets.find(w => w.addr === addr); }
  function nameOf(w){ return w ? (w.name || short(w.addr)) : '?'; }
  function addWallet(addr, name, fromEnv){
    let w = walletOf(addr);
    if (w){ if (name) w.name = name; return w; }
    w = { addr, name: name || '', lastSig: null, primed: false, n: 0, wins: 0, pnlPct: 0, pnlSol: 0, fromEnv: !!fromEnv, added: now() };
    st.wallets.push(w);
    return w;
  }
  function trusted(w){ return cfg.liveMinTrades === 0 || (w.n >= cfg.liveMinTrades && w.pnlSol > 0); }
  const openPaper = () => Object.values(st.paper);
  const keyOf = (w, mint) => w + '|' + mint;

  async function info(mints){
    try { return (await prices([...new Set(mints)])) || {}; } catch (e){ console.error('kopieer: prijs ophalen mislukt', e.message); return {}; }
  }

  async function onEvent(w, e){
    const pi = (await info([e.mint]))[e.mint] || {};
    const sym = pi.symbol || short(e.mint);
    st.feed.unshift({ time: e.time || now(), wallet: w.addr, name: nameOf(w), side: e.side, mint: e.mint, symbol: sym, sol: e.sol, usd: e.usd, price: pi.price || 0, sig: e.sig });
    if (st.feed.length > 100) st.feed.length = 100;
    const amount = e.sol ? e.sol.toFixed(3) + ' SOL' : e.usd ? '$' + Math.round(e.usd) : '';
    const k = keyOf(w.addr, e.mint);
    if (e.side === 'BUY'){
      const big = e.sol >= cfg.minSol || e.usd >= cfg.minSol * 150;
      if (!big){ console.log('kopieer:', nameOf(w), 'kocht', sym, amount || '(via ander token)', '— te klein, niet nagedaan'); return; }
      await notify('🐋 ' + nameOf(w) + ' KOCHT ' + sym + ' voor ' + amount + (pi.liq ? ' · liquiditeit $' + Math.round(pi.liq).toLocaleString('nl-NL') : '') + '\nhttps://dexscreener.com/solana/' + e.mint);
      if (cfg.mode === 'alert') return;
      if (!st.paper[k] && pi.price > 0 && openPaper().length < cfg.maxOpen * 3){
        st.paper[k] = { wallet: w.addr, mint: e.mint, symbol: sym, entry: pi.price, time: now(), sol: cfg.copySol };
      }
      if (cfg.mode === 'live' && live && live.enabled()){
        if (!trusted(w)){ await notify('ℹ️ Niet echt meegekocht: ' + nameOf(w) + ' heeft nog maar ' + w.n + ' nep-trades (' + (w.pnlSol >= 0 ? '+' : '') + w.pnlSol.toFixed(3) + ' SOL). Pas na ' + cfg.liveMinTrades + ' trades met winst koopt de bot echt mee.'); return; }
        if (st.live[e.mint]) return;
        if (Object.keys(st.live).length >= cfg.maxOpen){ await notify('ℹ️ Niet echt meegekocht: al ' + cfg.maxOpen + ' kopieer-posities open (COPY_MAX_OPEN).'); return; }
        if (live.canBuy && !(await live.canBuy(e.mint, w.addr, sym))){ console.log('kopieer: kopen nu niet toegestaan (stop / limiet / coin al in gebruik / cloud-geheugen)'); return; }
        st.live[e.mint] = { wallet: w.addr, entry: pi.price || 0, time: now(), symbol: sym };
        try { await live.buy(e.mint, { symbol: sym, liquidityUsd: pi.liq || 0, copySol: cfg.copySol, wallet: w.addr }); }
        catch (err){ await notify('⚠️ Meekopen ' + sym + ' mislukt: ' + err.message); }
        if (!live.isOpen(e.mint)) delete st.live[e.mint];
      }
    } else {
      const holds = st.paper[k] || (st.live[e.mint] && st.live[e.mint].wallet === w.addr);
      if (holds || e.sol >= cfg.minSol) await notify('🐋 ' + nameOf(w) + ' VERKOCHT ' + sym + (amount ? ' voor ' + amount : '') + (holds ? ' → wij verkopen ook' : ''));
      if (st.paper[k]) closePaper(k, pi.price, 'wallet verkocht');
      if (st.live[e.mint] && st.live[e.mint].wallet === w.addr) await sellLive(e.mint, pi, 'wallet verkocht');
    }
  }

  function closePaper(k, price, why){
    const p = st.paper[k];
    if (!p) return;
    delete st.paper[k];
    if (!(price > 0)) price = p.entry;   // no price → count it as break-even minus costs
    const pct = (price / p.entry - 1) * 100 - cfg.costPct;
    const sol = p.sol * pct / 100;
    const w = walletOf(p.wallet);
    if (w){ w.n++; if (pct > 0) w.wins++; w.pnlPct += pct; w.pnlSol += sol; }
    st.closed.push({ wallet: p.wallet, mint: p.mint, symbol: p.symbol, pct, sol, why, time: now(), held: now() - p.time });
    if (st.closed.length > 500) st.closed = st.closed.slice(-500);
    if (o.onPaperClose){ try { o.onPaperClose({ kind: 'nep-kopie', mint: p.mint, symbol: p.symbol, source: p.wallet, spentSol: p.sol, pnlSol: sol, pnlPct: pct, exit: why, buyTime: p.time }); } catch (_){} }
    notify('📝 Nep-trade ' + p.symbol + ' (' + nameOf(w) + ') gesloten: ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% ≈ ' + (sol >= 0 ? '+' : '') + sol.toFixed(4) + ' SOL · ' + why);
  }
  async function sellLive(mint, pi, why){
    const l = st.live[mint];
    if (!l) return;
    await notify('🐋 Kopie ' + l.symbol + ' verkopen: ' + why);
    try { await live.sell(mint, { symbol: l.symbol, liquidityUsd: (pi && pi.liq) || 0 }); }
    catch (err){ await notify('⚠️ Verkopen ' + l.symbol + ' mislukt: ' + err.message + ' — volgende ronde opnieuw'); }
    if (!live.isOpen(mint)) delete st.live[mint];
  }

  async function checkExits(){
    const mints = openPaper().map(p => p.mint).concat(Object.keys(st.live));
    if (!mints.length) return;
    const pis = await info(mints);
    const maxAge = cfg.maxHours * 3600000;
    for (const [k, p] of Object.entries(st.paper)){
      const price = (pis[p.mint] || {}).price;
      if (!(price > 0)) continue;
      const pct = (price / p.entry - 1) * 100;
      if (pct <= -cfg.slPct) closePaper(k, price, 'stop -' + cfg.slPct + '%');
      else if (cfg.tpPct > 0 && pct >= cfg.tpPct) closePaper(k, price, 'winstdoel +' + cfg.tpPct + '%');
      else if (now() - p.time > maxAge) closePaper(k, price, 'na ' + cfg.maxHours + ' uur gesloten');
    }
    for (const [mint, l] of Object.entries(st.live)){
      if (!live || !live.isOpen(mint)){ delete st.live[mint]; continue; }
      const pi = pis[mint] || {}, price = pi.price;
      if (!(price > 0)) continue;
      if (!(l.entry > 0)){ l.entry = price; continue; }
      const pct = (price / l.entry - 1) * 100;
      if (pct <= -cfg.slPct) await sellLive(mint, pi, 'stop -' + cfg.slPct + '%');
      else if (cfg.tpPct > 0 && pct >= cfg.tpPct) await sellLive(mint, pi, 'winstdoel +' + cfg.tpPct + '%');
      else if (now() - l.time > maxAge) await sellLive(mint, pi, cfg.maxHours + ' uur voorbij');
    }
  }

  async function pollWallet(w){
    const opts = { limit: 25, commitment: 'confirmed' };
    if (w.lastSig) opts.until = w.lastSig;
    const sigs = (await rpc('getSignaturesForAddress', [w.addr, opts])) || [];
    if (!w.primed){
      // first look: only remember where we are, never copy old trades
      w.primed = true; w.lastSig = sigs.length ? sigs[0].signature : null;
      return 0;
    }
    if (!sigs.length) return 0;
    w.lastSig = sigs[0].signature;
    let found = 0;
    for (const s of sigs.slice().reverse()){
      if (s.err) continue;
      let tx;
      try { tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); }
      catch (e){ console.error('kopieer: transactie ophalen mislukt', e.message); continue; }
      for (const ev of parseSwap(tx, w.addr)){ found++; await onEvent(w, ev); }
      if (cfg.txPause) await sleep(cfg.txPause);
    }
    return found;
  }

  let busy = false;
  async function tick(){
    if (busy || !st.wallets.length) return;
    busy = true;
    try {
      for (const w of st.wallets){
        try { await pollWallet(w); w.err = 0; }
        catch (e){ w.err = (w.err || 0) + 1; console.error('kopieer:', nameOf(w), e.message); if (w.err === 10) notify('⚠️ Wallet ' + nameOf(w) + ' volgen lukt al 10 keer niet: ' + e.message.slice(0, 80) + ' (zet een eigen RPC_URL van Helius in Railway)'); }
      }
      if (cfg.mode !== 'alert') await checkExits();
    } finally { busy = false; }
  }

  function walletsText(){
    if (!st.wallets.length) return '🐋 Je volgt nog geen wallets.\nVoeg er een toe met /volg <wallet-adres> <naam>\nSlimme wallets vind je in de terminal op de tab 🐋 Wallets → "Ontdek".';
    const lines = ['🐋 Wallets volgen · stand: ' + ({ alert: 'alleen berichten', paper: 'nep-portefeuille', live: 'ECHT meekopen' })[cfg.mode] + (cfg.mode === 'live' && !(live && live.enabled()) ? ' (maar ENABLE_LIVE_TRADES staat uit)' : '')];
    for (const w of st.wallets){
      const open = openPaper().filter(p => p.wallet === w.addr).map(p => p.symbol);
      lines.push('• ' + nameOf(w) + ' — ' + w.addr + '\n   ' + (w.n ? w.n + ' nep-trades · ' + Math.round(w.wins / w.n * 100) + '% winst · ' + (w.pnlSol >= 0 ? '+' : '') + w.pnlSol.toFixed(4) + ' SOL' : 'nog geen afgesloten nep-trades')
        + (open.length ? ' · open: ' + open.join(', ') : '') + (cfg.mode === 'live' ? (trusted(w) ? ' · ✅ mag echt' : ' · ⏳ nog niet bewezen') : ''));
    }
    const live0 = Object.values(st.live);
    if (live0.length) lines.push('Echte kopieer-posities: ' + live0.map(l => l.symbol).join(', '));
    const tot = st.closed.reduce((a, c) => a + c.sol, 0);
    if (st.closed.length) lines.push('Totaal nep: ' + st.closed.length + ' trades · ' + (tot >= 0 ? '+' : '') + tot.toFixed(4) + ' SOL (inzet ' + cfg.copySol + ' SOL per trade)');
    return lines.join('\n');
  }

  /** Telegram: returns the answer text, or null when the command is not ours */
  async function command(cmd, arg){
    const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
    if (cmd === '/wallets') return walletsText();
    if (cmd === '/volg'){
      const addr = parts[0] || '';
      if (!ADDR_RE.test(addr)) return 'Gebruik: /volg <wallet-adres> <naam>\nVoorbeeld: /volg 5Q544fKr… walvis1';
      if (walletOf(addr)){ if (parts[1]) walletOf(addr).name = parts.slice(1).join(' ').slice(0, 20); return 'Deze wallet volg je al.'; }
      if (st.wallets.length >= cfg.maxWallets) return 'Je volgt al ' + st.wallets.length + ' wallets (max ' + cfg.maxWallets + '). Haal er eerst een weg met /ontvolg <adres>.';
      try {
        const info0 = await rpc('getAccountInfo', [addr, { encoding: 'base64' }]);
        if (info0 && info0.value && info0.value.owner && info0.value.owner !== '11111111111111111111111111111111') return 'Dit lijkt geen gewone wallet (misschien een coin- of pool-adres). Kopieer het adres van de wallet zelf, bijvoorbeeld van Solscan.';
      } catch (_){ /* RPC busy: just add it */ }
      const w = addWallet(addr, parts.slice(1).join(' ').slice(0, 20));
      return '🐋 Je volgt nu ' + nameOf(w) + '. Vanaf nu krijg je een bericht als deze wallet koopt of verkoopt'
        + (cfg.mode === 'alert' ? '.' : ', en de bot houdt een nep-portefeuille bij om te zien of nadoen winst geeft.')
        + (cfg.mode === 'live' ? '\nEcht meekopen pas na ' + cfg.liveMinTrades + ' nep-trades met winst.' : '');
    }
    if (cmd === '/ontvolg'){
      const addr = parts[0] || '';
      const w = walletOf(addr);
      if (!w) return 'Die wallet volg je niet. Stuur /wallets voor je lijst.';
      st.wallets = st.wallets.filter(x => x !== w);
      Object.keys(st.paper).filter(k => k.startsWith(addr + '|')).forEach(k => delete st.paper[k]);
      return '➖ ' + nameOf(w) + ' wordt niet meer gevolgd.' + (Object.values(st.live).some(l => l.wallet === addr) ? ' Echte posities van deze wallet worden nog verkocht bij stop/doel/tijd.' : '');
    }
    return null;
  }

  function exportState(){ return JSON.parse(JSON.stringify({ wallets: st.wallets, paper: st.paper, closed: st.closed.slice(-300), feed: st.feed.slice(0, 50), live: st.live })); }
  function importState(s){
    if (!s || !Array.isArray(s.wallets)) return;
    const envW = st.wallets;
    st = { wallets: s.wallets, paper: s.paper || {}, closed: s.closed || [], feed: s.feed || [], live: s.live || {} };
    envW.forEach(w => { if (!walletOf(w.addr)) st.wallets.push(w); });
    // after a restart: start looking from "now" again — never copy trades that happened while the bot was off
    st.wallets.forEach(w => { w.err = 0; w.primed = false; w.lastSig = null; });
  }

  return { cfg, tick, pollWallet, onEvent, checkExits, command, walletsText, exportState, importState, addWallet, trusted, get state(){ return st; } };
}

function defaultRpc(env){
  return async function rpc(method, params){
    const url = (env.RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
      if (res.status === 429) throw new Error('RPC te druk (429)');
      const j = await res.json();
      if (j.error) throw new Error('RPC ' + (j.error.message || JSON.stringify(j.error)));
      return j.result;
    } finally { clearTimeout(t); }
  };
}
async function defaultPrices(mints){
  const out = {};
  for (let i = 0; i < mints.length; i += 30){
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mints.slice(i, i + 30).join(','));
    const j = await res.json();
    for (const p of (j && j.pairs) || []){
      if (p.chainId !== 'solana' || !p.baseToken) continue;
      const m = p.baseToken.address, liq = (p.liquidity && p.liquidity.usd) || 0;
      if (!out[m] || liq > out[m].liq) out[m] = { price: Number(p.priceUsd) || 0, symbol: p.baseToken.symbol, liq };
    }
  }
  return out;
}

module.exports = { parseSwap, createCopy, SOL_MINT, ADDR_RE };
