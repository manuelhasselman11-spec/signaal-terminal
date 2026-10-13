'use strict';
/**
 * Strategy lab (13-10a) — the engine around labStrategies.js. PAPER ONLY: nothing here can send a transaction.
 *
 *  labPrep      indicators for one coin (EMA, ATR, RSI, Bollinger/Keltner, VWAP, anchored VWAP, swings, CVD-proxy,
 *               volume profile + naked POCs, regime per candle, risk score)
 *  labSim       one strategy on one coin: fill at the next candle's open, slippage + pool impact + round-trip cost,
 *               COSTS (13-10a, counted exactly once): ctx.cost = proportional cost of a round trip in % (Jupiter route + pool fees,
 *               measured per coin when possible — NOT the fixed SOL fees). q.feeSol = fixed SOL per round trip (network + priority).
 *               retP = return after proportional costs · ret = retP − feeSol / real stake (= the % at the real 0.08 SOL stake,
 *               used for every % figure and decision) · pnlSol = size × retP − feeSol (the fixed fee once, at the actual size).
 *               failed transactions, stop before target inside a candle, scale-out, break-even, trailing, time stop,
 *               volume exit, max holding time. Size from the tier (A/B/C/X) inside the cage.
 *  labRunCoin   all strategies (lab + volume profile + runner) on one coin
 *  labExplain   why each strategy did / did not want to buy on a candle (skip reasons)
 *  classify     outliers per strategy: PULL = return above Q3 + 3×IQR of its previous ≤ 200 trades (needs ≥ 30);
 *               RUG? = price −80% within 30 min after entry (a PROXY: real rug proof needs LP/dev data)
 *  metrics3     the 3 columns: (a) everything, (b) without PULLs, (c) without PULLs and RUG?s
 *  bootstrapCI / pOneSided / bh   95 % interval, p-value, Benjamini-Hochberg (multiple testing)
 *  thompson     bandit allocation over strategies
 *  portfolio    the cage (§3.1): max positions, exposure, per coin, loss per hour/day/week, agent circuit breaker;
 *               every candidate that is NOT taken is kept as a shadow trade with its skip reason
 */
const VPL = require('./volumeProfile');
const VPS = require('./vpStrategies');
const { LAB_STRATS, LAB_BY_NAME } = require('./labStrategies');
const runnerMod = (() => { try { return require('./runner'); } catch (_){ return null; } })();

/** default settings; the cage values are the defaults from the plan (only the owner may change them for live) */
const LAB_DEFAULTS = {
  tfSec: 300, slip: 0.3, lat: 1, failPct: 5, failFee: 0.15, failSellPct: 1, cool: 3,
  capital: 1,            // SOL, nominal paper capital
  riskPct: 1.5,          // max loss per trade, % of capital
  coinMaxPct: 8,         // max exposure in one coin, % of capital
  maxOpen: 8, maxExpPct: 40, hourLossPct: 4, dayLossPct: 8, weekLossPct: 15,
  agentLossStreak: 5, agentPauseMin: 120,
  feeSol: 0.0004,        // network + priority fees of a buy AND a sell
  depthPct: 1.5,         // max position as % of pool liquidity
  solUsd: 110,           // only for the depth cap; the bot passes the real price
  emergency: 50,         // emergency exit: a candle opens/trades ≥ this % under the entry → sell at once (rug-like)
  scale: 1,              // all strategy thresholds × this (robustness test: 0.8 / 1.2)
  costMult: 1,           // stress test: 2 = double all costs
  vp: 1, runner: 1,      // also run the volume-profile strategies and the runner
  on: ''                 // comma list of strategy names; empty = all
};

// ---------------- indicators ----------------
function ema(a, len){ const k = 2 / (len + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++){ e = i ? a[i] * k + e * (1 - k) : a[0]; o[i] = e; } return o; }
function rsiOf(C, len){
  const n = C.length, o = new Array(n).fill(50); if (n <= len) return o;
  let g = 0, l = 0; for (let i = 1; i <= len; i++){ const d = C[i] - C[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= len; l /= len; o[len] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = len + 1; i < n; i++){ const d = C[i] - C[i - 1]; g = (g * (len - 1) + Math.max(0, d)) / len; l = (l * (len - 1) + Math.max(0, -d)) / len; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}
function rollQuantile(a, win, q){
  const n = a.length, o = new Array(n).fill(NaN);
  for (let i = win; i < n; i++){ const w = a.slice(i - win, i).filter(Number.isFinite).sort((x, y) => x - y); if (w.length) o[i] = w[Math.floor(q * (w.length - 1))]; }
  return o;
}
/** time of the pool start in seconds, or 0 */
function startOf(created){ let c = typeof created === 'string' && !/^\d+$/.test(created) ? Date.parse(created) || 0 : Number(created) || 0; if (c > 1e11) c /= 1000; return c; }

/**
 * @param {{time:number,open:number,high:number,low:number,close:number,volume:number}[]} B candles, oldest first
 * @param {object} q settings (LAB_DEFAULTS + overrides)
 * @param {{ cost?:number, liq?:number, created?:any, key?:string, vol24?:number, solUsd?:number, S?:any[] }=} ctx
 */
function labPrep(B, q, ctx){
  const c = ctx || {}, n = B.length;
  const O = B.map(b => b.open), H = B.map(b => b.high), L = B.map(b => b.low), C = B.map(b => b.close), V = B.map(b => b.volume || 0);
  const clv = B.map(VPL.vpClv), atr = VPS.atrOf(B, 14).map((x, i) => Number.isFinite(x) ? x : (H[i] - L[i]) || C[i] * 0.01);
  const atrPct = atr.map((x, i) => x / C[i] * 100), atrPctQ25 = rollQuantile(atrPct, 96, 0.25);
  const ema9 = ema(C, 9), ema21 = ema(C, 21), ema50 = ema(C, 50), ema20 = ema(C, 20), rsi = rsiOf(C, 14);
  const med48 = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++){ const w = V.slice(Math.max(0, i - 48), i).sort((x, y) => x - y); med48[i] = Math.max(1e-9, w[Math.floor((w.length - 1) / 2)]); }
  med48[0] = V[0] || 1e-9;
  const bbMid = new Array(n).fill(NaN), bbUp = new Array(n).fill(NaN), bbW = new Array(n).fill(NaN), kcUp = ema20.map((e, i) => e + 1.5 * atr[i]);
  for (let i = 19; i < n; i++){ let s = 0, s2 = 0; for (let k = i - 19; k <= i; k++){ s += C[k]; s2 += C[k] * C[k]; } const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m)); bbMid[i] = m; bbUp[i] = m + 2 * sd; bbW[i] = 4 * sd / m; }
  const bbWq = rollQuantile(bbW, 96, 0.15);
  // VWAP (24 h rolling) and anchored VWAP (pool start if young, else the biggest-volume candle of the last 24 h)
  const tp = B.map(b => (b.high + b.low + b.close) / 3), PV = [0], VV = [0];
  for (let i = 0; i < n; i++){ PV.push(PV[i] + tp[i] * V[i]); VV.push(VV[i] + V[i]); }
  const per = Math.round(86400 / q.tfSec), vwap = new Array(n).fill(null), avwap = new Array(n).fill(null);
  const t0 = startOf(c.created), anchored0 = t0 && n && Math.abs(B[0].time - t0) <= 3 * 3600;
  const age = B.map(b => t0 ? (b.time - t0) / 3600 : null);
  let peakK = 0;
  for (let i = 1; i < n; i++){
    const a = Math.max(0, i - per); const vv = VV[i + 1] - VV[a]; if (vv > 0) vwap[i] = (PV[i + 1] - PV[a]) / vv;
    if (peakK < i - per) { peakK = Math.max(0, i - per); for (let k = peakK; k < i; k++) if (V[k] > V[peakK]) peakK = k; }
    if (V[i - 1] > V[peakK]) peakK = i - 1;
    const anc = anchored0 && age[i] < 72 ? 0 : peakK;
    const v2 = VV[i + 1] - VV[anc]; if (v2 > 0 && i - anc >= 3) avwap[i] = (PV[i + 1] - PV[anc]) / v2;
  }
  // CVD proxy: (2·close-location − 1) × volume
  const cvd = new Array(n); let cs = 0; for (let i = 0; i < n; i++){ cs += (2 * clv[i] - 1) * V[i]; cvd[i] = cs; }
  // swings (pivot ± 2 candles; a pivot at k is only known from k + 2 on — callers ask for pivots ≤ i − 2)
  const lastPH = new Array(n).fill(-1), lastPL = new Array(n).fill(-1);
  for (let k = 0; k < n; k++){
    const ph = k >= 2 && k + 2 < n && H[k] > H[k - 1] && H[k] > H[k - 2] && H[k] >= H[k + 1] && H[k] >= H[k + 2];
    const pl = k >= 2 && k + 2 < n && L[k] < L[k - 1] && L[k] < L[k - 2] && L[k] <= L[k + 1] && L[k] <= L[k + 2];
    lastPH[k] = ph ? k : k ? lastPH[k - 1] : -1; lastPL[k] = pl ? k : k ? lastPL[k - 1] : -1;
  }
  // volume profile (12 h rolling, same as the bot) + naked POCs (POCs of earlier 4 h blocks that price never touched again)
  const vp = c.S || VPS.vpSeries(B, 144, 0, 0.7), nakedPoc = new Array(n).fill(null), pocs = [];
  for (let i = 0; i < n; i++){
    for (let k = pocs.length - 1; k >= 0; k--) if (L[i] <= pocs[k].px && H[i] >= pocs[k].px) pocs.splice(k, 1);
    if (vp[i] && i % 48 === 0) pocs.push({ px: vp[i].poc, k: i });
    let best = null; for (const x of pocs) if (x.k <= i - 48 && x.px > C[i] && (!best || x.px < best)) best = x.px;
    nakedPoc[i] = best;
    if (pocs.length > 60) pocs.shift();
  }
  // real order flow from swaps (optional: ctx.trades = [[timeSec, buy 1/0, usd, price, wallet], …]); only swaps inside the candle.
  // ctx.cover = [[fromSec, toSec], …]: the stretches of time for which we really have EVERY swap (one GeckoTerminal fetch = its last
  // ±300 swaps, from the oldest of them until the moment of the fetch). A candle counts only if it lies fully inside one — otherwise
  // "no swaps" could just mean "not fetched" (a busy coin trades more than 300 times between two looks).
  const flow = c.trades && c.trades.length ? (() => {
    const fb = new Array(n).fill(0), fs = new Array(n).fill(0), fu = new Array(n).fill(0), big = new Array(n).fill(0), has = new Array(n).fill(false);
    const sets = new Array(n), list = c.trades.slice().sort((x, y) => x[0] - y[0]), first = list[0][0];
    let k = 0;
    for (const [ts, buy, usd, , w] of list){
      while (k < n - 1 && B[k + 1].time <= ts) k++;                 // the candle that holds this swap
      if (!(ts >= B[k].time && ts < B[k].time + q.tfSec)) continue;
      if (buy){ fb[k] += usd; (sets[k] = sets[k] || new Set()).add(w); } else { fs[k] += usd; if (usd >= 1000) big[k] += usd; }
    }
    const cover = Array.isArray(c.cover) && c.cover.length ? c.cover.filter(w => Array.isArray(w) && w[1] > w[0]) : null;
    for (let i = 0; i < n; i++){ fu[i] = sets[i] ? sets[i].size : 0; has[i] = cover ? cover.some(w => w[0] <= B[i].time && B[i].time + q.tfSec <= w[1]) : B[i].time >= first; }
    return { buy: fb, sell: fs, buyers: fu, bigSell: big, has };
  })() : null;
  // regime per candle
  const er = new Array(n).fill(0), regime = new Array(n).fill('range'), atrMed = rollQuantile(atrPct, 288, 0.5);
  for (let i = 12; i < n; i++){
    let path = 0; for (let k = i - 11; k <= i; k++) path += Math.abs(C[k] - C[k - 1]);
    er[i] = path > 0 ? Math.abs(C[i] - C[i - 12]) / path : 0;
    let v12 = 0; for (let k = i - 11; k <= i; k++) v12 += V[k];
    if (age[i] != null && age[i] < 24) regime[i] = 'hype';
    else if (v12 / 12 < 0.25 * med48[i] || atrPct[i] < 0.15) regime[i] = 'dood';
    else if (Number.isFinite(atrMed[i]) && atrPct[i] > 2 * atrMed[i]) regime[i] = 'hoge vol';
    else if (er[i] >= 0.45) regime[i] = C[i] > ema50[i] ? 'trend op' : 'trend neer';
  }
  // risk score 0–100 (soft filters → size tier, never a veto)
  const liq = Number(c.liq) || 0, turnover = liq > 0 && c.vol24 ? c.vol24 / liq : 0;
  const riskBase = (liq > 0 ? (liq < 100000 ? 30 : liq < 250000 ? 15 : 0) : 20) + (turnover > 20 ? 15 : 0);
  const risk = i => Math.min(100, riskBase + (age[i] != null ? (age[i] < 24 ? 25 : age[i] < 72 ? 10 : 0) : 0) + (atrPct[i] > 6 ? 25 : atrPct[i] > 3 ? 15 : 0));
  const impact = liq > 0 ? Math.min(3, 100 * q.capital * q.solUsd * q.coinMaxPct / 100 / (liq / 2)) : 0.3;
  const hiN = (i, k) => { let m = -Infinity; for (let j = Math.max(0, i - k); j < i; j++) if (H[j] > m) m = H[j]; return m; };
  const loN = (i, k) => { let m = Infinity; for (let j = Math.max(0, i - k); j < i; j++) if (L[j] < m) m = L[j]; return m; };
  const argHi = (k, w) => { let b = -1; for (let j = Math.max(0, k - w + 1); j <= k; j++) if (b < 0 || H[j] > H[b]) b = j; return b; };
  const argLo = (k, w) => { let b = -1; for (let j = Math.max(0, k - w + 1); j <= k; j++) if (b < 0 || L[j] < L[b]) b = j; return b; };
  const lastSwingHigh = x => { if (x < 0) return null; const k = lastPH[Math.min(x, n - 1)]; return k >= 0 ? { k, px: H[k] } : null; };
  const lastSwingLow = x => { if (x < 0) return null; const k = lastPL[Math.min(x, n - 1)]; return k >= 0 ? { k, px: L[k] } : null; };
  // Latency-honest fills (13-10b). The bot looks at a coin only now and then (with 300 practice coins: every ±30–60 min). A signal on
  // candle i is SEEN at the first look after that candle closed, so the paper fill is the open of the candle that was forming at that
  // look — not the open of i + 1, which can lie a whole look-interval in the past (that price was no longer available).
  // ctx.looks = the forming-candle times of the looks so far (sorted). Without looks: fill at i + 1 (backtests, old behaviour).
  // Before the first look (history the bot never traded) also i + 1. Not seen yet (the candle closed after the last look) → -1.
  const looks = Array.isArray(c.looks) && c.looks.length ? c.looks.slice().sort((a, b) => a - b) : null;
  const fillIdx = !looks ? null : i => {
    const closeAt = B[i].time + q.tfSec;
    if (closeAt <= looks[0]) return i + 1;
    let lo = 0, hi = looks.length; while (lo < hi){ const m = (lo + hi) >> 1; if (looks[m] >= closeAt) hi = m; else lo = m + 1; }
    if (lo >= looks.length) return -1;
    const f = looks[lo]; let k = i + 1; while (k < n && B[k].time < f) k++;
    return k < n ? k : -1;
  };
  return { B, n, O, H, L, C, V, T: B.map(b => b.time), clv, atr, atrPct, atrPctQ25, ema9, ema21, ema50, rsi, med48, bbMid, bbUp, bbW, bbWq, kcUp, vwap, avwap, cvd,
    vp, nakedPoc, regime, er, age, risk, liq, flow, fillIdx, cost: (c.cost != null && Number.isFinite(Number(c.cost)) ? Number(c.cost) : 1) * q.costMult, side: (q.slip + impact) / 100 * q.costMult, key: String(c.key || ''),
    hiN, loN, argHi, argLo, lastSwingHigh, lastSwingLow };
}

/** deterministic 0…1 from a text (failed transactions are the same in every run) */
function hash01(s){ let h = 2166136261; for (let k = 0; k < s.length; k++){ h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }
/** strategy params × scale (robustness test); candle counts stay whole numbers */
function scaled(params, f){ const o = {}; Object.entries(params || {}).forEach(([k, v]) => { o[k] = typeof v === 'number' ? (Number.isInteger(v) && v >= 3 ? Math.max(1, Math.round(v * f)) : v * f) : v; }); return o; }

/** size tier from signal strength and risk score: A 100 %, B 50 %, C 20 % (X 15 % = exploration, set by the caller) */
function tierOf(conf, risk){ const s = (conf || 0.5) - risk / 200; return s >= 0.45 ? 'A' : s >= 0.25 ? 'B' : 'C'; }
const TIER_MULT = { A: 1, B: 0.5, C: 0.2, X: 0.15 };

/**
 * Simulate one lab strategy on one coin.
 * @returns {object[]} trades: { strat, t, i, e, stop, exitTime, ret, why, exit, bars, peak, mae, conf, tier, size, pnlSol, regime, risk, rug, open?, failed? }
 */
function labSim(def, P, q){
  const n = P.n, out = [], p = scaled(def.params, q.scale), side = P.side, name = def.name;
  let pos = null, cool = 0;
  const start = 60;
  for (let i = start; i < n; i++){
    if (pos){
      if (i < pos.fi) continue;
      let ex = null, why = '';
      const fail = k => hash01(P.key + name + pos.t + ':' + k) < q.failPct / 100 ? 1 - q.failSellPct / 100 : 1;
      if (P.L[i] <= pos.stop){ ex = Math.min(pos.stop, P.O[i]); why = pos.tp ? 'trail/BE' : P.O[i] <= pos.e0 * (1 - q.emergency / 100) ? 'noodexit' : 'stop'; }
      else {
        for (const t of pos.tps){
          if (t.hit || !(P.H[i] >= t.px)) continue;
          t.hit = true; pos.left -= t.frac; pos.gross += t.frac * (t.px * (1 - side) * fail('tp' + t.px) / pos.e - 1); pos.tp = true;
          if (pos.beAt === 'tp1') pos.stop = Math.max(pos.stop, pos.e);
        }
        if (pos.left <= 1e-9){ out.push(close(pos, i, null, 'doelen')); pos = null; cool = i + q.cool; continue; }
        pos.hh = Math.max(pos.hh, P.H[i]);
        const r1 = pos.hh >= pos.e0 + pos.R;
        if (pos.beAt === '1R' && r1) pos.stop = Math.max(pos.stop, pos.e);
        const trailOn = pos.trailFrom === 'start' || (pos.trailFrom === 'tp1' && pos.tp) || (pos.trailFrom === '1R' && r1);
        if (trailOn && pos.trailAtr) pos.stop = Math.max(pos.stop, pos.hh - pos.trailAtr * P.atr[i]);
        if (trailOn && pos.trailPct) pos.stop = Math.max(pos.stop, pos.hh * (1 - pos.trailPct / 100));
        if (pos.volExit && P.C[i] < pos.e && P.clv[i] < 0.25 && P.clv[i - 1] < 0.25 && P.V[i] >= 1.5 * P.med48[i]){ ex = P.C[i]; why = 'verkoopdruk'; }
        else if (pos.time && !pos.tp && i - pos.fi >= pos.time && P.C[i] <= pos.e * 1.005){ ex = P.C[i]; why = 'tijd'; }
        else if (i - pos.fi >= pos.max){ ex = P.C[i]; why = 'max'; }
      }
      pos.hh = Math.max(pos.hh, P.H[i]); pos.ll = Math.min(pos.ll, P.L[i]);
      if (i - pos.fi < 6 && P.L[i] <= pos.e0 * 0.2) pos.rug = true;
      if (ex != null){ out.push(close(pos, i, ex * fail('x'), why)); pos = null; cool = i + q.cool; }
      continue;
    }
    if (i < cool || i + 1 >= n) continue;
    let s; try { s = def.sig(i, P, p); } catch (e){ s = { ok: false, why: 'fout: ' + e.message }; }
    if (!s || !s.ok) continue;
    const fi = P.fillIdx ? P.fillIdx(i) : i + 1;
    if (fi < 0 || fi >= n) continue;                      // not seen by a look yet (honest fills): no trade (yet)
    const raw = q.lat ? P.O[fi] : P.C[i], t = P.T[i] + q.tfSec;
    if (!(raw > s.stop)) continue;
    const risk = P.risk(i), tier = tierOf(s.conf, risk);
    if (hash01(P.key + name + t) < q.failPct / 100){
      out.push({ strat: name, t, i, fillT: P.T[fi], e: raw, exitTime: t, ret: -q.failFee / 100, failed: true, why: s.why, exit: 'mislukt', bars: 0, peak: 0, mae: 0, conf: s.conf, tier, size: 0, pnlSol: -q.feeSol / 2, regime: P.regime[i], risk });
      cool = i + 1; continue;
    }
    const e = raw * (1 + side), stopDist = Math.max(0.005, (e - s.stop) / e);
    const base = Math.min(q.capital * q.riskPct / 100 / stopDist, q.capital * q.coinMaxPct / 100);
    const depth = P.liq > 0 ? q.depthPct / 100 * P.liq / q.solUsd : Infinity;
    pos = { fi, t, i, e, e0: raw, stop: s.stop, R: raw - s.stop, tps: (s.tps || []).map(x => ({ px: x.px, frac: x.frac })), trailAtr: s.trailAtr || 0, trailPct: s.trailPct || 0,
      trailFrom: s.trailFrom || 'tp1', beAt: s.beAt || null, time: s.time || 0, max: s.max || 72, volExit: !!s.volExit, left: 1, gross: 0, tp: false, hh: raw, ll: raw,
      why: s.why, conf: s.conf, tier, risk, size: Math.min(base, depth) * TIER_MULT[tier], regime: P.regime[i], rug: false };
  }
  if (pos){ const tr = close(pos, n - 1, P.C[n - 1], 'open'); tr.open = true; tr.exitTime = null; out.push(tr); }
  return out;
  function close(ps, j, px, why){
    const g = ps.gross + (px != null ? ps.left * (px * (1 - side) / ps.e - 1) : 0), retP = g - P.cost / 100, fixA = fixedPctA(q), ret = retP - fixA;
    return { strat: name, t: ps.t, i: ps.i, fillT: P.T[ps.fi], e: ps.e, stop: ps.stop, exitTime: P.T[j] + q.tfSec, ret, why: ps.why, exit: why, bars: j - ps.fi + 1, peak: ps.hh / ps.e - 1, mae: ps.ll / ps.e - 1,
      conf: ps.conf, tier: ps.tier, size: ps.size, retP, pnlSol: ps.size * retP - q.feeSol, regime: ps.regime, risk: ps.risk, rug: ps.rug, costPct: P.cost / 100 + 2 * side + fixA };
  }
}

/** the fixed SOL fees as a fraction of the REAL stake (capital × coinMaxPct: 0.08 SOL by default) */
function fixedPctA(q){ const stake = q.capital * q.coinMaxPct / 100; return stake > 0 ? q.feeSol / stake : 0; }
/** convert volume-profile / runner trades to the lab format (they size like tier B: 50 %); their ret is after proportional costs only */
function fromVp(tr, P, q){
  const size = q.capital * q.coinMaxPct / 100 * TIER_MULT.B;
  return { strat: 'vp:' + tr.strat, t: tr.t, i: tr.i, fillT: tr.fillT != null ? tr.fillT : null, e: tr.e, exitTime: tr.exitTime, ret: tr.failed ? tr.ret : tr.ret - fixedPctA(q), retP: tr.ret,
    costPct: tr.failed ? null : P.cost / 100 + 2 * P.side + fixedPctA(q), why: tr.why, exit: tr.exit, bars: tr.bars, peak: tr.peak, mae: null, conf: 0.5, tier: 'B',
    size: tr.failed ? 0 : size, pnlSol: tr.failed ? -q.feeSol / 2 : size * tr.ret - q.feeSol, regime: tr.i != null ? P.regime[tr.i] : null, risk: tr.i != null ? P.risk(tr.i) : null, rug: false, open: tr.open, failed: tr.failed };
}

/**
 * All strategies on one coin.
 * @param {object[]} B candles
 * @param {object} q settings
 * @param {object} ctx see labPrep
 */
function labRunCoin(B, q, ctx){
  const Q = Object.assign({}, LAB_DEFAULTS, q || {}), P = labPrep(B, Q, ctx), on = String(Q.on || '').split(',').map(s => s.trim()).filter(Boolean);
  const want = nm => !on.length || on.includes(nm), trades = [];
  for (const def of LAB_STRATS) if (want(def.name)) labSim(def, P, Q).forEach(t => trades.push(t));
  if (Q.vp && B.length > 160){
    const vq = Object.assign(VPS.vpParams({}, Q.tfSec), { slip: Q.slip * Q.costMult, failPct: Q.failPct });
    const VP = VPS.vpPrep(B, vq, { cost: P.cost, liq: P.liq, created: (ctx || {}).created, key: P.key, S: P.vp });
    VP.side = P.side; VP.fillIdx = P.fillIdx;
    for (const s of ['vaRev', 'lvnBrk', 'hvnSup', 'postMig']) if (want('vp:' + s)) VPS.vpSim(s, VP, vq).forEach(t => trades.push(fromVp(t, P, Q)));
  }
  if (Q.runner && runnerMod && want('runner') && B.length > 200){
    const rq = runnerMod.runnerParams(Q.tfSec, {}); rq.slip = P.side; if (P.fillIdx) rq.fillIdx = P.fillIdx;
    const idx = new Map(P.T.map((t, k) => [t, k]));
    runnerMod.runnerTrades(B, rq, P.cost).forEach(t => { const i = idx.get(t.entryTime); trades.push(fromVp({ strat: 'runner', t: t.entryTime + Q.tfSec, i, fillT: t.fillT != null ? t.fillT : null, e: t.e != null ? t.e : i != null ? P.C[i] : null, exitTime: t.exitTime, ret: t.ret, why: 'uitbraak 12 u', exit: t.open ? 'open' : 'trail/stop', bars: null, peak: t.peak, open: t.open }, P, Q)); });
    trades.filter(t => t.strat === 'vp:runner').forEach(t => { t.strat = 'runner'; });
  }
  return { trades, P };
}

/** why each lab strategy did / did not want to buy on candle i (default: the last one) */
function labExplain(P, q, i){
  const Q = Object.assign({}, LAB_DEFAULTS, q || {}), k = i == null ? P.n - 1 : i;
  return LAB_STRATS.map(def => { let r; try { r = k >= 60 ? def.sig(k, P, scaled(def.params, Q.scale)) : { ok: false, why: 'te weinig candles' }; } catch (e){ r = { ok: false, why: 'fout' }; }
    return { strat: def.name, title: def.title, ok: !!(r && r.ok), why: r ? r.why : '?' }; });
}

// ---------------- outliers, metrics, statistics ----------------
function quantile(sorted, q){ if (!sorted.length) return NaN; const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); }
/** marks t.cls = 'PULL' | 'RUG?' | 'NORMAAL' per strategy, in time order, using only EARLIER trades for the threshold */
function classify(trades){
  const by = {}; trades.slice().sort((a, b) => a.t - b.t).forEach(t => (by[t.strat] = by[t.strat] || []).push(t));
  Object.values(by).forEach(list => {
    const hist = [];
    list.forEach(t => {
      if (t.rug) t.cls = 'RUG?';
      else if (hist.length >= 30){ const s = hist.slice(-200).sort((a, b) => a - b), q1 = quantile(s, 0.25), q3 = quantile(s, 0.75); t.cls = t.ret > q3 + 3 * (q3 - q1) ? 'PULL' : 'NORMAAL'; }
      else t.cls = 'NORMAAL';
      if (!t.failed && !t.open) hist.push(t.ret);
    });
  });
  return trades;
}
function erf(x){ const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
/** one-sided p-value for "mean > 0" (normal approximation; only meaningful with ≥ 30 trades) */
function pOneSided(rets){ const n = rets.length; if (n < 2) return 1; const m = rets.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); if (!(sd > 0)) return m > 0 ? 0 : 1; const z = m / (sd / Math.sqrt(n)); return 0.5 * (1 - erf(z / Math.SQRT2)); }
/** Benjamini-Hochberg: which hypotheses survive at false-discovery rate `alpha` */
function bh(pvals, alpha){ const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]), m = pvals.length, pass = new Array(m).fill(false); let k = -1; idx.forEach(([p], r) => { if (p <= (r + 1) / m * alpha) k = r; }); for (let r = 0; r <= k; r++) pass[idx[r][1]] = true; return pass; }
function rng(seed){ let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** 95 % bootstrap interval of the mean (seeded → the same every run) */
function bootstrapCI(x, iters, seed){ const n = x.length; if (n < 5) return [NaN, NaN]; const r = rng(seed || 7), ms = []; for (let k = 0; k < (iters || 2000); k++){ let s = 0; for (let j = 0; j < n; j++) s += x[Math.floor(r() * n)]; ms.push(s / n); } ms.sort((a, b) => a - b); return [quantile(ms, 0.025), quantile(ms, 0.975)]; }

/** metrics of one list (closed trades; failed transactions count as small losses) */
function metrics(list, hours){
  const L = list.filter(t => !t.open), r = L.map(t => t.ret), n = r.length, sol = L.reduce((a, t) => a + (t.pnlSol || 0), 0);
  const w = r.filter(x => x > 0), l = r.filter(x => x <= 0), gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0), m = n ? r.reduce((a, b) => a + b, 0) / n : 0;
  let eq = 0, pk = 0, dd = 0; L.slice().sort((a, b) => a.t - b.t).forEach(t => { eq += t.pnlSol || 0; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); });
  const hold = L.filter(t => t.bars != null).map(t => t.bars);
  return { n, win: n ? w.length / n : 0, exp: m, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), avgWin: w.length ? gw / w.length : 0, avgLoss: l.length ? -gl / l.length : 0, sol, ddSol: dd,
    perHour: hours ? n / hours : null, solPerHour: hours ? sol / hours : null, hold: hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : null, p: pOneSided(r), ci: bootstrapCI(r, 1000, 11) };
}
/** the 3 report columns (§2.4) */
function metrics3(list, hours){ return { a: metrics(list, hours), b: metrics(list.filter(t => t.cls !== 'PULL'), hours), c: metrics(list.filter(t => t.cls !== 'PULL' && t.cls !== 'RUG?'), hours) }; }

/** Thompson sampling: share of draws in which each strategy has the best mean return per trade (min 3 %, max 30 %).
 *  13-10b: only agents with ≥ minN (30) measured trades compete. Fewer trades = exploration (tier X) with the minimum budget:
 *  before, ONE lucky +20 % trade gave an agent the maximum 30 % (a mean of 1 trade with a guessed spread looks great). */
function thompson(byStrat, draws, seed, opt){
  const o = opt || {}, minN = o.minN != null ? o.minN : 30, D = draws || 2000;
  const names = Object.keys(byStrat), r = rng(seed || 3), wins = Object.fromEntries(names.map(k => [k, 0]));
  const gauss = () => { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const st = names.filter(k => byStrat[k].length >= Math.max(2, minN)).map(k => { const x = byStrat[k], n = x.length, m = x.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); return { k, m, se: (sd || 0.05) / Math.sqrt(n) }; });
  if (st.length) for (let d = 0; d < D; d++){ let best = null, bv = -Infinity; st.forEach(s => { const v = s.m + s.se * gauss(); if (v > bv){ bv = v; best = s.k; } }); wins[best]++; }
  const raw = names.map(k => st.length ? Math.min(0.3, Math.max(0.03, wins[k] / D)) : 1), sum = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(names.map((k, i) => [k, raw[i] / sum]));
}

/**
 * The cage (§3.1) over all candidate trades, in time order. Returns taken trades and skipped shadow trades with reasons.
 * @param {object[]} cands trades from labRunCoin (+ .coin)
 * @param {object} q settings (cage values)
 * @param {Record<string,number>=} alloc bandit weights per strategy (share of the total exposure an agent may use)
 */
function portfolio(cands, q, alloc){
  const Q = Object.assign({}, LAB_DEFAULTS, q || {}), cap = Q.capital, list = cands.filter(t => !t.failed).slice().sort((a, b) => a.t - b.t);
  const open = [], taken = [], skipped = [], agent = {}, closed = [];
  // net result of the trades that CLOSED in the window (a trade's result is only known when it closes — no look-ahead)
  const cum = [0];   // closed is in exit-time order → running sum + binary search (fast for 10 000s of trades)
  const lossSince = since => { let lo = 0, hi = closed.length; while (lo < hi){ const m = (lo + hi) >> 1; if (closed[m].exitTime > since) hi = m; else lo = m + 1; } return -(cum[closed.length] - cum[lo]); };
  const ag = k => agent[k] = agent[k] || { streak: 0, pauseUntil: 0 };
  const closeUpTo = now => {
    open.sort((a, b) => (a.exitTime || Infinity) - (b.exitTime || Infinity));
    while (open.length && open[0].exitTime != null && open[0].exitTime <= now){
      const c = open.shift(); closed.push(c); cum.push(cum[cum.length - 1] + c.pnlSol);
      const a = ag(c.strat);
      if (c.pnlSol < 0){ a.streak++; if (a.streak >= Q.agentLossStreak){ a.pauseUntil = c.exitTime + Q.agentPauseMin * 60; a.streak = 0; } } else a.streak = 0;
    }
  };
  for (const t of list){
    closeUpTo(t.t);
    let why = null;
    const exp = open.reduce((a, o) => a + o.size, 0), agExp = open.filter(o => o.strat === t.strat).reduce((a, o) => a + o.size, 0);
    if (open.length >= Q.maxOpen) why = 'max ' + Q.maxOpen + ' posities';
    else if (exp + t.size > cap * Q.maxExpPct / 100 + 1e-9) why = 'max blootstelling ' + Q.maxExpPct + '%';
    else if (open.some(o => o.coin === t.coin)) why = 'al in deze coin';
    else if (alloc && alloc[t.strat] != null && agExp + t.size > alloc[t.strat] * cap * Q.maxExpPct / 100 + 1e-9) why = 'budget van deze agent op';
    else if (ag(t.strat).pauseUntil > t.t) why = 'agent-pauze na ' + Q.agentLossStreak + ' verliezen';
    else if (lossSince(t.t - 3600) >= cap * Q.hourLossPct / 100) why = 'uurverlies ≥ ' + Q.hourLossPct + '%';
    else if (lossSince(t.t - 86400) >= cap * Q.dayLossPct / 100) why = 'dagverlies ≥ ' + Q.dayLossPct + '%';
    else if (lossSince(t.t - 7 * 86400) >= cap * Q.weekLossPct / 100) why = 'weekverlies ≥ ' + Q.weekLossPct + '%';
    else if (t.size > 0 && Q.feeSol / t.size > 0.04) why = 'te klein: vaste kosten > 4%';
    if (why){ skipped.push(Object.assign({}, t, { skip: why })); continue; }
    open.push(t); taken.push(t);
  }
  return { taken, skipped };
}

if (typeof module !== 'undefined') module.exports = { LAB_DEFAULTS, LAB_STRATS, LAB_BY_NAME, labPrep, labSim, labRunCoin, labExplain, classify, metrics, metrics3, pOneSided, bh, bootstrapCI, thompson, portfolio, tierOf, TIER_MULT, hash01, scaled, quantile, rng };
