/**
 * 24/7 signal worker — zelfde strategie als de web-app.
 * Standaard: alleen logs + optioneel Telegram.
 * Live swaps: alleen als ENABLE_LIVE_TRADES=1 en PRIVATE_KEY in Railway Variables (zie liveTrade.js).
 *
 * Variables: TOKEN_ADDRESS (mint1,mint2,…), TIMEFRAME (minute:5), POLL_MS (30000),
 *            STOPWATCH_MS (5000, 0 = uit), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
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
    useBrk: flag('USE_BRK', true)
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
  const warm = Math.max(p.emaSlowLen, p.atrLen + 1, p.rsiLen + 1, p.donLen + 1, p.sweepLen + 1, 5);

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

      if (tags.length) {
        const swingLow = Math.min(L[i], L[i - 1], L[i - 2]);
        const stopPx = swingLow - atr[i] * p.atrMultSL;
        const risk = C[i] - stopPx;
        if (risk > 0) {
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
async function fetchJson(url, ms = 12000, tries = 3){
  for (let attempt = 0; ; attempt++){
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
  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const best = pairs[0];
  return { pair: best, poolAddress: best.pairAddress, network: chainMap[best.chainId] || best.chainId };
}

async function fetchOHLCV(network, poolAddress, unit, aggregate) {
  const url = 'https://api.geckoterminal.com/api/v2/networks/' + network + '/pools/' + poolAddress + '/ohlcv/' + unit + '?aggregate=' + aggregate + '&limit=300';
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

// per coin: pool, seen signals, the candle that was still forming at the previous tick, latest strategy state
const coins = new Map();
function coin(token){
  let c = coins.get(token);
  if (!c){ c = { ctx: null, seen: new Set(), first: true, cutoff: null, engine: null, lastSync: 0, lastWatchFire: 0 }; coins.set(token, c); }
  return c;
}
function infoOf(c, token){
  const p = c.ctx && c.ctx.pair;
  return { symbol: (p && p.baseToken && p.baseToken.symbol) || token.slice(0, 6), liquidityUsd: p && p.liquidity ? Number(p.liquidity.usd) : NaN, partialFrac: getParams().partialFrac };
}

async function tickOne(token) {
  const [unit, agg] = TIMEFRAME.split(':');
  const c = coin(token);
  if (!c.ctx) {
    c.ctx = await fetchBestPair(token);
    await notify('Watch · ' + infoOf(c, token).symbol + ' · ' + TIMEFRAME);
  }
  const bars = await fetchOHLCV(c.ctx.network, c.ctx.poolAddress, unit, agg);
  if (bars.length < 60) {
    console.log(token.slice(0, 6), 'te weinig candles', bars.length);
    return [];
  }
  const res = runEngine(bars, getParams());
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
    if (fresh.length) await live.handleLiveEvents(fresh, token, infoOf(c, token));
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
  const open = TOKEN_LIST.filter(t => { const c = coins.get(t); return c && c.engine && c.engine.inPos && c.engine.stop > 0 && live.isOpen(t); });
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

async function tick() {
  if (!TOKEN_LIST.length) throw new Error('Zet TOKEN_ADDRESS in Railway (één mint of mint1,mint2,mint3)');
  for (const token of TOKEN_LIST) {
    try {
      await tickOne(token);
    } catch (err) {
      console.error('tick fout', token.slice(0, 6), err.message);
      coin(token).ctx = null;
    }
    await sleep(1200);
  }
}

async function loop() {
  try { await tick(); } catch (err) { console.error('tick fout', err.message); }
  setTimeout(loop, POLL_MS);
}

async function start(){
  console.log('Signaal worker start. Tokens=', TOKEN_LIST.length ? TOKEN_LIST.length : '(LEEG)', TOKEN_LIST.map(t => t.slice(0, 6)).join(','), 'tf=', TIMEFRAME, 'poll=', POLL_MS + 'ms', 'stop-wachter=', STOPWATCH_MS ? STOPWATCH_MS + 'ms' : 'uit');
  try { await notify(await live.startupReport()); } catch (e){ console.error('LIVE start-fout:', e.message); }
  loop();
  if (STOPWATCH_MS) setInterval(() => { stopWatchTick().catch(e => console.error('stop-wachter fout', e.message)); }, STOPWATCH_MS);
}

if (require.main === module) start();
module.exports = { runEngine, getParams, tickOne, stopWatchTick, syncOne, coins, start };
