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
 *            DATA_DIR = map om geheugen te bewaren (Railway Volume: wordt automatisch gevonden),
 *            LIVE_LEARN_N (4) / LIVE_PAUSE_H (24) = pauzeer een coin als ≥3 van de laatste 4 ECHTE trades verlies waren (0 = uit),
 *            STAKE_ADAPT (1) = na 2 verliezen op rij de helft inzetten tot de volgende winst (nooit méér dan normaal),
 *            USE_HTF (0), HTF_MULT (4) = alleen kopen als de 4× grotere timeframe ook stijgt (auto-tune kiest dit per coin),
 *            KANSEN (1) = elke KANSEN_EVERY_MIN (10) minuten coins scoren en na KANSEN_H_MIN (60) minuten leren van de uitkomst,
 *            KANSEN_FILTER (auto) = auto: buys met lage kans pas overslaan als de score na ≥200 uitkomsten bewezen beter is; 1 = altijd; 0 = nooit,
 *            KANSEN_MIN (0.45) = minimale kans-score voor een buy als het filter actief is,
 *            LET_RUN (0), RUN_FRAC (0.5) = bij TP2 maar een deel verkopen, de rest met trailing stop laten doorlopen,
 *            USE_CONT (0), CONT_BARS (30) = na een winnende verkoop opnieuw kopen als de trend doorzet (auto-tune kiest dit per coin),
 *            SMART_POLL (1) = kijk vlak na het sluiten van elke candle (+ een tweede keer voor late data) i.p.v. elke POLL_MS,
 *            TP_WATCH (1) = verkoop TP1/TP2 direct zodra de live prijs het doel raakt (net als de stop-wachter),
 *            MAX_COINS (6) = max. aantal coins dat je via Telegram/terminal kunt toevoegen (bovenop TOKEN_ADDRESS niet meer dan dit totaal).
 *            plus de strategie-instellingen (EMA_FAST, EMA_SLOW, ATR_MULT_SL, RR_TP1, RR_TP2, …).
 */
const live = require('./liveTrade');
const { createCopy } = require('./copyTrade');
const { createCloud } = require('./cloudMemory');
const cloud = createCloud();
const buyMeta = new Map();   // mint -> { kind, source, liq, buyTime }: what we knew when buying, for the cloud memory
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
    minEdge: num('MIN_EDGE', 2),
    useHtf: flag('USE_HTF', false),
    letRun: flag('LET_RUN', false),
    runFrac: Math.min(0.95, Math.max(0.05, num('RUN_FRAC', 0.5))),
    useCont: flag('USE_CONT', false),
    contBars: num('CONT_BARS', 30),
    htfMult: num('HTF_MULT', 4),
    htfLen: 20
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
  // higher-timeframe filter: every htfMult candles form one bigger candle; only buy when that bigger trend is up.
  // Uses only bigger candles that are already finished at this moment (no peeking ahead).
  const useHtf = !!p.useHtf && p.htfMult > 1 && p.htfLen > 1;
  let emaH = null;
  if (useHtf){
    const hc = [];
    for (let g = 0; (g + 1) * p.htfMult - 1 < n; g++) hc.push(C[(g + 1) * p.htfMult - 1]);
    emaH = computeEMA(hc, p.htfLen);
  }
  const htfOkAt = i => {
    if (!useHtf) return true;
    const g = Math.floor(i / p.htfMult), done = (i % p.htfMult === p.htfMult - 1) ? g : g - 1;
    return done >= 1 && emaH[done] != null && C[i] > emaH[done] && emaH[done] > emaH[done - 1];
  };

  let inPos = false, entry = 0, stop = 0, tp1 = 0, tp2 = 0, tp1Hit = false, size = 0, hh = 0, src = '', entryIdx = -1;
  let lastBullCross = -1e9, crossUsed = true, lastExitIdx = -1e9;
  let tp2Hit = false, lastWinExitIdx = -1e9, gross = 0;
  const events = [];

  function finish(i) { inPos = false; lastExitIdx = i; if (gross > 0) lastWinExitIdx = i; }

  for (let i = 0; i < n; i++) {
    const bullCross = i > 0 && emaF[i] > emaS[i] && emaF[i - 1] <= emaS[i - 1];
    const bearCross = i > 0 && emaF[i] < emaS[i] && emaF[i - 1] >= emaS[i - 1];
    if (bullCross) { lastBullCross = i; crossUsed = false; }
    let exitedThisBar = false;

    if (inPos && i > entryIdx) {
      if (L[i] <= stop) {
        const px = Math.min(stop, O[i]);
        gross += size * (px / entry - 1);
        events.push({ time: bars[i].time, type: stop > entry * 1.0001 ? 'TRAIL' : 'SL', price: px });
        finish(i); exitedThisBar = true;
      } else {
        if (!tp1Hit && H[i] >= tp1) {
          tp1Hit = true;
          gross += p.partialFrac * (tp1 / entry - 1);
          events.push({ time: bars[i].time, type: 'TP1', price: tp1 });
          size -= p.partialFrac;
          if (p.beAfterTp1) stop = Math.max(stop, entry);
        }
        if (H[i] >= tp2 && !tp2Hit && !p.letRun) {
          gross += size * (tp2 / entry - 1);
          events.push({ time: bars[i].time, type: 'TP2', price: tp2 });
          finish(i); exitedThisBar = true;
        } else {
          // "let it run": at TP2 sell only part, lock in at least TP1 and let a trailing stop ride the rest
          if (H[i] >= tp2 && !tp2Hit && p.letRun) {
            tp2Hit = true;
            const rf = Math.min(0.95, Math.max(0.05, p.runFrac || 0.5));
            gross += size * rf * (tp2 / entry - 1);
            events.push({ time: bars[i].time, type: 'TP2', price: tp2, frac: rf });
            size -= size * rf;
            stop = Math.max(stop, tp1);
          }
          if (p.exitOnCross && bearCross) {
            gross += size * (C[i] / entry - 1);
            events.push({ time: bars[i].time, type: 'EXIT', price: C[i] });
            finish(i); exitedThisBar = true;
          } else if (tp1Hit && p.trailMult > 0 && atr[i] != null) {
            hh = Math.max(hh, H[i]);
            stop = Math.max(stop, hh - atr[i] * p.trailMult);
          }
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
      // continuation: shortly after a winning exit, buy again when the trend is still up and price bounces off the fast EMA
      if (p.useCont && cool && green && (i - lastWinExitIdx) <= (p.contBars || 30) && emaF[i] > emaS[i] && emaS[i] > emaS[i - 3]
          && C[i] > emaF[i] && closePos >= 0.6 && (L[i] <= emaF[i] * 1.005 || L[i - 1] <= emaF[i - 1] * 1.005)) tags.push('CONT');
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

      const trendOk = (!useTrend || (C[i] > emaT[i] && emaT[i] > emaT[i - 3])) && htfOkAt(i);
      if (tags.length && trendOk) {
        const swingLow = Math.min(L[i], L[i - 1], L[i - 2]);
        const stopPx = swingLow - atr[i] * p.atrMultSL;
        const risk = C[i] - stopPx;
        // cost filter: the first profit target must be clearly bigger than what the trade costs
        const edgeOk = !(p.minEdge > 0) || (risk * p.rrTp1 / C[i] * 100) >= p.minEdge * p.costPct;
        if (risk > 0 && edgeOk) {
          inPos = true; entry = C[i]; stop = stopPx;
          tp1 = entry + risk * p.rrTp1; tp2 = entry + risk * p.rrTp2;
          tp1Hit = false; tp2Hit = false; gross = 0; size = 1; hh = H[i]; src = tags.join('+'); entryIdx = i;
          events.push({ time: bars[i].time, type: 'BUY', price: C[i], src });
        }
      }
    }
  }
  return { events, inPos, entry, stop, tp1, tp2, tp1Hit, tp2Hit, src, last: bars[n - 1] };
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
let addedTokens = [];     // coins you added from the terminal / Telegram
let removedTokens = [];   // coins from TOKEN_ADDRESS you switched off from the terminal / Telegram
function manualTokens(){
  const set = new Set(TOKEN_LIST.filter(t => !removedTokens.includes(t)));
  addedTokens.forEach(t => set.add(t));
  return [...set];
}
function activeTokens(){
  const set = new Set([...manualTokens(), ...autoTokens]);
  coins.forEach((c, t) => { if (live.isOpen(t)) set.add(t); });   // keep managing a position even if the coin was dropped
  return [...set];
}
function exitOnly(token){ return !manualTokens().includes(token) && !autoTokens.includes(token); }

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
  return { symbol: (p && p.baseToken && p.baseToken.symbol) || token.slice(0, 6), liquidityUsd: p && p.liquidity ? Number(p.liquidity.usd) : NaN, partialFrac: paramsFor(c).partialFrac,
    stakeMult: typeof stakeMult === 'function' ? stakeMult() : 1 };
}

async function tickOne(token) {
  const [unit, agg] = TIMEFRAME.split(':');
  const c = coin(token);
  if (!c.ctx) {
    c.ctx = await fetchBestPair(token);
    if (!c.announced){ c.announced = true; await notify('Watch · ' + infoOf(c, token).symbol + ' · ' + TIMEFRAME); }
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
  c.engine = { inPos: res.inPos, stop: res.stop, entry: res.entry, tp1: res.tp1, tp2: res.tp2, tp1Hit: res.tp1Hit, tp2Hit: res.tp2Hit, time: Date.now() };
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
    if ((c.livePauseUntil || 0) > Date.now() && todo.some(e => e.type === 'BUY')){
      console.log(tag, 'BUY overgeslagen: pauze na verliezen in echte trades tot', new Date(c.livePauseUntil).toISOString());
      todo = todo.filter(e => e.type !== 'BUY');
    }
    if (c.paused && todo.some(e => e.type === 'BUY')){
      await notify('⏸️ ' + tag + ': BUY niet uitgevoerd — coin is gepauzeerd door de auto-tune (de strategie werkt hier nu niet)');
      todo = todo.filter(e => e.type !== 'BUY');
    }
    if (todo.some(e => e.type === 'BUY') && !(await ksAllowBuy(token, tag))) todo = todo.filter(e => e.type !== 'BUY');
    const buyEv = todo.find(e => e.type === 'BUY');
    if (buyEv && !live.isOpen(token)){
      const meta = { kind: 'strategie', source: buyEv.src || 'EMA', liq: infoOf(c, token).liquidityUsd, buyTime: Date.now() };
      const ok = await cloud.check({ kind: 'strategie', mint: token, source: meta.source, liq: meta.liq }, notify);
      if (!ok.ok){ await notify('🧠 ' + tag + ': BUY overgeslagen door het cloud-geheugen — ' + ok.reason + '. (Zo leert de bot van fouten; /geheugen voor alle lessen)'); todo = todo.filter(e => e.type !== 'BUY'); }
      else buyMeta.set(token, meta);
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
const TP_WATCH = flag('TP_WATCH', true);
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
    if (!(price > 0)) continue;
    // profit targets: take them the moment the live price gets there, don't wait for the candle to close
    if (TP_WATCH && price > c.engine.stop){
      const e = c.engine, p = paramsFor(c);
      if (e.tp2 > 0 && price >= e.tp2 && !e.tp2Hit && Date.now() - (c.lastTpFire || 0) > 30000){
        c.lastTpFire = Date.now();
        e.tp2Hit = true; e.tp1Hit = true;
        const ev = p.letRun ? { type: 'TP2', price, frac: p.runFrac } : { type: 'TP2', price };
        await notify('🎯 Winst-wachter ' + infoOf(c, token).symbol + ': prijs $' + fmtPrice(price) + ' raakte TP2 $' + fmtPrice(e.tp2) + ' — ' + (p.letRun ? Math.round(p.runFrac * 100) + '% verkopen, rest loopt door' : 'alles verkopen'));
        const pre = e.tp1 > 0 && !live.tp1Taken(token) ? [{ type: 'TP1', price }] : [];
        await live.handleLiveEvents(pre.concat([ev]), token, infoOf(c, token));
        if (p.letRun) e.stop = Math.max(e.stop, e.tp1);
        continue;
      }
      if (e.tp1 > 0 && price >= e.tp1 && !e.tp1Hit && Date.now() - (c.lastTpFire || 0) > 30000){
        c.lastTpFire = Date.now();
        e.tp1Hit = true;
        await notify('🎯 Winst-wachter ' + infoOf(c, token).symbol + ': prijs $' + fmtPrice(price) + ' raakte TP1 $' + fmtPrice(e.tp1) + ' — deel verkopen');
        await live.handleLiveEvents([{ type: 'TP1', price }], token, infoOf(c, token));
        if (p.beAfterTp1) e.stop = Math.max(e.stop, e.entry);   // same rule as the strategy: stop to break-even after TP1
        continue;
      }
    }
    if (price > c.engine.stop) continue;
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
function tradesFromEvents(events, p, lastClose){
  const out = []; let entry = null, entryTime = 0, size = 0, gross = 0;
  for (const e of events){
    if (e.type === 'BUY'){ entry = e.price; entryTime = e.time; size = 1; gross = 0; continue; }
    if (entry == null) continue;
    if (e.type === 'TP1'){ gross += p.partialFrac * (e.price / entry - 1); size -= p.partialFrac; continue; }
    if (e.type === 'TP2' && e.frac != null){ gross += size * e.frac * (e.price / entry - 1); size -= size * e.frac; continue; }
    gross += size * (e.price / entry - 1);
    out.push({ entryTime, exitTime: e.time, ret: gross - p.costPct / 100 });
    entry = null;
  }
  // a position still open at the end counts at the last price, exactly like the website
  if (entry != null && lastClose > 0) out.push({ entryTime, exitTime: null, ret: gross + size * (lastClose / entry - 1) - p.costPct / 100, open: true });
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
    for (const a of [0.8, 1.0, 1.5, 2.0]) for (const t1 of [0.8, 1.0, 1.5]) for (const t2 of [2, 3, 5]) for (const flags of sets) for (const tr of [true, false]) for (const hf of [false, true])
      out.push(Object.assign({}, base, flags, { emaFastLen: f, emaSlowLen: sl, atrMultSL: a, rrTp1: t1, rrTp2: t2, useTrend: tr, useHtf: hf }));
  return out;
}
const TUNE_KEYS = ['emaFastLen', 'emaSlowLen', 'atrMultSL', 'rrTp1', 'rrTp2', 'useEma', 'useRev', 'useBrk', 'useTrend', 'useHtf', 'letRun', 'useCont'];
const ENV_NAME = { emaFastLen: 'EMA_FAST', emaSlowLen: 'EMA_SLOW', atrMultSL: 'ATR_MULT_SL', rrTp1: 'RR_TP1', rrTp2: 'RR_TP2', useEma: 'USE_EMA', useRev: 'USE_REV', useBrk: 'USE_BRK', useTrend: 'USE_TREND', useHtf: 'USE_HTF', letRun: 'LET_RUN', useCont: 'USE_CONT' };
function describe(p){ return 'EMA ' + p.emaFastLen + '/' + p.emaSlowLen + ' · SL ' + p.atrMultSL + '×ATR · TP ' + p.rrTp1 + '/' + p.rrTp2 + ' · ' + [p.useEma && 'EMA', p.useRev && 'Dip', p.useBrk && 'Breakout'].filter(Boolean).join('+') + (p.useTrend ? ' · trend' : '') + (p.useHtf ? ' · grote tf' : '') + (p.letRun ? ' · winst laten lopen' : '') + (p.useCont ? ' · herinstap' : ''); }
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
    const tr = tradesFromEvents(runEngine(bars, p).events, p, bars[bars.length - 1].close).filter(t => t.entryTime >= start);
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
  // stage 2: on the 30 best, also try "let profits run" and "re-enter in the trend"
  const extra = [];
  for (const r of results.slice(0, 30)) for (const v of [{ letRun: true }, { useCont: true }, { letRun: true, useCont: true }]){
    const r2 = evalP(Object.assign({}, r.p, v));
    if (r2.train.n >= 8) extra.push(Object.assign(r2, { rank: Math.log(r2.train.e) / (1 + 3 * Math.abs(r2.train.dd)) }));
  }
  results.push(...extra);
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
    for (const token of manualTokens()){   // coins picked by AUTO_COINS are re-checked by pickCoins
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
// learn from REAL trades: a coin that keeps losing for real gets a break, whatever the backtest says
const LIVE_LEARN_N = Math.max(0, Math.floor(num('LIVE_LEARN_N', 4)));
const LIVE_PAUSE_H = Math.max(1, num('LIVE_PAUSE_H', 24));
function liveLearn(mint){
  if (!LIVE_LEARN_N) return null;
  const c0 = coin(mint);
  const mine = journal.slice(c0.livePauseAfter || 0).filter(t => t.mint === mint).slice(-LIVE_LEARN_N);   // after a pause only new trades count
  if (mine.length < LIVE_LEARN_N) return null;
  const net = mine.reduce((a, t) => a + t.pnlSol, 0), losses = mine.filter(t => t.pnlSol <= 0).length;
  if (net < 0 && losses >= Math.ceil(LIVE_LEARN_N * 0.75)){
    const c = coin(mint);
    c.livePauseUntil = Date.now() + LIVE_PAUSE_H * 3600000;
    c.livePauseAfter = journal.length;   // only trades after this pause count for the next decision
    return { net, losses, n: mine.length };
  }
  return null;
}
// bet smaller after a losing streak (never bigger than your normal amount)
const STAKE_ADAPT = flag('STAKE_ADAPT', true);
function stakeMult(){
  if (!STAKE_ADAPT) return 1;
  let streak = 0;
  for (let k = journal.length - 1; k >= 0 && journal[k].pnlSol <= 0; k--) streak++;
  return streak >= 2 ? 0.5 : 1;
}
live.setJournal(t => {
  journal.push(t);
  const meta = buyMeta.get(t.mint) || {};
  buyMeta.delete(t.mint);
  cloud.record(Object.assign({ kind: 'strategie' }, t, meta), notify).catch(() => {});
  const ll = liveLearn(t.mint);
  if (ll) notify('📉 ' + (t.symbol || t.mint.slice(0, 6)) + ': de laatste ' + ll.n + ' echte trades kostten samen ' + ll.net.toFixed(4) + ' SOL (' + ll.losses + ' verliezen). Pauze voor nieuwe buys: ' + LIVE_PAUSE_H + ' uur. Verkopen gaan door.');
  if (STAKE_ADAPT && stakeMult() < 1 && t.pnlSol <= 0) console.log('verliesreeks: volgende inzet tijdelijk de helft');
  if (journal.length > 1000) journal = journal.slice(-1000);
  const run = totalPnl() - lossBaseline;
  if (MAX_TOTAL_LOSS > 0 && run <= -MAX_TOTAL_LOSS && !manualStop){
    manualStop = true;
    notify('🛑 Totale verlieslimiet bereikt: ' + run.toFixed(4) + ' SOL (max ' + MAX_TOTAL_LOSS + '). De bot koopt niets meer; open posities worden nog verkocht. Bekijk /rapport — /hervat om toch door te gaan.');
  }
  saveState();
});
// ---------- wallets volgen (copy-trading): see copyTrade.js ----------
const copy = createCopy({
  notify: m => notify(m),
  live: {
    enabled: () => live.liveEnabled(),
    isOpen: m => live.isOpen(m),
    canBuy: async (m, wallet, sym) => {
      if (manualStop || activeTokens().includes(m)) return false;
      const ok = await cloud.check({ kind: 'kopie', mint: m, source: wallet }, notify);
      if (!ok.ok){ await notify('🧠 ' + (sym || m.slice(0, 6)) + ': niet meegekocht door het cloud-geheugen — ' + ok.reason); return false; }
      return true;
    },
    buy: (m, i) => { buyMeta.set(m, { kind: 'kopie', source: i.wallet, liq: i.liquidityUsd, buyTime: Date.now() }); return live.handleLiveEvents([{ type: 'BUY' }], m, { symbol: i.symbol, liquidityUsd: i.liquidityUsd, stakeMult: Math.min(1, (i.copySol || 0) / (Number(process.env.TRADE_AMOUNT_SOL) || 0.01)) }); },
    sell: (m, i) => live.handleLiveEvents([{ type: 'EXIT' }], m, { symbol: i.symbol, liquidityUsd: i.liquidityUsd }),
  },
  onPaperClose: t => { cloud.record(t, notify).catch(() => {}); },
});
function saveState(){
  if (!STATE_FILE) return;
  try {
    const o = { v: 1, savedAt: Date.now(), manualStop, autoTokens, addedTokens, removedTokens, lossBaseline, journal: journal.slice(-500), live: live.exportState(), lastReportDay, coins: {},
      kansen: { w: ks.w, b: ks.b, pending: ks.pending.slice(-800), done: ks.done.slice(-2000) }, copy: copy.exportState(), buyMeta: Object.fromEntries(buyMeta) };
    coins.forEach((c, t) => { o.coins[t] = { params: c.params, pendingParams: c.pendingParams, paused: c.paused, tunedAt: c.tunedAt, livePauseUntil: c.livePauseUntil || 0, livePauseAfter: c.livePauseAfter || 0 }; });
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
    addedTokens = Array.isArray(o.addedTokens) ? o.addedTokens : []; removedTokens = Array.isArray(o.removedTokens) ? o.removedTokens : [];
    lossBaseline = Number(o.lossBaseline) || 0; journal = Array.isArray(o.journal) ? o.journal : [];
    lastReportDay = o.lastReportDay || '';
    Object.entries(o.coins || {}).forEach(([t, v]) => { const c = coin(t); c.params = v.params || null; c.pendingParams = v.pendingParams || null; c.paused = !!v.paused; c.tunedAt = v.tunedAt || 0; c.livePauseUntil = Number(v.livePauseUntil) || 0; c.livePauseAfter = Number(v.livePauseAfter) || 0; });
    live.importState(o.live);
    copy.importState(o.copy);
    Object.entries(o.buyMeta || {}).forEach(([k, v]) => buyMeta.set(k, v));
    if (o.kansen && Array.isArray(o.kansen.w) && o.kansen.w.length === KS_PRIOR.length)
      ks = { w: o.kansen.w, b: Number(o.kansen.b) || 0, pending: o.kansen.pending || [], done: o.kansen.done || [] };
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

// ---------- Kansen: score coins, check the outcome later, learn — 24/7 ----------
const KANSEN = flag('KANSEN', true);
const KANSEN_EVERY = Math.max(2, num('KANSEN_EVERY_MIN', 10)) * 60000;
const KANSEN_H = Math.max(10, num('KANSEN_H_MIN', 60)) * 60000;
const KANSEN_MIN_LIQ = num('KANSEN_MIN_LIQ', 50000);
const KANSEN_FILTER = String(process.env.KANSEN_FILTER || 'auto').toLowerCase();
const KANSEN_MIN = num('KANSEN_MIN', 0.45);
const KS_NAMES = ['stijgt dit uur', 'stijgt nu (5m)', 'volume trekt aan', 'meer kopers (1u)', 'meer kopers (5m)', 'veel liquiditeit', 'oudere coin', 'al ver gestegen (24u)'];
const KS_PRIOR = [0.6, 0.3, 0.5, 0.6, 0.3, 0.2, 0.1, -0.5];
let ks = { w: KS_PRIOR.slice(), b: -0.3, pending: [], done: [] };
let ksBusy = false, ksLastTop = [];
const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
// same features as the Kansen tab on the website
function ksFeatures(pr){
  const pc = pr.priceChange || {}, vol = pr.volume || {}, tx = pr.txns || {};
  const ratio = o => { const b = Number(o && o.buys) || 0, s2 = Number(o && o.sells) || 0; return b + s2 > 0 ? b / (b + s2) - 0.5 : 0; };
  const v1 = Number(vol.h1) || 0, v6 = Number(vol.h6) || 0;
  const accel = v6 > 0 ? Math.log((v1 + 1) / (v6 / 6 + 1)) : 0;
  const liq = (pr.liquidity && Number(pr.liquidity.usd)) || 0;
  const ageH = pr.pairCreatedAt ? (Date.now() - pr.pairCreatedAt) / 3600000 : 24 * 30;
  return [clampN((Number(pc.h1) || 0) / 30, -2, 2), clampN((Number(pc.m5) || 0) / 10, -2, 2), clampN(accel, -2, 2),
    clampN(ratio(tx.h1) * 4, -2, 2), clampN(ratio(tx.m5) * 4, -2, 2),
    clampN((Math.log10(liq + 1) - 5) / 1.5, -2, 2), clampN(Math.log10(ageH + 1) - 1.5, -2, 2), clampN((Number(pc.h24) || 0) / 100, -2, 3)];
}
const ksScore = x => 1 / (1 + Math.exp(-(ks.b + x.reduce((a, v, i) => a + v * ks.w[i], 0))));
async function dexPairs(tokens){
  const out = {};
  for (let k = 0; k < tokens.length; k += 30){
    const data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + tokens.slice(k, k + 30).join(','), 9000, 1);
    ((data && data.pairs) || []).forEach(pr => {
      const a = pr.baseToken && pr.baseToken.address; if (!a || pr.chainId !== 'solana') return;
      const l = (pr.liquidity && pr.liquidity.usd) || 0;
      if (!out[a] || l > ((out[a].liquidity && out[a].liquidity.usd) || 0)) out[a] = pr;
    });
  }
  return out;
}
async function ksResolve(){
  const now = Date.now();
  const due = ks.pending.filter(q => now - q.t >= q.h);
  if (!due.length) return 0;
  const cost = getParams().costPct / 100;
  const priceOf = {};
  for (let k = 0; k < due.length; k += 30){
    try {
      const data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + due.slice(k, k + 30).map(q => q.token).join(','), 9000, 1);
      ((data && data.pairs) || []).forEach(pr => { if (pr.pairAddress && pr.priceUsd) priceOf[pr.pairAddress] = Number(pr.priceUsd); });
    } catch (_){ return 0; }
  }
  let learned = 0;
  due.forEach(q => {
    const p2 = priceOf[q.pool];
    if (p2 > 0){ q.ret = p2 / q.price - 1; q.y = q.ret > cost ? 1 : 0; }
    else if (now - q.t > q.h * 3){ q.ret = -1; q.y = 0; }   // pool gone for a long time: most likely rugged
    if (q.y == null) return;
    const pz = ksScore(q.x), lr = 0.05;
    for (let i = 0; i < ks.w.length; i++) ks.w[i] -= lr * ((pz - q.y) * q.x[i] + 0.001 * ks.w[i]);
    ks.b -= lr * (pz - q.y);
    ks.done.push({ t: q.t, s: q.s, ret: q.ret, y: q.y });
    learned++;
  });
  ks.pending = ks.pending.filter(q => q.y == null);
  if (ks.done.length > 2000) ks.done = ks.done.slice(-2000);
  return learned;
}
function ksStats(){
  const d = ks.done;
  const scans = {}; d.forEach(r => { (scans[r.t] = scans[r.t] || []).push(r); });
  let topR = 0, topN = 0, allR = 0, allN = 0, topHit = 0;
  Object.values(scans).forEach(list => {
    list.sort((a, b) => b.s - a.s);
    list.slice(0, 5).forEach(r => { topR += r.ret; topN++; if (r.y) topHit++; });
    list.forEach(r => { allR += r.ret; allN++; });
  });
  const base = d.length ? d.filter(r => r.y).length / d.length : 0;
  const avgTop = topN ? topR / topN : 0, avgAll = allN ? allR / allN : 0, hit = topN ? topHit / topN : 0;
  const proven = d.length >= 200 && avgTop > avgAll + 0.005 && hit > base + 0.03;
  return { n: d.length, avgTop, avgAll, hit, base, proven };
}
function ksFilterActive(){
  if (!KANSEN || KANSEN_FILTER === '0') return false;
  if (KANSEN_FILTER === '1' || KANSEN_FILTER === 'true') return true;
  return ksStats().proven;
}
function ksText(){
  const st = ksStats();
  const lines = ['🔮 Kansen (' + st.n + ' uitkomsten): top-5 gem. ' + pctStr(st.avgTop) + ' · alle coins ' + pctStr(st.avgAll) + ' · top-5 raak ' + Math.round(st.hit * 100) + '% vs basis ' + Math.round(st.base * 100) + '%'];
  lines.push(st.n < 200 ? '⏳ nog aan het leren — beïnvloedt de trades nog niet' : st.proven ? '✅ bewezen beter: buys onder ' + Math.round(KANSEN_MIN * 100) + '% kans worden overgeslagen' : '⚠️ (nog) niet beter dan willekeurig — beïnvloedt de trades niet');
  if (KANSEN_FILTER === '1' || KANSEN_FILTER === 'true') lines.push('(KANSEN_FILTER=1: filter staat geforceerd aan)');
  if (ksLastTop.length) lines.push('Nu hoogst: ' + ksLastTop.slice(0, 5).map(r => r.sym + ' ' + Math.round(r.s * 100) + '%').join(' · '));
  return lines.join('\n');
}
async function ksScan(){
  if (!KANSEN || ksBusy) return;
  ksBusy = true;
  try {
    const learned = await ksResolve();
    const tokens = new Set(activeTokens());
    try {
      const json = await fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1', 12000, 1);
      ((json && json.data) || []).forEach(d => {
        const id = d.relationships && d.relationships.base_token && d.relationships.base_token.data && d.relationships.base_token.data.id;
        if (id) tokens.add(id.replace(/^solana_/, ''));
      });
    } catch (_){}
    tokens.delete(live.SOL_MINT || 'So11111111111111111111111111111111111111112');
    const pairs = await dexPairs([...tokens].slice(0, 60));
    const t = Date.now(), waiting = new Set(ks.pending.map(q => q.token)), rows = [];
    Object.values(pairs).forEach(pr => {
      const liq = (pr.liquidity && pr.liquidity.usd) || 0, price = Number(pr.priceUsd);
      if (liq < KANSEN_MIN_LIQ || !(price > 0)) return;
      const x = ksFeatures(pr), sc = ksScore(x);
      rows.push({ token: pr.baseToken.address, sym: pr.baseToken.symbol, s: sc });
      if (!waiting.has(pr.baseToken.address)) ks.pending.push({ token: pr.baseToken.address, pool: pr.pairAddress, t, h: KANSEN_H, price, x, s: sc });
    });
    if (ks.pending.length > 800) ks.pending = ks.pending.slice(-800);
    rows.sort((a, b) => b.s - a.s); ksLastTop = rows;
    if (learned) console.log('Kansen:', learned, 'uitkomsten geleerd ·', ksStats().n, 'totaal');
    saveState();
  } catch (e){ console.error('Kansen-fout', e.message); }
  finally { ksBusy = false; }
}
// before a buy: when the score has proven itself, skip coins with a low chance right now
async function ksAllowBuy(token, tag){
  if (!ksFilterActive()) return true;
  try {
    const pr = (await dexPairs([token]))[token];
    if (!pr) return true;
    const sc = ksScore(ksFeatures(pr));
    if (sc >= KANSEN_MIN) return true;
    await notify('🔮 ' + tag + ': BUY overgeslagen — kans-score ' + Math.round(sc * 100) + '% is lager dan ' + Math.round(KANSEN_MIN * 100) + '%');
    return false;
  } catch (_){ return true; }
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
  if (live.liveEnabled()) lines.push('Vandaag: ' + (d.buys || 0) + ' buys · resultaat ≈ ' + ((d.pnlSol || 0) >= 0 ? '+' : '') + (d.pnlSol || 0).toFixed(4) + ' SOL' + (stakeMult() < 1 ? ' · inzet tijdelijk ×' + stakeMult() + ' (verliesreeks)' : ''));
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
    if ((c.livePauseUntil || 0) > Date.now()) parts.push('📉 pauze na echte verliezen tot ' + new Date(c.livePauseUntil).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric' }));
    if (c.params) parts.push('eigen instellingen: ' + describe(paramsFor(c)));
    if (c.pendingParams) parts.push('nieuwe instellingen na sluiten positie');
    lines.push('• ' + tag + ': ' + parts.join(' · '));
  }
  lines.push('Auto-tune: ' + (TUNE_ON ? (TUNE_APPLY ? 'aan' : 'alleen voorstellen') : 'uit') + ' · stop-wachter: ' + (STOPWATCH_MS ? 'aan' : 'uit')
    + (KANSEN ? ' · kansen: ' + ksStats().n + ' uitkomsten' + (ksFilterActive() ? ' (filter AAN)' : ' (leert, filter nog uit)') : ''));
  lines.push(cloud.cfg.on ? '☁️ Cloud-geheugen AAN (' + cloud.cfg.bot + ')' + (cloud.stats.blocked ? ' · ' + cloud.stats.blocked + ' buy(s) tegengehouden' : '') + (cloud.stats.errors ? ' · ⚠️ ' + cloud.stats.errors + ' fout(en)' : '') : '☁️ Cloud-geheugen uit');
  if (copy.state.wallets.length) lines.push('🐋 Wallets volgen: ' + copy.state.wallets.length + ' · stand ' + copy.cfg.mode + ' (meer: /wallets)');
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
  let cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  let rawArg = String(text || '').trim().split(/\s+/).slice(1).join(' ');
  // links from the terminal open Telegram with "/start add_<coin>", "/start del_<coin>", "/start stop", "/start hervat"
  if (cmd === '/start' && rawArg){
    const m = rawArg.match(/^(add|del)_([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (m){ cmd = m[1] === 'add' ? '/coin' : '/weg'; rawArg = m[2]; }
    else if (/^(volg|ontvolg)_([1-9A-HJ-NP-Za-km-z]{32,44})$/.test(rawArg)){ const v = rawArg.split('_'); cmd = '/' + v[0]; rawArg = v[1]; }
    else if (/^(stop|hervat|status|rapport|kansen|coinlijst|wallets|geheugen)$/i.test(rawArg)){ cmd = '/' + rawArg.toLowerCase(); rawArg = ''; }
  }
  const arg = rawArg.toUpperCase();
  if (cmd === '/coin' || cmd === '/weg' || cmd === '/coinlijst') return coinCommand(cmd, rawArg.trim());
  if (cmd === '/volg' || cmd === '/ontvolg' || cmd === '/wallets'){ const answer = await copy.command(cmd, rawArg); if (cmd !== '/wallets') saveState(); return tgSend(answer); }
  if (cmd === '/geheugen') return tgSend(await cloud.text());
  if (cmd === '/status') return tgSend(statusText());
  if (cmd === '/rapport') return tgSend(reportText());
  if (cmd === '/kansen') return tgSend(KANSEN ? ksText() : 'Kansen staat uit (KANSEN=0).');
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
    return tgSend('Commando\'s:\n/status — hoe staat de bot ervoor\n/rapport — wat leverde elke coin op\n/kansen — wat de kans-score geleerd heeft\n/coins — opnieuw coins kiezen (AUTO_COINS)\n/stop — geen nieuwe buys (noodstop)\n/hervat — weer kopen\n/verkoopalles — alle bot-posities nu verkopen\n/tune — nu betere instellingen zoeken\n/coin <adres> — coin toevoegen · /weg <adres> — coin weghalen · /coinlijst — welke coins\n/volg <wallet> <naam> — slimme wallet volgen · /ontvolg <wallet> · /wallets — wie volg je en hoe gaat het\n/geheugen — wat de bots samen geleerd hebben (Supabase)\n/help — deze lijst');
}
const MAX_COINS = Math.max(1, Math.floor(num('MAX_COINS', 6)));
async function coinCommand(cmd, addr){
  if (cmd === '/coinlijst'){
    const list = activeTokens();
    if (!list.length) return tgSend('De bot volgt nu geen coins.');
    return tgSend('Coins van deze bot:\n' + list.map(t => '• ' + infoOf(coin(t), t).symbol + ' — ' + t + (addedTokens.includes(t) ? ' (toegevoegd)' : TOKEN_LIST.includes(t) ? ' (TOKEN_ADDRESS)' : autoTokens.includes(t) ? ' (zelf gekozen)' : ' (alleen nog verkopen)')).join('\n'));
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return tgSend('Dat is geen geldig Solana-adres. Gebruik: ' + cmd + ' <coin-adres>');
  if (cmd === '/weg'){
    const was = manualTokens().includes(addr);
    addedTokens = addedTokens.filter(t => t !== addr);
    if (TOKEN_LIST.includes(addr) && !removedTokens.includes(addr)) removedTokens.push(addr);
    saveState();
    const sym = infoOf(coin(addr), addr).symbol;
    return tgSend(was ? '➖ ' + sym + ' weggehaald: de bot koopt deze coin niet meer' + (live.isOpen(addr) ? ' (de open positie wordt nog netjes verkocht).' : '.') : sym + ' stond niet in de lijst.');
  }
  // /coin <address>: check that the coin exists and has a real pool before adding it
  if (manualTokens().includes(addr)) return tgSend('Deze coin volgt de bot al.');
  if (manualTokens().length >= MAX_COINS) return tgSend('Je hebt al ' + manualTokens().length + ' coins (max ' + MAX_COINS + '). Haal er eerst een weg met /weg <adres>, of zet MAX_COINS hoger in Railway.');
  let ctx;
  try { ctx = await fetchBestPair(addr); }
  catch (e){ return tgSend('Kon deze coin niet vinden op DexScreener: ' + e.message.slice(0, 80)); }
  const liq = ctx.pair.liquidity ? Number(ctx.pair.liquidity.usd) || 0 : 0;
  const minLiq = num('MIN_LIQUIDITY_USD', 20000);
  if (liq < minLiq) return tgSend('Niet toegevoegd: ' + ((ctx.pair.baseToken && ctx.pair.baseToken.symbol) || addr.slice(0, 6)) + ' heeft maar $' + Math.round(liq).toLocaleString('nl-NL') + ' liquiditeit (minimaal $' + minLiq.toLocaleString('nl-NL') + ').');
  removedTokens = removedTokens.filter(t => t !== addr);
  if (!TOKEN_LIST.includes(addr)) addedTokens.push(addr);
  const c = coin(addr); c.ctx = ctx;
  saveState();
  const sym = (ctx.pair.baseToken && ctx.pair.baseToken.symbol) || addr.slice(0, 6);
  await tgSend('➕ ' + sym + ' toegevoegd (liquiditeit $' + Math.round(liq).toLocaleString('nl-NL') + '). De bot volgt hem vanaf de volgende ronde' + (TUNE_ON ? ' en test hem binnen een paar minuten met de auto-tune.' : '.') + (live.liveEnabled() ? '' : '\nLet op: live handelen staat UIT in Railway, dus alleen signalen.'));
  if (TUNE_ON && TUNE_APPLY) setTimeout(() => { tuneOne(addr).catch(() => {}); }, 2 * 60 * 1000);
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
  const wiped = await cloud.cleanup(notify);
  if (wiped) console.log('cloud-geheugen:', wiped, 'oude verliezende trades gewist (lessen blijven)');
  await tgSend('📊 Dagrapport ' + n.day + '\n' + statusText() + '\n\n' + reportText() + (KANSEN ? '\n\n' + ksText() : '') + (copy.state.wallets.length ? '\n\n' + copy.walletsText() : ''));
}

async function tick() {
  const list = activeTokens();
  if (!list.length){
    if (copy.state.wallets.length){ console.log('geen coins — de bot volgt alleen wallets'); return; }
    if (!AUTO_COINS) throw new Error('Geen coins: zet TOKEN_ADDRESS in Railway, voeg een coin toe vanuit de terminal (➕ Naar bot) of zet AUTO_COINS=3');
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
      if (!/geckoterminal/i.test(err.message)) c.ctx = null;   // GeckoTerminal busy: keep the pool, just try again next round
      c.errCount = (c.errCount || 0) + 1;
      if (c.errCount === 5) await notify('⚠️ ' + token.slice(0, 6) + ': al 5 keer achter elkaar een fout (' + err.message.slice(0, 80) + '). De bot probeert het gewoon verder; blijft dit, kijk dan in de Railway-logs.');
    }
    await sleep(1200);
  }
}

const SMART_POLL = flag('SMART_POLL', true);
function tfSeconds(){ const [u, a] = TIMEFRAME.split(':'); return ({ second: 1, minute: 60, hour: 3600, day: 86400 }[u] || 60) * (Number(a) || 1); }
// ms until the next useful moment: 25 s after a candle closes, and again 90 s after (data can arrive late); at most every POLL_MS-ish when candles are short
function nextTickDelay(nowMs){
  const tf = tfSeconds() * 1000;
  if (!SMART_POLL || tf <= 60000) return POLL_MS;
  const sinceClose = nowMs % tf;
  const marks = [25000, 90000, tf + 25000];
  const next = marks.find(m => m > sinceClose + 500);
  return Math.max(5000, next - sinceClose);
}
async function loop() {
  try { await tick(); } catch (err) { console.error('tick fout', err.message); }
  setTimeout(loop, nextTickDelay(Date.now()));
}

async function start(){
  const restored = loadState();
  if (!AUTO_COINS && autoTokens.length){
    console.log('AUTO_COINS staat uit: eerder zelf gekozen coins vergeten:', autoTokens.map(t => t.slice(0, 6)).join(','));
    autoTokens = []; saveState();
  }
  console.log(STATE_FILE ? (restored ? 'Geheugen geladen uit ' + STATE_FILE : 'Geheugen: nieuw bestand ' + STATE_FILE) : 'Geheugen: UIT (geen Railway Volume) — /stop, gekozen coins en instellingen worden vergeten bij een herstart');
  console.log('Kijkmoment:', SMART_POLL && tfSeconds() > 60 ? 'vlak na elke ' + TIMEFRAME + '-candle (+ tweede blik na 90 s)' : 'elke ' + POLL_MS / 1000 + ' s', '· winst-wachter:', TP_WATCH ? 'aan' : 'uit');
  console.log('Signaal worker start. Tokens=', TOKEN_LIST.length ? TOKEN_LIST.length : '(LEEG)', TOKEN_LIST.map(t => t.slice(0, 6)).join(','), 'tf=', TIMEFRAME, 'poll=', POLL_MS + 'ms', 'stop-wachter=', STOPWATCH_MS ? STOPWATCH_MS + 'ms' : 'uit');
  try { await notify(await live.startupReport()); } catch (e){ console.error('LIVE start-fout:', e.message); }
  if (cloud.cfg.on){
    try { await cloud.refresh(true); console.log('Cloud-geheugen AAN:', cloud.lessons.size, 'lessen geladen · bot-naam', cloud.cfg.bot, '· blokkeren:', cloud.cfg.learn ? 'aan' : 'uit'); }
    catch (e){ console.error('cloud-geheugen:', e.message); notify('⚠️ Cloud-geheugen (Supabase) werkt nog niet: ' + e.message.slice(0, 200)); }
  } else console.log('Cloud-geheugen: uit (zet SUPABASE_URL en SUPABASE_KEY om het aan te zetten)');
  // keeps the lessons fresh, and keeps a free Supabase project awake (it pauses after a week without activity)
  if (cloud.cfg.on) setInterval(() => { cloud.refresh(true).catch(e => console.error('cloud-geheugen:', e.message)); }, 6 * 3600 * 1000);
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
  console.log('Wallets volgen:', copy.state.wallets.length ? copy.state.wallets.length + ' wallet(s) · stand ' + copy.cfg.mode + ' · elke ' + copy.cfg.pollMs / 1000 + ' s' : 'nog geen (stuur /volg <adres> in Telegram of zet COPY_WALLETS)');
  (async function copyLoop(){
    for (;;){
      try { await copy.tick(); } catch (e){ console.error('kopieer fout', e.message); }
      await sleep(copy.cfg.pollMs);
    }
  })();
  setInterval(saveState, 60000);
  if (KANSEN){
    console.log('Kansen AAN: elke', KANSEN_EVERY / 60000, 'min scoren · controle na', KANSEN_H / 60000, 'min · filter:', KANSEN_FILTER, '(' + ksStats().n + ' uitkomsten in geheugen)');
    setTimeout(() => { ksScan(); }, 90 * 1000);
    setInterval(() => { ksScan(); }, KANSEN_EVERY);
  }
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
module.exports = { runEngine, getParams, tickOne, tick, stopWatchTick, nextTickDelay, syncOne, coins, start, tuneOne, tradesFromEvents, paramsFor, handleCommand, pollTelegram, statusText, dailyReport,
  pickCoins, activeTokens, manualTokens, saveState, loadState, reportText, stakeMultNow: () => stakeMult(),
  copy, cloud, buyMeta, ksScan, ksResolve, ksStats, ksFilterActive, ksText, get ks(){ return ks; }, set ks(v){ ks = v; }, get manualStop(){ return manualStop; }, get autoTokens(){ return autoTokens; }, get journal(){ return journal; } };
