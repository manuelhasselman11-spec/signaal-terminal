/**
 * 24/7 signal worker — zelfde strategie als de web-app.
 * Standaard: alleen logs + optioneel Telegram.
 * Live swaps: alleen als ENABLE_LIVE_TRADES=1 en PRIVATE_KEY in Railway Variables (zie liveTrade.js).
 *
 * Variables: TOKEN_ADDRESS (mint1,mint2,…), TIMEFRAME (minute:5), POLL_MS (30000),
 *            STOPWATCH_MS (5000, 0 = uit), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *            COST_PCT (1) = kosten per trade in % (meet ze op de website met "Meet echte kosten"),
 *            USE_TREND (1), TREND_LEN (50), MIN_EDGE (2) = trend- en kostenfilter, zoals op de website,
 *            AUTO_TUNE (0) = 1: zoekt zelf betere instellingen per coin en past ze toe (met strenge regels),
 *                            suggest: stuurt alleen voorstellen naar Telegram/logs, verandert niets,
 *            TUNE_EVERY_H (12), TUNE_DAYS (14), PAUSE_BAD_COINS (1),
 *            TELEGRAM_COMMANDS (1) = bedien de bot vanuit Telegram: /status /stop /hervat /verkoopalles /tune /help
 *            REPORT_HOUR (21) = dagrapport om dit uur (Nederlandse tijd), -1 = uit,
 *            AUTO_COINS (0) = 1–5: de bot kiest zelf zoveel coins uit bekende memes (AUTO_LIST) met dezelfde toets als de website,
 *            AUTO_MIN_LIQ_USD (1000000), AUTO_LIST (TRUMP,PENGU,BONK,…),
 *            MAX_TOTAL_LOSS_SOL (0.1) = stopt met kopen als het totale resultaat zoveel SOL verlies is (/hervat = doorgaan),
 *            DATA_DIR = map om geheugen te bewaren (Railway Volume: wordt automatisch gevonden).
 *            plus de strategie-instellingen (EMA_FAST, EMA_SLOW, ATR_MULT_SL, RR_TP1, RR_TP2, …).
 */
const live = require('./liveTrade');
const TOKEN_LIST = (process.env.TOKEN_ADDRESS || '')
  .split(/[,;\s]+/)
  .map(s => s.trim())
  .filter(Boolean);
const TIMEFRAME = process.env.TIMEFRAME || 'minute:5';
const POLL_MS = Math.max(10000, Number(process.env.POLL_MS) || 30000);
const STOPWATCH_MS = process.env.STOPWATCH_MS === '0' ? 0 : Math.max(2000, Number(process.env.STOPWATCH_MS) || 5000);
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '').trim();

const chainMap = {
  solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base',
  arbitrum: 'arbitrum', polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism'
};

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function flag(name, fallback = true) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function getParams() {
  return {
    emaFastLen: num('EMA_FAST', 5),
    emaSlowLen: num('EMA_SLOW', 13),
    atrLen: num('ATR_LEN', 14),
    atrMultSL: num('ATR_MULT_SL', 1),
    rrTp1: num('RR_TP1', 1),
    rrTp2: num('RR_TP2', 3),
    confirmCandle: flag('CONFIRM_CANDLE', true),
    confirmWindow: num('CONFIRM_WINDOW', 3),
    rsiLen: num('RSI_LEN', 14),
    rsiOS: num('RSI_OS', 32),
    rsiLookback: num('RSI_LOOKBACK', 6),
    revBody: num('REV_BODY', 0.5),
    sweepLen: num('SWEEP_LEN', 20),
    donLen: num('DON_LEN', 20),
    volMult: num('VOL_MULT', 1.5),
    trailMult: num('TRAIL_MULT', 2.5),
    partialFrac: Math.min(1, Math.max(0.1, num('PARTIAL_FRAC', 0.5))),
    costPct: num('COST_PCT', 1),
    cooldown: num('COOLDOWN', 0),
    beAfterTp1: flag('BE_AFTER_TP1', true),
    exitOnCross: flag('EXIT_ON_CROSS', false),
    useEma: flag('USE_EMA', true),
    useRev: flag('USE_REV', true),
    useBrk: flag('USE_BRK', true),
    useTrend: flag('USE_TREND', true),
    trendLen: num('TREND_LEN', 50),
    minEdge: num('MIN_EDGE', 2)
  };
}

function computeEMA(vals, len) {
  const k = 2 / (len + 1), out = new Array(vals.length).fill(null);
  if (!vals.length) return out;
  out[0] = vals[0];
  for (let i = 1; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
  return out;
}
function computeATR(highs, lows, closes, len) {
  const n = highs.length, tr = new Array(n).fill(0), atr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    tr[i] = i === 0
      ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  if (n < len) return atr;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += tr[i];
  atr[len - 1] = sum / len;
  for (let i = len; i < n; i++) atr[i] = (atr[i - 1] * (len - 1) + tr[i]) / len;
  return atr;
}
function computeRSI(closes, len) {
  const n = closes.length, rsi = new Array(n).fill(null);
  if (n <= len) return rsi;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= len; l /= len;
  rsi[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (len - 1) + (d > 0 ? d : 0)) / len;
    l = (l * (len - 1) + (d < 0 ? -d : 0)) / len;
    rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return rsi;
}

function runEngine(bars, p) {
  const n = bars.length;
  const O = bars.map(b => b.open), H = bars.map(b => b.high);
  const L = bars.map(b => b.low), C = bars.map(b => b.close), V = bars.map(b => b.volume || 0);
  const emaF = computeEMA(C, p.emaFastLen), emaS = computeEMA(C, p.emaSlowLen);
  const atr = computeATR(H, L, C, p.atrLen), rsi = computeRSI(C, p.rsiLen);
  const hasVol = V.some(v => v > 0);
  // trend filter: only buy above a slow, rising EMA
  const useTrend = p.useTrend !== false && p.trendLen > 1;
  const emaT = useTrend ? computeEMA(C, p.trendLen) : null;
  const warm = Math.max(p.emaSlowLen, p.atrLen + 1, p.rsiLen + 1, p.donLen + 1, p.sweepLen + 1, 5, useTrend ? Math.min(p.trendLen, 40) : 0);

  let inPos = false, entry = 0, stop = 0, tp1 = 0, tp2 = 0, tp1Hit = false, size = 0, hh = 0, src = '', entryIdx = -1;
  let lastBullCross = -1e9, crossUsed = true, lastExitIdx = -1e9;
  const events = [];

  function finish(i) { inPos = false; lastExitIdx = i; }

  for (let i = 0; i < n; i++) {
    const bullCross = i > 0 && emaF[i] > emaS[i] && emaF[i - 1] <= emaS[i - 1];
    const bearCross = i > 0 && emaF[i] < emaS[i] && emaF[i - 1] >= emaS[i - 1];
    if (bullCross) { lastBullCross = i; crossUsed = false; }
    let exitedThisBar = false;

    if (inPos && i > entryIdx) {
      if (L[i] <= stop) {
        events.push({ time: bars[i].time, type: stop > entry * 1.0001 ? 'TRAIL' : 'SL', price: Math.min(stop, O[i]) });
        finish(i); exitedThisBar = true;
      } else {
        if (!tp1Hit && H[i] >= tp1) {
          tp1Hit = true;
          events.push({ time: bars[i].time, type: 'TP1', price: tp1 });
          size -= p.partialFrac;
          if (p.beAfterTp1) stop = Math.max(stop, entry);
        }
        if (H[i] >= tp2) {
          events.push({ time: bars[i].time, type: 'TP2', price: tp2 });
          finish(i); exitedThisBar = true;
        } else if (p.exitOnCross && bearCross) {
          events.push({ time: bars[i].time, type: 'EXIT', price: C[i] });
          finish(i); exitedThisBar = true;
        } else if (tp1Hit && p.trailMult > 0 && atr[i] != null) {
          hh = Math.max(hh, H[i]);
          stop = Math.max(stop, hh - atr[i] * p.trailMult);
        }
      }
    }

    if (!inPos && i >= warm && atr[i] != null && rsi[i] != null) {
      const cool = !exitedThisBar && (i - lastExitIdx) > p.cooldown;
      const rng = H[i] - L[i];
      const closePos = rng > 0 ? (C[i] - L[i]) / rng : 0.5;
      const green = C[i] > O[i];
      const tags = [];

      if (p.useEma) {
        const window = p.confirmCandle ? Math.max(0, p.confirmWindow - 1) : 0;
        const armed = !crossUsed && (i - lastBullCross) <= window && emaF[i] > emaS[i];
        if (cool && armed && (!p.confirmCandle || green)) { tags.push('EMA'); crossUsed = true; }
      }
      if (p.useRev && green && closePos >= 0.55) {
        let minRsi = 1e9;
        for (let k = i - p.rsiLookback + 1; k <= i; k++) if (rsi[k] != null) minRsi = Math.min(minRsi, rsi[k]);
        const oversoldTurn = minRsi < p.rsiOS && rsi[i] > rsi[i - 1] && rsi[i] > minRsi && (C[i] - O[i]) >= p.revBody * atr[i];
        let priorLow = 1e18;
        for (let k = i - p.sweepLen; k < i; k++) priorLow = Math.min(priorLow, L[k]);
        const sweep = L[i] < priorLow && C[i] > priorLow;
        if (oversoldTurn || sweep) tags.push('REV');
      }
      if (p.useBrk && cool && green && C[i] > emaS[i]) {
        let hi = 0;
        for (let k = i - p.donLen; k < i; k++) hi = Math.max(hi, H[k]);
        let volOk = true;
        if (hasVol) {
          let s = 0;
          for (let k = i - p.donLen; k < i; k++) s += V[k];
          volOk = V[i] >= p.volMult * (s / p.donLen);
        }
        if (C[i] > hi && volOk) tags.push('BRK');
      }

      const trendOk = !useTrend || (C[i] > emaT[i] && emaT[i] > emaT[i - 3]);
      if (tags.length && trendOk) {
        const swingLow = Math.min(L[i], L[i - 1], L[i - 2]);
        const stopPx = swingLow - atr[i] * p.atrMultSL;
        const risk = C[i] - stopPx;
        // cost filter: the first profit target must be clearly bigger than what the trade costs
        const edgeOk = !(p.minEdge > 0) || (risk * p.rrTp1 / C[i] * 100) >= p.minEdge * p.costPct;
        if (risk > 0 && edgeOk) {
          inPos = true; entry = C[i]; stop = stopPx;
          tp1 = entry + risk * p.rrTp1; tp2 = entry + risk * p.rrTp2;
          tp1Hit = false; size = 1; hh = H[i]; src = tags.join('+'); entryIdx = i;
          events.push({ time: bars[i].time, type: 'BUY', price: C[i], src });
        }
      }
    }
  }
  return { events, inPos, entry, stop, tp1, tp2, src, last: bars[n - 1] };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fetch with timeout; on 429 (too many requests) or a network error: wait and try again
const gtCalls = [];
async function gtThrottle(){
  for (;;){
    const now = Date.now();
    while (gtCalls.length && now - gtCalls[0] > 60000) gtCalls.shift();
    if (gtCalls.length < num('GT_PER_MIN', 9)) { gtCalls.push(now); return; }
    await sleep(Math.min(5000, 60000 - (now - gtCalls[0]) + 50));
  }
}
async function fetchJson(url, ms = 12000, tries = 3){
  for (let attempt = 0; ; attempt++){
    if (url.includes('geckoterminal.com')) await gtThrottle();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429 && attempt < tries){
        const ra = Number(res.headers.get('retry-after'));
        await sleep((ra > 0 ? Math.min(ra, 30) : 3 * (attempt + 1)) * 1000); continue;
      }
      if (!res.ok) throw new Error(res.status + ' ' + url);
      return await res.json();
    } catch (e){
      if (attempt >= tries || /^\d{3} /.test(e.message)) throw e;
      await sleep(2000 * (attempt + 1));
    } finally { clearTimeout(t); }
  }
}

async function fetchBestPair(tokenAddress) {
  const data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(tokenAddress));
  const pairs = (data && data.pairs) || [];
  if (!pairs.length) throw new Error('geen pool voor ' + tokenAddress);
  const liqOf = x => (x.liquidity && x.liquidity.usd) || 0;
  const tok = String(tokenAddress).toLowerCase();
  // prefer pools where this coin is the base token; otherwise a pool where it is the quote ("money") side
  let best = pairs.filter(x => x.baseToken && String(x.baseToken.address).toLowerCase() === tok).sort((a, b) => liqOf(b) - liqOf(a))[0];
  if (!best){
    const q = pairs.filter(x => x.quoteToken && String(x.quoteToken.address).toLowerCase() === tok).sort((a, b) => liqOf(b) - liqOf(a))[0];
    if (!q) throw new Error('geen pool met dit token: ' + tokenAddress);
    best = Object.assign({}, q, { baseToken: q.quoteToken, quoteToken: q.baseToken, inverted: true });
  }
  return { pair: best, poolAddress: best.pairAddress, network: chainMap[best.chainId] || best.chainId };
}

async function fetchOHLCV(network, poolAddress, unit, aggregate, tokenAddress) {
  // token=<address>: candles are always the price of OUR coin, also in pools where it is the quote token
  const url = 'https://api.geckoterminal.com/api/v2/networks/' + network + '/pools/' + poolAddress + '/ohlcv/' + unit + '?aggregate=' + aggregate + '&limit=300'
    + (tokenAddress ? '&token=' + encodeURIComponent(tokenAddress) : '');
  const json = await fetchJson(url);
  const list = (json.data && json.data.attributes && json.data.attributes.ohlcv_list) || [];
  const bars = list.map(r => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }))
    .filter(b => b.close > 0);
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
}

async function notify(text) {
  console.log(new Date().toISOString(), text.replace(/\n/g, ' | '));
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
    if (!res.ok) console.error('Telegram fout', res.status, await res.text());
  } catch (e){ console.error('Telegram fout', e.message); }
}
live.setNotify(notify);

let manualStop = false;   // set by /stop in Telegram: no new buys until /hervat
let autoTokens = [];      // coins the bot picked itself (AUTO_COINS)
function activeTokens(){
  const set = new Set([...TOKEN_LIST, ...autoTokens]);
  coins.forEach((c, t) => { if (live.isOpen(t)) set.add(t); });   // keep managing a position even if the coin was dropped
  return [...set];
}
function exitOnly(token){ return !TOKEN_LIST.includes(token) && !autoTokens.includes(token); }

// per coin: pool, seen signals, the candle that was still forming at the previous tick, latest strategy state
const coins = new Map();
function coin(token){
  let c = coins.get(token);
  if (!c){ c = { ctx: null, seen: new Set(), first: true, cutoff: null, engine: null, lastSync: 0, lastWatchFire: 0, params: null, pendingParams: null, paused: false, tunedAt: 0 }; coins.set(token, c); }
  return c;
}
function paramsFor(c){ return Object.assign(getParams(), (c && c.params) || {}); }
function infoOf(c, token){
  const p = c.ctx && c.ctx.pair;
  return { symbol: (p && p.baseToken && p.baseToken.symbol) || token.slice(0, 6), liquidityUsd: p && p.liquidity ? Number(p.liquidity.usd) : NaN, partialFrac: paramsFor(c).partialFrac };
}

async function tickOne(token) {
  const [unit, agg] = TIMEFRAME.split(':');
  const c = coin(token);
  if (!c.ctx) {
    c.ctx = await fetchBestPair(token);
    await notify('Watch · ' + infoOf(c, token).symbol + ' · ' + TIMEFRAME);
  }
  const bars = await fetchOHLCV(c.ctx.network, c.ctx.poolAddress, unit, agg, token);
  if (bars.length < 60) {
    console.log(token.slice(0, 6), 'te weinig candles', bars.length);
    return [];
  }
  // new settings from the auto-tuner are only switched in while the bot has no open position on this coin
  if (c.pendingParams && !live.isOpen(token)){
    c.params = c.pendingParams; c.pendingParams = null; c.first = true;   // first tick with new settings = history only
    await notify('🧠 ' + infoOf(c, token).symbol + ': nieuwe instellingen actief');
  }
  const res = runEngine(bars, paramsFor(c));
  c.engine = { inPos: res.inPos, stop: res.stop, entry: res.entry, time: Date.now() };
  const tag = infoOf(c, token).symbol;
  const formingTime = bars[bars.length - 1].time;
  // Only candles that were still forming at the previous tick (or newer) can hold new signals. Older candles were
  // already closed and evaluated; a signal that "appears" there comes from the 300-candle window shifting → stale.
  const fresh = [];
  let stale = 0;
  for (const e of res.events) {
    if (e.type === 'BUY' && e.time === formingTime) continue;   // candle not closed yet: a BUY can still disappear
    const key = e.time + '-' + e.type;
    if (c.seen.has(key)) continue;
    c.seen.add(key);
    if (!c.first && c.cutoff != null && e.time < c.cutoff) { stale++; continue; }
    fresh.push(e);
  }
  c.cutoff = formingTime;
  if (c.seen.size > 5000) c.seen = new Set([...c.seen].slice(-2000));
  if (c.first) {
    c.first = false;
    console.log(tag, 'historie overgeslagen:', res.events.length, '· $' + fmtPrice(res.last.close));
    return [];
  }
  if (stale) console.log(tag, stale, 'oud signaal/signalen genegeerd (verschoven candle-venster)');
  for (const e of fresh) {
    await notify([tag, e.type, e.src ? '(' + e.src + ')' : '', '@ $' + fmtPrice(e.price)].filter(Boolean).join(' '));
  }
  if (live.liveEnabled()) {
    let todo = fresh;
    if (manualStop && todo.some(e => e.type === 'BUY')){
      await notify('⏸️ ' + tag + ': BUY niet uitgevoerd — je hebt de bot gestopt met /stop (verkopen gaan door, /hervat om weer te kopen)');
      todo = todo.filter(e => e.type !== 'BUY');
    }
    if (exitOnly(token) && todo.some(e => e.type === 'BUY')){
      console.log(tag, 'BUY overgeslagen: coin staat niet meer op de lijst (alleen nog verkopen)');
      todo = todo.filter(e => e.type !== 'BUY');
    }
    if (c.paused && todo.some(e => e.type === 'BUY')){
      await notify('⏸️ ' + tag + ': BUY niet uitgevoerd — coin is gepauzeerd door de auto-tune (de strategie werkt hier nu niet)');
      todo = todo.filter(e => e.type !== 'BUY');
    }
    if (todo.length) await live.handleLiveEvents(todo, token, infoOf(c, token));
    await syncOne(token, c);
  }
  if (!fresh.length) console.log(new Date().toISOString(), tag, 'geen nieuw signaal · $' + fmtPrice(res.last.close));
  return fresh;
}

// strategy is out, but the bot wallet still holds the coin (a sell failed) → try again, at most once a minute
async function syncOne(token, c){
  if (!c.engine || c.engine.inPos) return;
  if (!(await live.positionOpen(token))) return;
  if (Date.now() - c.lastSync < 60000) return;
  c.lastSync = Date.now();
  await notify('SYNC ' + infoOf(c, token).symbol + ': strategie is uit de positie maar de wallet heeft het token nog — opnieuw verkopen');
  await live.handleLiveEvents([{ type: 'SYNC' }], token, infoOf(c, token));
}

// Stop-watch: between candle refreshes, check the live price every few seconds against the strategy's stop.
async function stopWatchTick(){
  if (!live.liveEnabled() || !STOPWATCH_MS) return;
  const open = activeTokens().filter(t => { const c = coins.get(t); return c && c.engine && c.engine.inPos && c.engine.stop > 0 && live.isOpen(t); });
  if (!open.length) return;
  let data;
  try { data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + open.slice(0, 30).join(','), 8000, 1); }
  catch (e){ console.error('stop-wachter: prijs ophalen mislukt', e.message); return; }
  for (const token of open){
    const c = coins.get(token);
    const pairs = ((data && data.pairs) || []).filter(p => p.baseToken && p.baseToken.address === token)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const price = pairs.length ? Number(pairs[0].priceUsd) : NaN;
    if (!(price > 0) || price > c.engine.stop) continue;
    if (Date.now() - c.lastWatchFire < 30000) continue;
    c.lastWatchFire = Date.now();
    await notify('🛑 Stop-wachter ' + infoOf(c, token).symbol + ': prijs $' + fmtPrice(price) + ' onder stop $' + fmtPrice(c.engine.stop) + ' — direct verkopen');
    await live.handleLiveEvents([{ type: 'SL', price }], token, infoOf(c, token));
  }
}

// ---------- auto-tune: find better settings per coin, but only adopt them if they also win on unseen data ----------
const AUTO_TUNE = (process.env.AUTO_TUNE || '0').toLowerCase();
const TUNE_ON = AUTO_TUNE === '1' || AUTO_TUNE === 'true' || AUTO_TUNE === 'suggest';
const TUNE_APPLY = AUTO_TUNE === '1' || AUTO_TUNE === 'true';
const TUNE_EVERY_H = Math.max(1, num('TUNE_EVERY_H', 12));
const TUNE_DAYS = Math.min(30, Math.max(3, num('TUNE_DAYS', 14)));
const PAUSE_BAD = flag('PAUSE_BAD_COINS', true);

// same trade maths as the web app: TP1 sells partialFrac, the rest leaves at the final exit; costs once per trade
function tradesFromEvents(events, p){
  const out = []; let entry = null, entryTime = 0, size = 0, gross = 0;
  for (const e of events){
    if (e.type === 'BUY'){ entry = e.price; entryTime = e.time; size = 1; gross = 0; continue; }
    if (entry == null) continue;
    if (e.type === 'TP1'){ gross += p.partialFrac * (e.price / entry - 1); size -= p.partialFrac; continue; }
    gross += size * (e.price / entry - 1);
    out.push({ entryTime, exitTime: e.time, ret: gross - p.costPct / 100 });
    entry = null;
  }
  return out;
}
function growth(trades){
  let e = 1, peak = 1, dd = 0, win = 0, loss = 0;
  trades.forEach(t => { e *= 1 + t.ret; peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); if (t.ret > 0) win += t.ret; else loss -= t.ret; });
  return { e, dd, n: trades.length, pf: loss > 0 ? win / loss : (win > 0 ? Infinity : 0) };
}
async function fetchHistory(network, poolAddress, unit, aggregate, fromSec, tokenAddress){
  const all = new Map(); let before = null;
  for (let page = 0; page < 12; page++){
    const url = 'https://api.geckoterminal.com/api/v2/networks/' + network + '/pools/' + poolAddress + '/ohlcv/' + unit + '?aggregate=' + aggregate
      + '&limit=1000' + (before ? '&before_timestamp=' + before : '') + (tokenAddress ? '&token=' + encodeURIComponent(tokenAddress) : '');
    const json = await fetchJson(url, 15000);
    const list = (json.data && json.data.attributes && json.data.attributes.ohlcv_list) || [];
    if (!list.length) break;
    let oldest = Infinity;
    list.forEach(r => { const b = { time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }; if (b.close > 0){ all.set(b.time, b); oldest = Math.min(oldest, b.time); } });
    if (oldest <= fromSec || list.length < 1000) break;
    before = oldest;
    await sleep(num('TUNE_PAGE_PAUSE_MS', 7000));   // stay well under the free ~10 calls/min
  }
  return [...all.values()].sort((a, b) => a.time - b.time);
}
function tuneGrid(base){
  const sets = [{ useEma: true, useRev: false, useBrk: false }, { useEma: false, useRev: true, useBrk: false }, { useEma: false, useRev: false, useBrk: true },
    { useEma: true, useRev: false, useBrk: true }, { useEma: true, useRev: true, useBrk: true }];
  const out = [];
  for (const f of [3, 5, 8, 12]) for (const sl of [13, 21, 34, 55]) if (f < sl)
    for (const a of [0.8, 1.0, 1.5, 2.0]) for (const t1 of [0.8, 1.0, 1.5]) for (const t2 of [2, 3, 5]) for (const flags of sets) for (const tr of [true, false])
      out.push(Object.assign({}, base, flags, { emaFastLen: f, emaSlowLen: sl, atrMultSL: a, rrTp1: t1, rrTp2: t2, useTrend: tr }));
  return out;
}
const TUNE_KEYS = ['emaFastLen', 'emaSlowLen', 'atrMultSL', 'rrTp1', 'rrTp2', 'useEma', 'useRev', 'useBrk', 'useTrend'];
const ENV_NAME = { emaFastLen: 'EMA_FAST', emaSlowLen: 'EMA_SLOW', atrMultSL: 'ATR_MULT_SL', rrTp1: 'RR_TP1', rrTp2: 'RR_TP2', useEma: 'USE_EMA', useRev: 'USE_REV', useBrk: 'USE_BRK', useTrend: 'USE_TREND' };
function describe(p){ return 'EMA ' + p.emaFastLen + '/' + p.emaSlowLen + ' · SL ' + p.atrMultSL + '×ATR · TP ' + p.rrTp1 + '/' + p.rrTp2 + ' · ' + [p.useEma && 'EMA', p.useRev && 'Dip', p.useBrk && 'Breakout'].filter(Boolean).join('+') + (p.useTrend ? ' · trend' : ''); }
const pctStr = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

async function evaluateCoin(token){
  const c = coin(token);
  if (!c.ctx) return null;
  const [unit, agg] = TIMEFRAME.split(':');
  const secs = (unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400) * Number(agg);
  const now = Math.floor(Date.now() / 1000), start = now - TUNE_DAYS * 86400;
  const bars = await fetchHistory(c.ctx.network, c.ctx.poolAddress, unit, agg, start - 150 * secs, token);
  const inPeriod = bars.filter(b => b.time >= start);
  const tag = infoOf(c, token).symbol;
  if (inPeriod.length < 200) { console.log('auto-tune', tag, 'te weinig candles', inPeriod.length); return null; }
  const split = inPeriod[Math.floor(inPeriod.length * 0.7)].time;
  const evalP = p => {
    const tr = tradesFromEvents(runEngine(bars, p).events, p).filter(t => t.entryTime >= start);
    return { p, train: growth(tr.filter(t => t.entryTime < split)), test: growth(tr.filter(t => t.entryTime >= split)), full: growth(tr) };
  };
  const cur = evalP(paramsFor(c));
  const grid = tuneGrid(paramsFor(c));
  const results = [];
  for (let i = 0; i < grid.length; i++){
    const r = evalP(grid[i]);
    if (r.train.n >= 8) results.push(Object.assign(r, { rank: Math.log(r.train.e) / (1 + 3 * Math.abs(r.train.dd)) }));
    if (i % 40 === 0) await new Promise(r2 => setImmediate(r2));   // keep the bot (stop-watch, ticks) responsive
  }
  results.sort((a, b) => b.rank - a.rank);
  // pick from the 10 best on the TRAINING part the one that does best on the TEST part it has not seen
  const pool = results.slice(0, 10).filter(r => r.test.n >= 3 && r.test.e > 1.01);   // at least +1% after costs on unseen data
  pool.sort((a, b) => b.test.e - a.test.e);
  const best = pool[0] || null;
  const better = best && best.test.e > cur.test.e + 0.02 && best.full.pf >= 1.1 && TUNE_KEYS.some(k => best.p[k] !== cur.p[k]);
  const worksNow = (cur.test.n >= 3 && cur.test.e > 1.01) || !!best;
  return { cur, best, better, worksNow, tag };
}
function applyParams(c, token, p){
  const newP = {}; TUNE_KEYS.forEach(k => { newP[k] = p[k]; });
  if (live.isOpen(token)){ c.pendingParams = newP; return 'pending'; }
  c.params = newP; c.first = true; return 'applied';
}
async function tuneOne(token){
  const c = coin(token);
  const ev = await evaluateCoin(token);
  if (!ev) return null;
  const { cur, best, better, worksNow, tag } = ev;
  c.tunedAt = Date.now();
  let msg = '🧠 Auto-tune ' + tag + ' (' + TUNE_DAYS + ' dagen, ' + TIMEFRAME + '): nu ' + describe(cur.p) + ' → testdeel ' + pctStr(cur.test.e - 1) + ' (' + cur.test.n + ' trades)';
  if (better){
    msg += '\nBeter gevonden: ' + describe(best.p) + ' → testdeel ' + pctStr(best.test.e - 1) + ' (' + best.test.n + ' trades), hele periode ' + pctStr(best.full.e - 1) + ', PF ' + (isFinite(best.full.pf) ? best.full.pf.toFixed(2) : '∞');
    if (TUNE_APPLY){
      msg += applyParams(c, token, best.p) === 'pending' ? '\n→ wordt actief zodra de open positie gesloten is.' : '\n→ toegepast.';
      msg += '\nVast bewaren? Zet in Railway: ' + TUNE_KEYS.map(k => ENV_NAME[k] + '=' + (typeof best.p[k] === 'boolean' ? (best.p[k] ? 1 : 0) : best.p[k])).join(' ');
    } else msg += '\n(alleen voorstel — AUTO_TUNE=suggest)';
  } else msg += '\nGeen duidelijk betere instellingen — blijft zoals het is.';
  if (TUNE_APPLY && PAUSE_BAD){
    if (!worksNow && !c.paused){ c.paused = true; msg += '\n⏸️ Geen enkele instelling maakt winst in het testdeel: geen nieuwe buys op deze coin tot een volgende tune (verkopen gaan gewoon door).'; }
    else if (worksNow && c.paused){ c.paused = false; msg += '\n▶️ Pauze opgeheven: de strategie werkt weer op deze coin.'; }
  }
  await notify(msg);
  saveState();
  return { cur, best, better, paused: c.paused };
}
let tuning = false;
async function tuneAll(){
  if (!TUNE_ON || tuning) return;
  tuning = true;
  try {
    for (const token of TOKEN_LIST){   // coins picked by AUTO_COINS are re-checked by pickCoins
      try { await tuneOne(token); } catch (e){ console.error('auto-tune fout', token.slice(0, 6), e.message); }
      await sleep(8000);
    }
  } finally { tuning = false; }
}

// ---------- the bot picks its own coins (AUTO_COINS) ----------
const AUTO_COINS = Math.max(0, Math.min(5, Math.floor(num('AUTO_COINS', 0))));
const AUTO_MIN_LIQ = num('AUTO_MIN_LIQ_USD', 1000000);
const AUTO_LIST = (process.env.AUTO_LIST || 'TRUMP,PENGU,BONK,WIF,FARTCOIN,USELESS,POPCAT,BOME,MEW,PNUT,GIGA,GOAT,MOODENG,JUP')
  .split(/[,;\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
let picking = false;
async function findBySymbol(sym){
  const data = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(sym), 9000, 1);
  const cands = ((data && data.pairs) || []).filter(p => p.chainId === 'solana' && p.baseToken && String(p.baseToken.symbol).toUpperCase() === sym)
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  return cands[0] || null;   // copycats with the same name have far less liquidity
}
async function pickCoins(){
  if (!AUTO_COINS || picking) return;
  picking = true;
  try {
    const scored = [], dropped = [];
    for (const sym of AUTO_LIST){
      try {
        const pr = await findBySymbol(sym);
        if (!pr){ dropped.push(sym + ' (niet gevonden)'); continue; }
        const liq = (pr.liquidity && pr.liquidity.usd) || 0;
        if (liq < AUTO_MIN_LIQ){ dropped.push(sym + ' (liquiditeit $' + Math.round(liq / 1000) + 'K)'); continue; }
        const token = pr.baseToken.address;
        const c = coin(token);
        c.ctx = { pair: pr, poolAddress: pr.pairAddress, network: 'solana' };
        const ev = await evaluateCoin(token);
        if (!ev){ dropped.push(sym + ' (te weinig data)'); continue; }
        const useBest = ev.best && (ev.better || !(ev.cur.test.n >= 3 && ev.cur.test.e > 1.01));
        const pick = useBest ? ev.best : ev.cur;
        const ok = pick.test.n >= 3 && pick.test.e > 1.01 && pick.full.pf >= 1.1;
        if (ok) scored.push({ token, sym, score: pick.test.e, pick, useBest });
        else dropped.push(sym + ' (testdeel ' + pctStr(pick.test.e - 1) + ')');
      } catch (e){ dropped.push(sym + ' (fout: ' + e.message.slice(0, 40) + ')'); }
      await sleep(1500);
    }
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, AUTO_COINS);
    chosen.forEach(x => { if (x.useBest) applyParams(coin(x.token), x.token, x.pick.p); coin(x.token).paused = false; });
    const before = autoTokens.slice();
    autoTokens = chosen.map(x => x.token);
    const leaving = before.filter(t => !autoTokens.includes(t));
    let msg = '🔎 Coin-keuze (' + TUNE_DAYS + ' dagen, ' + TIMEFRAME + '): ';
    msg += chosen.length ? 'gekozen ' + chosen.map(x => x.sym + ' (testdeel ' + pctStr(x.score - 1) + ')').join(', ') : 'geen enkele coin is nu overtuigend — de bot koopt niets nieuws';
    if (leaving.length) msg += '\nAfgevallen: ' + leaving.map(t => infoOf(coin(t), t).symbol).join(', ') + (leaving.some(t => live.isOpen(t)) ? ' (open posities worden nog netjes verkocht)' : '');
    if (dropped.length) msg += '\nNiet gekozen: ' + dropped.slice(0, 10).join(' · ');
    await notify(msg);
    saveState();
    return chosen;
  } finally { picking = false; }
}

// ---------- trade journal, total loss limit, memory ----------
const fs = require('fs'), path = require('path');
const DATA_DIR = (process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
const STATE_FILE = DATA_DIR ? path.join(DATA_DIR, 'bot-state.json') : '';
const MAX_TOTAL_LOSS = num('MAX_TOTAL_LOSS_SOL', 0.1);
let journal = [];          // every closed live trade
let lossBaseline = 0;      // /hervat after the loss limit starts counting again from here
const totalPnl = () => journal.reduce((a, t) => a + (Number(t.pnlSol) || 0), 0);
live.setJournal(t => {
  journal.push(t);
  if (journal.length > 1000) journal = journal.slice(-1000);
  const run = totalPnl() - lossBaseline;
  if (MAX_TOTAL_LOSS > 0 && run <= -MAX_TOTAL_LOSS && !manualStop){
    manualStop = true;
    notify('🛑 Totale verlieslimiet bereikt: ' + run.toFixed(4) + ' SOL (max ' + MAX_TOTAL_LOSS + '). De bot koopt niets meer; open posities worden nog verkocht. Bekijk /rapport — /hervat om toch door te gaan.');
  }
  saveState();
});
function saveState(){
  if (!STATE_FILE) return;
  try {
    const o = { v: 1, savedAt: Date.now(), manualStop, autoTokens, lossBaseline, journal: journal.slice(-500), live: live.exportState(), lastReportDay, coins: {} };
    coins.forEach((c, t) => { o.coins[t] = { params: c.params, pendingParams: c.pendingParams, paused: c.paused, tunedAt: c.tunedAt }; });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(o));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e){ console.error('geheugen opslaan mislukt', e.message); }
}
function loadState(){
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return false;
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    manualStop = !!o.manualStop; autoTokens = Array.isArray(o.autoTokens) ? o.autoTokens : [];
    lossBaseline = Number(o.lossBaseline) || 0; journal = Array.isArray(o.journal) ? o.journal : [];
    lastReportDay = o.lastReportDay || '';
    Object.entries(o.coins || {}).forEach(([t, v]) => { const c = coin(t); c.params = v.params || null; c.pendingParams = v.pendingParams || null; c.paused = !!v.paused; c.tunedAt = v.tunedAt || 0; });
    live.importState(o.live);
    return true;
  } catch (e){ console.error('geheugen laden mislukt', e.message); return false; }
}
function reportText(){
  if (!journal.length) return '📒 Nog geen afgesloten live trades.';
  const by = {};
  journal.forEach(t => { const k = t.symbol || t.mint.slice(0, 6); by[k] = by[k] || { n: 0, w: 0, pnl: 0 }; by[k].n++; if (t.pnlSol > 0) by[k].w++; by[k].pnl += t.pnlSol; });
  const lines = ['📒 Resultaat live trades (' + journal.length + '):'];
  Object.entries(by).sort((a, b) => b[1].pnl - a[1].pnl).forEach(([k, v]) => lines.push('• ' + k + ': ' + v.n + ' trades · ' + Math.round(v.w / v.n * 100) + '% winst · ' + (v.pnl >= 0 ? '+' : '') + v.pnl.toFixed(4) + ' SOL'));
  const tot = totalPnl();
  lines.push('Totaal: ' + (tot >= 0 ? '+' : '') + tot.toFixed(4) + ' SOL' + (MAX_TOTAL_LOSS > 0 ? ' · verlieslimiet ' + MAX_TOTAL_LOSS + ' SOL (nog ' + Math.max(0, MAX_TOTAL_LOSS + (tot - lossBaseline)).toFixed(4) + ' ruimte)' : ''));
  lines.push('Laatste: ' + journal.slice(-5).reverse().map(t => (t.symbol || '?') + ' ' + (t.pnlSol >= 0 ? '+' : '') + t.pnlSol.toFixed(4)).join(' · '));
  return lines.join('\n');
}

// ---------- Telegram: control the bot from your phone ----------
const TG_CMDS = flag('TELEGRAM_COMMANDS', true) && TG_TOKEN && TG_CHAT;
const REPORT_HOUR = num('REPORT_HOUR', 21);
let tgOffset = 0, sellAllAsked = 0, tgWarned = false;
function nlNow(){ const d = new Date(); const parts = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => (parts.find(x => x.type === t) || {}).value; return { hour: Number(g('hour')), day: g('year') + '-' + g('month') + '-' + g('day') }; }
function statusText(){
  const lines = [];
  lines.push((live.liveEnabled() ? '🟢 Live handelen AAN' : '⚪ Live handelen UIT (alleen signalen)') + (manualStop ? ' · ⏸️ gestopt met /stop (geen nieuwe buys)' : ''));
  const d = live._day || {};
  if (live.liveEnabled()) lines.push('Vandaag: ' + (d.buys || 0) + ' buys · resultaat ≈ ' + ((d.pnlSol || 0) >= 0 ? '+' : '') + (d.pnlSol || 0).toFixed(4) + ' SOL');
  if (AUTO_COINS) lines.push('Zelf gekozen coins: ' + (autoTokens.length ? autoTokens.map(t => infoOf(coin(t), t).symbol).join(', ') : 'geen (niets overtuigend)'));
  for (const token of activeTokens()){
    const c = coins.get(token);
    if (!c || !c.ctx){ lines.push('• ' + token.slice(0, 6) + ': nog niet geladen'); continue; }
    const tag = infoOf(c, token).symbol;
    const parts = [];
    parts.push(live.isOpen(token) ? '💼 bot heeft positie' : 'geen positie');
    if (c.engine) parts.push(c.engine.inPos ? 'strategie: in trade' : 'strategie: wacht');
    if (c.paused) parts.push('⏸️ gepauzeerd (auto-tune)');
    if (exitOnly(token)) parts.push('alleen nog verkopen (coin afgevallen)');
    if (c.params) parts.push('eigen instellingen: ' + describe(paramsFor(c)));
    if (c.pendingParams) parts.push('nieuwe instellingen na sluiten positie');
    lines.push('• ' + tag + ': ' + parts.join(' · '));
  }
  lines.push('Auto-tune: ' + (TUNE_ON ? (TUNE_APPLY ? 'aan' : 'alleen voorstellen') : 'uit') + ' · stop-wachter: ' + (STOPWATCH_MS ? 'aan' : 'uit'));
  return lines.join('\n');
}
async function tgSend(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) });
  } catch (e){ console.error('Telegram fout', e.message); }
}
async function handleCommand(text){
  const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const arg = String(text || '').trim().split(/\s+/).slice(1).join(' ').toUpperCase();
  if (cmd === '/status') return tgSend(statusText());
  if (cmd === '/rapport') return tgSend(reportText());
  if (cmd === '/coins'){
    if (!AUTO_COINS) return tgSend('Zelf coins kiezen staat uit. Zet AUTO_COINS=3 in Railway om het aan te zetten.');
    if (picking) return tgSend('De coin-keuze is al bezig.');
    await tgSend('🔎 Coins worden opnieuw gekozen, dat duurt een paar minuten…'); pickCoins(); return;
  }
  if (cmd === '/stop'){ manualStop = true; saveState(); console.log('Telegram: /stop'); return tgSend('⏸️ Gestopt: geen nieuwe buys meer. Open posities worden nog wel verkocht bij hun stop of doel.\n/hervat = weer kopen · /verkoopalles = alles nu verkopen'); }
  if (cmd === '/hervat'){ manualStop = false; if (MAX_TOTAL_LOSS > 0 && totalPnl() - lossBaseline <= -MAX_TOTAL_LOSS) lossBaseline = totalPnl(); saveState(); console.log('Telegram: /hervat'); return tgSend('▶️ Hervat: de bot mag weer kopen' + (live.liveEnabled() ? '.' : ' (maar live handelen staat UIT in Railway: alleen signalen).')); }
  if (cmd === '/verkoopalles'){
    const open = activeTokens().filter(t => live.isOpen(t));
    if (!live.liveEnabled()) return tgSend('Live handelen staat uit — er is niets te verkopen.');
    if (!open.length) return tgSend('De bot heeft geen open posities.');
    if (arg !== 'JA' || Date.now() - sellAllAsked > 120000){
      sellAllAsked = Date.now();
      return tgSend('Weet je het zeker? Dit verkoopt nu ' + open.length + ' positie(s) en stopt nieuwe buys.\nStuur binnen 2 minuten: /verkoopalles JA');
    }
    sellAllAsked = 0; manualStop = true; saveState();
    await tgSend('Verkopen… (nieuwe buys staan uit, /hervat om weer te kopen)');
    for (const t of open){ const c = coin(t); await live.handleLiveEvents([{ type: 'EXIT' }], t, infoOf(c, t)); }
    return;
  }
  if (cmd === '/tune'){
    if (!TUNE_ON) return tgSend('Auto-tune staat uit. Zet AUTO_TUNE=suggest of AUTO_TUNE=1 in Railway.');
    if (tuning) return tgSend('Auto-tune is al bezig.');
    await tgSend('🧠 Auto-tune gestart, de uitkomst volgt per coin…');
    tuneAll(); return;
  }
  if (cmd === '/start') return tgSend(statusText() + '\n\nStuur /help voor de commando\'s.');
  if (cmd.startsWith('/'))
    return tgSend('Commando\'s:\n/status — hoe staat de bot ervoor\n/rapport — wat leverde elke coin op\n/coins — opnieuw coins kiezen (AUTO_COINS)\n/stop — geen nieuwe buys (noodstop)\n/hervat — weer kopen\n/verkoopalles — alle bot-posities nu verkopen\n/tune — nu betere instellingen zoeken\n/help — deze lijst');
}
async function pollTelegram(){
  if (!TG_CMDS) return;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 35000);
    let data;
    try {
      const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?timeout=25&offset=' + tgOffset, { signal: ctrl.signal });
      data = await res.json();
    } finally { clearTimeout(t); }
    if (data && data.ok === false){
      // e.g. wrong token (401) or a webhook on this bot (409): say it once, then check again only every minute
      if (!tgWarned){ tgWarned = true; console.error('Telegram-commando\'s werken niet:', data.error_code, data.description); }
      await sleep(60000); return;
    }
    tgWarned = false;
    for (const u of (data && data.result) || []){
      tgOffset = u.update_id + 1;
      const m = u.message || u.edited_message;
      // only YOUR chat may give commands; everyone else is ignored
      if (!m || String(m.chat && m.chat.id) !== TG_CHAT || typeof m.text !== 'string') continue;
      await handleCommand(m.text);
    }
  } catch (e){ if (e.name !== 'AbortError') { console.error('Telegram commando-fout', e.message); await sleep(5000); } }
}
let lastReportDay = '';
async function dailyReport(){
  if (REPORT_HOUR < 0 || !TG_TOKEN || !TG_CHAT) return;
  const n = nlNow();
  if (n.hour !== REPORT_HOUR || lastReportDay === n.day) return;
  lastReportDay = n.day;
  saveState();
  await tgSend('📊 Dagrapport ' + n.day + '\n' + statusText() + '\n\n' + reportText());
}

async function tick() {
  const list = activeTokens();
  if (!list.length){
    if (!AUTO_COINS) throw new Error('Zet TOKEN_ADDRESS in Railway (één mint of mint1,mint2,mint3) of AUTO_COINS=3');
    console.log('nog geen coins gekozen — wacht op de coin-keuze');
    return;
  }
  for (const token of list) {
    const c = coin(token);
    try {
      await tickOne(token);
      c.errCount = 0;
    } catch (err) {
      console.error('tick fout', token.slice(0, 6), err.message);
      c.ctx = null;
      c.errCount = (c.errCount || 0) + 1;
      if (c.errCount === 5) await notify('⚠️ ' + token.slice(0, 6) + ': al 5 keer achter elkaar een fout (' + err.message.slice(0, 80) + '). De bot probeert het gewoon verder; blijft dit, kijk dan in de Railway-logs.');
    }
    await sleep(1200);
  }
}

async function loop() {
  try { await tick(); } catch (err) { console.error('tick fout', err.message); }
  setTimeout(loop, POLL_MS);
}

async function start(){
  const restored = loadState();
  console.log(STATE_FILE ? (restored ? 'Geheugen geladen uit ' + STATE_FILE : 'Geheugen: nieuw bestand ' + STATE_FILE) : 'Geheugen: UIT (geen Railway Volume) — /stop, gekozen coins en instellingen worden vergeten bij een herstart');
  console.log('Signaal worker start. Tokens=', TOKEN_LIST.length ? TOKEN_LIST.length : '(LEEG)', TOKEN_LIST.map(t => t.slice(0, 6)).join(','), 'tf=', TIMEFRAME, 'poll=', POLL_MS + 'ms', 'stop-wachter=', STOPWATCH_MS ? STOPWATCH_MS + 'ms' : 'uit');
  try { await notify(await live.startupReport()); } catch (e){ console.error('LIVE start-fout:', e.message); }
  loop();
  if (STOPWATCH_MS) setInterval(() => { stopWatchTick().catch(e => console.error('stop-wachter fout', e.message)); }, STOPWATCH_MS);
  if (TG_CMDS){
    console.log('Telegram-commando\'s AAN (/status /stop /hervat /verkoopalles /tune)');
    (async function tgLoop(){
      for (;;){
        const t0 = Date.now();
        await pollTelegram();
        // never spin: if Telegram answered instantly, wait a moment so the rest of the bot keeps running
        if (Date.now() - t0 < 1000) await sleep(1000);
      }
    })();
  }
  setInterval(() => { dailyReport().catch(() => {}); }, 60000);
  setInterval(saveState, 60000);
  if (!STATE_FILE && live.liveEnabled()) notify('ℹ️ Tip: koppel in Railway een Volume aan deze service, dan onthoudt de bot /stop, zijn gekozen coins en instellingen ook na een herstart.');
  if (restored && manualStop) notify('⏸️ Herstart: de bot staat nog op /stop (onthouden). /hervat om weer te kopen.');
  if (AUTO_COINS){
    console.log('Zelf coins kiezen AAN: max', AUTO_COINS, 'uit', AUTO_LIST.join(','), '· min. liquiditeit $' + AUTO_MIN_LIQ);
    setTimeout(() => { pickCoins().catch(e => console.error('coin-keuze fout', e.message)); }, restored && autoTokens.length ? 30 * 60 * 1000 : 60 * 1000);
    setInterval(() => { pickCoins().catch(e => console.error('coin-keuze fout', e.message)); }, TUNE_EVERY_H * 3600 * 1000);
  }
  if (TUNE_ON){
    console.log('Auto-tune', TUNE_APPLY ? 'AAN (past toe)' : 'alleen voorstellen', '· elke', TUNE_EVERY_H, 'uur ·', TUNE_DAYS, 'dagen data · coins pauzeren:', PAUSE_BAD ? 'ja' : 'nee');
    setTimeout(() => { tuneAll(); }, 3 * 60 * 1000);   // first run a few minutes after start
    setInterval(() => { tuneAll(); }, TUNE_EVERY_H * 3600 * 1000);
  }
}

if (require.main === module) start();
module.exports = { runEngine, getParams, tickOne, tick, stopWatchTick, syncOne, coins, start, tuneOne, tradesFromEvents, paramsFor, handleCommand, pollTelegram, statusText, dailyReport,
  pickCoins, activeTokens, saveState, loadState, reportText, get manualStop(){ return manualStop; }, get autoTokens(){ return autoTokens; }, get journal(){ return journal; } };
