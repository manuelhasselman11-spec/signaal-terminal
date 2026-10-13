'use strict';
/**
 * Volume profile for Solana meme coins (12-10c) — shared by the bot and the website (build-web.js copies it in).
 *
 * What it gives you (all prices in USD):
 *   POC  point of control   = the price level where the most volume traded
 *   VAH / VAL               = top / bottom of the value area: the smallest band around the POC holding 70 % of the volume
 *   HVN / LVN               = high / low volume nodes: local peaks / valleys in the profile (support-resistance / "thin air")
 *   shape                   = 'P' (volume high in the range), 'b' (volume low in the range), 'D' (balanced) or 'dubbel' (two distributions)
 *   delta / buyShare        = buy volume − sell volume and buy / (buy + sell), per level and in total
 *
 * Price buckets are LOG-spaced (every bucket is stepPct % wide), so one setting works for a coin at $0.000003 and at $3.
 * vpStepFor() picks the bucket size from the coin's own movement (half the median candle range).
 *
 * Two inputs:
 *   - candles (history, backtests): each candle's volume is spread over the buckets between its low and high; the buy part is
 *     estimated with the close location ((close − low) / (high − low)). That is an APPROXIMATION — real buy/sell needs trades.
 *   - trades (live, GeckoTerminal /trades: last 300 swaps with buy/sell + wallet): exact price, side and size. vpFilterTrades()
 *     first removes dust, wash trading (one wallet buying and selling about the same amount) and wallets you block.
 *
 * Incremental: vpAddBar / vpRemoveBar (and vpAdd / vpRemove for trades) update the profile in O(buckets of that candle),
 * so a rolling window never has to be rebuilt from scratch. vpResult() reads the levels (O(number of buckets)).
 */

/** @typedef {{ time:number, open:number, high:number, low:number, close:number, volume:number }} Bar */
/** @typedef {{ price:number, usd:number, side?:('buy'|'sell'), wallet?:string, time?:number }} Trade */
/** @typedef {{ lo:number, hi:number, mid:number, vol:number, buy:number, sell:number }} Level */
/** @typedef {{ poc:number, vah:number, val:number, hvn:number[], lvn:number[], lvnZones:{lo:number,hi:number}[], shape:string, total:number, delta:number,
 *              buyShare:number, stepPct:number, lo:number, hi:number, pocPos:number, thinAbove:number, levels?:Level[] }} Profile */

/**
 * A new, empty profile.
 * @param {number} stepPct bucket width in % (0.05 … 20)
 */
function vpCreate(stepPct){
  const s = Math.min(20, Math.max(0.05, Number(stepPct) || 0.5));
  return { stepPct: s, lr: Math.log(1 + s / 100), m: new Map(), total: 0, buy: 0, sell: 0 };
}
/** bucket number of a price */
function vpIdx(p, price){ return Math.floor(Math.log(price) / p.lr + 1e-9); }
/** lowest price of bucket i */
function vpEdge(p, i){ return Math.exp(i * p.lr); }

/** add (sign +1) or remove (sign −1) volume at one price; buyVol null = side unknown */
function vpPut(p, i, vol, buyVol, sign){
  let L = p.m.get(i);
  if (!L){ if (sign < 0) return; L = { vol: 0, buy: 0, sell: 0 }; p.m.set(i, L); }
  L.vol += sign * vol; p.total += sign * vol;
  if (buyVol != null){ const b = Math.min(vol, Math.max(0, buyVol)); L.buy += sign * b; L.sell += sign * (vol - b); p.buy += sign * b; p.sell += sign * (vol - b); }
  if (L.vol <= 1e-12 * Math.max(1, p.total)) p.m.delete(i);
  if (p.total < 0) p.total = 0;
}
/**
 * Add one trade (exact price and side).
 * @param {object} p profile
 * @param {number} price
 * @param {number} usd volume in USD
 * @param {('buy'|'sell')=} side
 */
function vpAdd(p, price, usd, side){
  if (!(price > 0) || !(usd > 0)) return;
  vpPut(p, vpIdx(p, price), usd, side === 'buy' ? usd : side === 'sell' ? 0 : null, 1);
}
/** remove a trade that was added before (rolling windows) */
function vpRemove(p, price, usd, side){
  if (!(price > 0) || !(usd > 0)) return;
  vpPut(p, vpIdx(p, price), usd, side === 'buy' ? usd : side === 'sell' ? 0 : null, -1);
}
/** buy part of a candle, estimated from where it closed in its range (0.5 for a candle without range) */
function vpClv(bar){ const r = bar.high - bar.low; return r > 0 ? Math.min(1, Math.max(0, (bar.close - bar.low) / r)) : 0.5; }
/** spread a candle's volume over the buckets between its low and high (weighted by overlap in log-price) */
function vpBar(p, bar, sign){
  const vol = Number(bar.volume) || 0, lo = bar.low, hi = bar.high;
  if (!(vol > 0) || !(lo > 0) || !(hi >= lo)) return;
  const bf = vpClv(bar), a = vpIdx(p, lo), b = vpIdx(p, hi);
  if (a === b){ vpPut(p, a, vol, vol * bf, sign); return; }
  const L0 = Math.log(lo), L1 = Math.log(hi), span = L1 - L0;
  for (let i = a; i <= b; i++){
    const x0 = Math.max(L0, i * p.lr), x1 = Math.min(L1, (i + 1) * p.lr);
    const w = span > 0 ? Math.max(0, x1 - x0) / span : 0;
    if (w > 0) vpPut(p, i, vol * w, vol * w * bf, sign);
  }
}
/** add a candle */
function vpAddBar(p, bar){ vpBar(p, bar, 1); }
/** remove a candle that was added before */
function vpRemoveBar(p, bar){ vpBar(p, bar, -1); }

/**
 * Bucket size that fits this coin: half the median candle range of the last `n` candles, between 0.2 % and 8 %.
 * @param {Bar[]} bars
 */
function vpStepFor(bars, n){
  const list = bars.slice(-(n || 100)).map(b => b.low > 0 ? (b.high / b.low - 1) * 100 : 0).filter(x => x > 0).sort((x, y) => x - y);
  const med = list.length ? list[Math.floor(list.length / 2)] : 1;
  return Math.min(8, Math.max(0.2, med / 2));
}

/**
 * Read the profile.
 * @param {object} p profile
 * @param {{ valuePct?:number, hvn?:number, lvn?:number, roomPct?:number, levels?:boolean }=} opt valuePct 0.7 = 70 % value area; hvn/lvn = factor of the average level;
 *        roomPct = how far above VAH "thinAbove" looks (3 %); levels:false = skip the per-level list (faster)
 * @returns {Profile|null}
 */
function vpResult(p, opt){
  const o = opt || {}, valuePct = o.valuePct || 0.7, hvnF = o.hvn || 1.6, lvnF = o.lvn != null ? o.lvn : 0.35;
  if (!(p.total > 0) || !p.m.size) return null;
  let first = Infinity, last = -Infinity;
  p.m.forEach((L, i) => { if (i < first) first = i; if (i > last) last = i; });
  const n = last - first + 1;
  if (n > 20000) return null;   // absurd range (broken data)
  const vol = new Float64Array(n), buy = new Float64Array(n), sell = new Float64Array(n);
  p.m.forEach((L, i) => { vol[i - first] = Math.max(0, L.vol); buy[i - first] = Math.max(0, L.buy); sell[i - first] = Math.max(0, L.sell); });
  let pocI = 0; for (let k = 1; k < n; k++) if (vol[k] > vol[pocI]) pocI = k;
  // value area: grow from the POC towards the heavier neighbour until 70 % of the volume is inside
  let a = pocI, b = pocI, acc = vol[pocI];
  const total = vol.reduce((s, x) => s + x, 0), target = total * valuePct;
  while (acc < target && (a > 0 || b < n - 1)){
    const up = b < n - 1 ? vol[b + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn){ b++; acc += vol[b]; } else { a--; acc += vol[a]; }
  }
  const edge = k => vpEdge(p, first + k), mid = k => Math.sqrt(edge(k) * edge(k + 1));
  // nodes on a lightly smoothed profile (3 buckets), compared with the average of the traded range
  const sm = new Float64Array(n);
  for (let k = 0; k < n; k++) sm[k] = (vol[k] + (k > 0 ? vol[k - 1] : vol[k]) + (k < n - 1 ? vol[k + 1] : vol[k])) / 3;
  const mean = total / n, hvn = [], lvn = [], lvnZones = [];
  for (let k = 1; k < n - 1; k++) if (sm[k] >= sm[k - 1] && sm[k] > sm[k + 1] && sm[k] >= hvnF * mean) hvn.push(mid(k));
  // LVN: a run of thin buckets with more volume on both sides (the middle of the run, and the whole zone)
  for (let k = 1; k < n - 1; k++){
    if (!(sm[k] <= lvnF * mean)) continue;
    let e = k; while (e + 1 < n - 1 && sm[e + 1] <= lvnF * mean) e++;
    if (sm[k - 1] > lvnF * mean && sm[e + 1] > lvnF * mean){ lvn.push(mid(Math.round((k + e) / 2))); lvnZones.push({ lo: edge(k), hi: edge(e + 1) }); }
    k = e;
  }
  // shape: two big peaks with a deep valley in between = double distribution; otherwise where the POC sits in the range
  let shape = 'D';
  const peaks = []; for (let k = 1; k < n - 1; k++) if (sm[k] >= sm[k - 1] && sm[k] > sm[k + 1]) peaks.push(k);
  let maxSm = 0; for (let k = 0; k < n; k++) if (sm[k] > maxSm) maxSm = sm[k];
  const big = peaks.filter(k => sm[k] >= 0.6 * maxSm);
  let dbl = false;
  for (let x = 0; x < big.length && !dbl; x++) for (let y = x + 1; y < big.length && !dbl; y++){
    if (big[y] - big[x] < 3) continue;
    let valley = Infinity; for (let k = big[x]; k <= big[y]; k++) valley = Math.min(valley, sm[k]);
    if (valley <= 0.35 * Math.min(sm[big[x]], sm[big[y]])) dbl = true;
  }
  const pocPos = n > 1 ? (pocI + 0.5) / n : 0.5;
  if (dbl) shape = 'dubbel'; else if (pocPos >= 0.6) shape = 'P'; else if (pocPos <= 0.4) shape = 'b';
  const tb = p.buy, ts = p.sell;
  // how thin is the air just above the value area: average volume of the buckets up to roomPct above VAH, divided by the average bucket
  const roomB = Math.max(1, Math.ceil((o.roomPct || 3) / p.stepPct));
  let thinSum = 0; for (let k = b + 1; k <= b + roomB; k++) thinSum += k < n ? vol[k] : 0;
  const thinAbove = mean > 0 ? thinSum / roomB / mean : 0;
  if (o.levels === false) return { poc: mid(pocI), vah: edge(b + 1), val: edge(a), hvn, lvn, lvnZones, shape, total, delta: tb - ts, buyShare: tb + ts > 0 ? tb / (tb + ts) : 0.5, stepPct: p.stepPct, lo: edge(0), hi: edge(n), pocPos, thinAbove };
  return {
    poc: mid(pocI), vah: edge(b + 1), val: edge(a), hvn, lvn, lvnZones, shape, total, delta: tb - ts, buyShare: tb + ts > 0 ? tb / (tb + ts) : 0.5,
    stepPct: p.stepPct, lo: edge(0), hi: edge(n), pocPos, thinAbove,
    levels: Array.from({ length: n }, (_, k) => ({ lo: edge(k), hi: edge(k + 1), mid: mid(k), vol: vol[k], buy: buy[k], sell: sell[k] }))
  };
}
/** volume between two prices (for "how thin is the air above the breakout") */
function vpVolBetween(prof, lo, hi){
  if (!prof) return 0;
  let s = 0; for (const L of prof.levels){ const ov = Math.min(hi, L.hi) - Math.max(lo, L.lo); if (ov > 0) s += L.vol * ov / (L.hi - L.lo); }
  return s;
}
/** a profile from a list of candles in one go */
function vpFromBars(bars, opt){
  const o = opt || {}, p = vpCreate(o.stepPct || vpStepFor(bars));
  bars.forEach(b => vpAddBar(p, b));
  return vpResult(p, o);
}

/**
 * Clean raw swaps before they go into a profile.
 *   - dust: trades below minUsd (default $1)
 *   - wash: a wallet that bought AND sold within windowSec (120 s) for about the same amount (within washTol, 15 %) → all its trades out
 *   - block: wallets you know are bots / MEV
 * Also tells you how much of the volume came from the single biggest wallet (insiders / bundlers: a safety signal, not a filter).
 * @param {Trade[]} trades
 * @param {{ minUsd?:number, windowSec?:number, washTol?:number, block?:Set<string> }=} opt
 */
function vpFilterTrades(trades, opt){
  const o = opt || {}, minUsd = o.minUsd != null ? o.minUsd : 1, win = o.windowSec || 120, tol = o.washTol != null ? o.washTol : 0.15, block = o.block || new Set();
  const ok = trades.filter(t => t && t.price > 0 && t.usd >= minUsd && !(t.wallet && block.has(t.wallet)));
  const by = new Map();
  ok.forEach(t => { if (!t.wallet) return; const g = by.get(t.wallet) || { b: 0, s: 0, t0: Infinity, t1: -Infinity }; if (t.side === 'buy') g.b += t.usd; else if (t.side === 'sell') g.s += t.usd; g.t0 = Math.min(g.t0, t.time || 0); g.t1 = Math.max(g.t1, t.time || 0); by.set(t.wallet, g); });
  const wash = new Set();
  by.forEach((g, w) => { if (g.b > 0 && g.s > 0 && Math.abs(g.b - g.s) <= tol * Math.max(g.b, g.s) && g.t1 - g.t0 <= win) wash.add(w); });
  const clean = ok.filter(t => !(t.wallet && wash.has(t.wallet)));
  const tot = clean.reduce((s, t) => s + t.usd, 0), per = new Map();
  clean.forEach(t => { if (t.wallet) per.set(t.wallet, (per.get(t.wallet) || 0) + t.usd); });
  const top = Math.max(0, ...per.values());
  return { trades: clean, dropped: { dustOrBlocked: trades.length - ok.length, wash: ok.length - clean.length }, washWallets: [...wash], topWalletShare: tot > 0 ? top / tot : 0 };
}
/** GeckoTerminal /pools/{pool}/trades → Trade[] (price of the coin in USD, newest first in the answer) */
function vpTradesFromGecko(json){
  return ((json && json.data) || []).map(d => {
    const a = d.attributes || {}, buy = a.kind === 'buy';
    return { price: Number(buy ? a.price_to_in_usd : a.price_from_in_usd), usd: Number(a.volume_in_usd), side: buy ? 'buy' : a.kind === 'sell' ? 'sell' : undefined,
      wallet: a.tx_from_address, time: Date.parse(a.block_timestamp) / 1000 };
  }).filter(t => t.price > 0 && t.usd > 0);
}
/**
 * Distribution warning (big players unloading): compared with `ago` candles earlier the POC fell more than dropPct,
 * the recent candles were mostly selling (buy share < maxBuy), volume was higher than normal and the price is below the POC.
 * @param {Profile} now profile up to now
 * @param {Profile} before profile `ago` candles earlier
 * @param {Bar[]} recent the last candles (e.g. 12)
 * @param {Bar[]} older the candles before those (e.g. 48)
 */
function vpDistribution(now, before, recent, older, opt){
  const o = opt || {}, dropPct = o.dropPct != null ? o.dropPct : 2, maxBuy = o.maxBuy != null ? o.maxBuy : 0.45, volX = o.volX || 1.2;
  if (!now || !before || !recent.length || !older.length) return { flag: false, why: [] };
  const why = [];
  const drift = (now.poc / before.poc - 1) * 100;
  if (drift <= -dropPct) why.push('POC zakt ' + drift.toFixed(1) + '%');
  const rv = recent.reduce((s, b) => s + b.volume, 0), bv = recent.reduce((s, b) => s + b.volume * vpClv(b), 0), share = rv > 0 ? bv / rv : 0.5;
  if (share < maxBuy) why.push('vooral verkopen (' + Math.round(share * 100) + '% koop)');
  const avgOld = older.reduce((s, b) => s + b.volume, 0) / older.length, avgNew = rv / recent.length;
  if (avgOld > 0 && avgNew >= volX * avgOld) why.push('volume ' + (avgNew / avgOld).toFixed(1) + '× normaal');
  const last = recent[recent.length - 1].close;
  if (last < now.poc) why.push('prijs onder de POC');
  return { flag: why.length === 4, why, drift, buyShare: share };
}

if (typeof module !== 'undefined') module.exports = { vpCreate, vpAdd, vpRemove, vpAddBar, vpRemoveBar, vpClv, vpStepFor, vpResult, vpVolBetween, vpFromBars, vpFilterTrades, vpTradesFromGecko, vpDistribution, vpIdx, vpEdge };
