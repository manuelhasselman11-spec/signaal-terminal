/**
 * 24/7 signal worker — zelfde logica als de web-app.
 * Standaard: alleen logs + optioneel Telegram.
 * Live swaps: alleen als ENABLE_LIVE_TRADES=1 en PRIVATE_KEY in Railway Variables.
 */
const { liveEnabled, handleLiveEvents } = require('./liveTrade');
const TOKEN_LIST = (process.env.TOKEN_ADDRESS || '')
  .split(/[,;\s]+/)
  .map(s => s.trim())
  .filter(Boolean);
const TIMEFRAME = process.env.TIMEFRAME || 'minute:5';
const POLL_MS = Math.max(10000, Number(process.env.POLL_MS) || 30000);
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

async function fetchJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(res.status + ' ' + url);
    return res.json();
  } finally {
    clearTimeout(t);
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
  const bars = list.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
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
  const url = 'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
  });
  if (!res.ok) console.error('Telegram fout', res.status, await res.text());
}

const seen = new Set();
const firstByToken = new Map();
const ctxByToken = new Map();

async function tickOne(token) {
  const [unit, agg] = TIMEFRAME.split(':');
  let ctx = ctxByToken.get(token);
  if (!ctx) {
    ctx = await fetchBestPair(token);
    ctxByToken.set(token, ctx);
    const name = (ctx.pair.baseToken && ctx.pair.baseToken.symbol) || token.slice(0, 6);
    await notify('Watch · ' + name + ' · ' + TIMEFRAME);
  }
  const bars = await fetchOHLCV(ctx.network, ctx.poolAddress, unit, agg);
  if (bars.length < 60) {
    console.log(token.slice(0, 6), 'te weinig candles', bars.length);
    return;
  }
  const res = runEngine(bars, getParams());
  const tag = ((ctx.pair.baseToken && ctx.pair.baseToken.symbol) || token.slice(0, 6));
  const fresh = [];
  for (const e of res.events) {
    const key = token + '-' + e.time + '-' + e.type;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(e);
  }
  if (!firstByToken.get(token)) {
    firstByToken.set(token, true);
    console.log(tag, 'historie overgeslagen:', res.events.length, '· $' + fmtPrice(res.last.close));
    return;
  }
  for (const e of fresh) {
    const line = [
      tag,
      e.type,
      e.src ? '(' + e.src + ')' : '',
      '@ $' + fmtPrice(e.price)
    ].filter(Boolean).join(' ');
    await notify(line);
  }
  if (liveEnabled() && fresh.length) {
    await handleLiveEvents(fresh, token);
  }
  if (!fresh.length) {
    console.log(new Date().toISOString(), tag, 'geen nieuw signaal · $' + fmtPrice(res.last.close));
  }
}

async function tick() {
  if (!TOKEN_LIST.length) throw new Error('Zet TOKEN_ADDRESS in Railway (één mint of mint1,mint2,mint3)');
  for (const token of TOKEN_LIST) {
    try {
      await tickOne(token);
    } catch (err) {
      console.error('tick fout', token.slice(0, 6), err.message);
      ctxByToken.delete(token);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error('tick fout', err.message);
  }
  setTimeout(loop, POLL_MS);
}

console.log('Signaal worker start. Tokens=', TOKEN_LIST.length ? TOKEN_LIST.length : '(LEEG)', TOKEN_LIST.map(t => t.slice(0,6)).join(','), 'tf=', TIMEFRAME, 'poll=', POLL_MS + 'ms');
loop();
