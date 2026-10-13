'use strict';
/**
 * Volume-profile strategies (12-10c) — PRACTICE ONLY until the forward results prove them.
 *
 * Builds on volumeProfile.js. Everything here works on closed candles (5m by default) so the bot, the backtest and the
 * practice mode use exactly the same code.
 *
 *  S1 vaRev   POC/value-area reversion: in a BALANCED market (D / double profile, POC flat) a candle dips below VAL and closes
 *             back inside → buy, first target POC, second VAH.
 *  S2 lvnBrk  LVN breakout: a candle closes above VAH into thin air (little volume above = LVN) on a volume spike with buyers in
 *             control → buy, target the next HVN, then a trailing stop.
 *  S3 hvnSup  HVN support: in an UP-market (POC rising, price above POC) the price dips into the nearest heavy level below and
 *             bounces → buy, target the recent high, then trail.
 *  S4 postMig post-migration: a pool younger than 72 h; profile anchored at the pool start; breakout above that value area on
 *             a volume spike → buy, wide trailing stop (runs).
 *  S5 dist    distribution detector: POC sinks, mostly selling, volume above normal, price below POC (all four) →
 *             as EXIT for open positions (distExit) and as a BLOCK for new buys (distBlock).
 *
 * Realistic fills (see vpSim): the bot reacts after the candle closed → fill at the NEXT candle's open (lat=1), plus slippage per
 * side, plus price impact from pool liquidity, plus the round-trip cost of the coin (Jupiter quote + fixed network/priority fees),
 * a share of failed entries (fee lost, no position) and failed sells (worse price). Stops are checked before targets inside a
 * candle (pessimistic). The profile at candle i only uses candles BEFORE i (no look-ahead).
 *
 * A volume-profile signal is never enough on its own: the bot only buys for real after the safety gates (RugCheck, liquidity,
 * market filter, risk rules) — those live in worker.js / liveTrade.js and are not repeated here.
 */
const VPL = require('./volumeProfile');

/** @typedef {{ time:number, open:number, high:number, low:number, close:number, volume:number }} Bar */
/** @typedef {{ ok:boolean, why:string, stop?:number, tps?:{px:number,frac:number}[], be?:boolean, trailAtr?:number, trailPct?:number,
 *              trailFrom?:'start'|'tp1', time?:number, max?:number, lv?:object }} Signal */
/** @typedef {{ strat:string, entryTime:number, t:number, exitTime:number|null, ret:number, open?:boolean, failed?:boolean, why:string,
 *              exit:string, bars:number, peak:number }} VpTrade */

const VP_STRATS = ['vaRev', 'lvnBrk', 'hvnSup', 'postMig'];
const VP_NAMES = { vaRev: 'POC/VA-terugkeer', lvnBrk: 'LVN-uitbraak', hvnSup: 'HVN-steun', postMig: 'Na-migratie', dist: 'Distributie' };

/** default settings (5m candles). Every key can be changed with an env variable VP_<KEY in capitals> (see vpParams). */
const VP_DEFAULTS = {
  window: 144,       // profile window in candles (144 × 5m = 12 h)
  stepPct: 0,        // bucket size in %; 0 = automatic from the coin's own candle ranges
  valuePct: 0.7,     // value area = 70 % of the volume
  slip: 0.3,         // % worse fill per side than the candle price
  lat: 1,            // 1 = fill at the next candle's open (bot reacts after the close); 0 = at the close
  failPct: 5,        // % of buys/sells that fail on chain
  failFee: 0.15,     // % of the stake a failed buy costs (priority fee)
  failSellPct: 1,    // a failed sell is retried at this % worse price
  stakeUsd: 15,      // stake in USD for the price-impact estimate (0.08 SOL)
  maxRisk: 10,       // max distance entry → stop in %
  cool: 6,           // candles to wait after a trade on the same coin
  // S1 POC/VA reversion
  revDrift: 1.5,     // POC may have moved at most this % over the last 12 candles (balanced market)
  revRoom: 2,        // room to the POC must be at least this × the round-trip cost
  revTime: 36,       // sell after this many candles if TP1 was not reached and the trade is not in profit
  revMax: 72,
  // S2 LVN breakout
  brkVolX: 2,        // breakout candle volume ≥ this × the average of the last 48 candles
  brkClv: 0.6,       // close in the top 40 % of the candle (buyers in control; delta proxy)
  brkThin: 0.6,      // volume just above VAH ≤ this × the average level (thin air = LVN)
  brkExt: 1,         // at most this many ATR above VAH (not chasing)
  brkTrail: 2.5,     // ATR trailing stop after TP1
  brkTime: 24,
  brkMax: 72,
  // S3 HVN support
  hvnUp: 1,          // POC must have risen at least this % over hvnLook candles (up-regime)
  hvnLook: 48,       // 48 × 5m = 4 h
  hvnTouch: 0.4,     // the low must come within this % of the HVN
  hvnTrail: 2,
  hvnTime: 36,
  hvnMax: 72,
  // S4 post-migration
  migAgeH: 72,       // only pools younger than this (hours)
  migMinBars: 12,    // anchored profile needs at least this many candles
  migVolX: 2,
  migSl: 12,         // hard stop %
  migTrail: 25,      // trailing stop % below the highest price
  migMax: 144,
  migRun: 30,        // skip if the coin already rose more than this % in the last hour
  // S5 distribution
  distAgo: 12,       // compare with the profile this many candles ago
  distDrop: 2,       // POC fell at least this %
  distBuy: 0.45,     // buy share of the recent candles below this
  distVolX: 1.2,     // recent volume ≥ this × normal
  distExit: 1,       // 1 = sell an open position when distribution shows up
  distBlock: 1,      // 1 = no new buys within distAgo candles after a distribution warning
  on: 'vaRev,lvnBrk,hvnSup,postMig'
};

/**
 * Settings from env (VP_WINDOW, VP_REV_DRIFT, …: camelCase key → VP_ + SNAKE_CASE), scaled to the timeframe for the
 * candle counts that are really "hours".
 * @param {Record<string,string|undefined>=} env
 * @param {number=} tfSec candle length in seconds (300 = 5m)
 */
function vpParams(env, tfSec){
  const q = Object.assign({}, VP_DEFAULTS), e = env || {};
  Object.keys(VP_DEFAULTS).forEach(k => {
    const name = 'VP_' + k.replace(/[A-Z]/g, m => '_' + m).toUpperCase(), v = e[name];
    if (v == null || v === '') return;
    if (typeof VP_DEFAULTS[k] === 'string') q[k] = String(v);
    else if (Number.isFinite(Number(v))) q[k] = Number(v);
  });
  const sc = 300 / (tfSec || 300);
  if (sc !== 1) ['window', 'revTime', 'revMax', 'brkTime', 'brkMax', 'hvnTime', 'hvnMax', 'hvnLook', 'migMax', 'cool', 'distAgo'].forEach(k => { q[k] = Math.max(3, Math.round(q[k] * sc)); });
  q.tfSec = tfSec || 300;
  return q;
}

// ---------- indicators ----------
function atrOf(B, len){
  const n = B.length, out = new Array(n).fill(NaN); if (n < len + 1) return out;
  let s = 0;
  for (let i = 1; i <= len; i++) s += Math.max(B[i].high - B[i].low, Math.abs(B[i].high - B[i - 1].close), Math.abs(B[i].low - B[i - 1].close));
  out[len] = s / len;
  for (let i = len + 1; i < n; i++){
    const tr = Math.max(B[i].high - B[i].low, Math.abs(B[i].high - B[i - 1].close), Math.abs(B[i].low - B[i - 1].close));
    out[i] = (out[i - 1] * (len - 1) + tr) / len;
  }
  return out;
}
/** bucket size, rounded to a fixed ladder (×1.19 per step) so the profile at candle i only depends on the window itself */
function stepLadder(s){ return Math.pow(2, Math.round(Math.log2(s) * 4) / 4); }

/**
 * Rolling profile per candle: S[i] = profile of candles [i − W, i − 1] (never candle i itself).
 * Incremental (add the newest candle, remove the oldest); rebuilt only when the bucket size of the window changes.
 * @param {Bar[]} B
 * @param {number} W window in candles
 * @param {number=} stepPct fixed bucket size (0 = automatic)
 * @param {number=} valuePct
 */
function vpSeries(B, W, stepPct, valuePct){
  const n = B.length, S = new Array(n).fill(null);
  if (n < W + 1) return S;
  let p = null, step = 0;
  const want = i => stepPct || stepLadder(VPL.vpStepFor(B.slice(i - W, i), W));
  const build = (i, s) => { step = s; p = VPL.vpCreate(s); for (let k = i - W; k < i; k++) VPL.vpAddBar(p, B[k]); };
  for (let i = W; i < n; i++){
    const s = want(i);
    if (!p || s !== step) build(i, s);
    else { VPL.vpAddBar(p, B[i - 1]); VPL.vpRemoveBar(p, B[i - 1 - W]); }
    S[i] = VPL.vpResult(p, { valuePct: valuePct || 0.7, levels: false });
  }
  return S;
}
/**
 * Anchored profile from candle a (the pool start): A[i] = profile of candles [a, i − 1].
 * @param {Bar[]} B
 * @param {number} a anchor index
 * @param {number} minBars
 */
function vpAnchored(B, a, minBars, valuePct){
  const n = B.length, A = new Array(n).fill(null);
  if (a < 0 || n - a < minBars + 1) return A;
  let p = null, step = 0;
  for (let i = a + minBars; i < n; i++){
    const s = stepLadder(VPL.vpStepFor(B.slice(Math.max(a, i - 48), i), 48));
    if (!p || Math.max(s / step, step / s) > 1.5){ step = s; p = VPL.vpCreate(s); for (let k = a; k < i; k++) VPL.vpAddBar(p, B[k]); }
    else VPL.vpAddBar(p, B[i - 1]);
    A[i] = VPL.vpResult(p, { valuePct: valuePct || 0.7, levels: false });
  }
  return A;
}

/**
 * Everything the strategies need, computed once per coin.
 * @param {Bar[]} B candles, oldest first
 * @param {object} q vpParams()
 * @param {{ cost?:number, liq?:number, created?:number, S?:any[] }=} ctx cost = round trip % of the coin; liq = pool liquidity $;
 *        created = pool start (ms or s); S / A = a precomputed rolling / anchored series (backtests share them between settings)
 */
function vpPrep(B, q, ctx){
  const c = ctx || {}, n = B.length;
  const C = B.map(b => b.close), V = B.map(b => b.volume || 0), clv = B.map(VPL.vpClv);
  const atr = atrOf(B, 14);
  const v48 = new Array(n).fill(NaN); let s = 0;
  for (let i = 0; i < n; i++){ if (i >= 48){ v48[i] = s / 48; s -= V[i - 48]; } s += V[i]; }
  const S = c.S || vpSeries(B, q.window, q.stepPct, q.valuePct);
  // POC drift in % over 12 candles (1 h at 5m: balance or not) and over hvnLook candles (4 h: the trend of the value)
  const ago = q.distAgo, drift = new Array(n).fill(NaN), driftL = new Array(n).fill(NaN), L = q.hvnLook;
  for (let i = 0; i < n; i++){
    if (S[i] && i >= 12 && S[i - 12]) drift[i] = (S[i].poc / S[i - 12].poc - 1) * 100;
    if (S[i] && i >= L && S[i - L]) driftL[i] = (S[i].poc / S[i - L].poc - 1) * 100;
  }
  // S5: distribution flag per candle (same four conditions as vpDistribution, with running sums)
  const dist = new Array(n).fill(false);
  const pv = [0], pb = [0]; for (let i = 0; i < n; i++){ pv.push(pv[i] + V[i]); pb.push(pb[i] + V[i] * clv[i]); }
  for (let i = ago + 48; i < n; i++){
    const now = S[i], before = S[i - ago]; if (!now || !before) continue;
    const rv = pv[i + 1] - pv[i - ago + 1], rb = pb[i + 1] - pb[i - ago + 1];
    const ov = pv[i - ago + 1] - pv[i - ago - 47];
    const share = rv > 0 ? rb / rv : 0.5, avgNew = rv / ago, avgOld = ov / 48;
    dist[i] = (now.poc / before.poc - 1) * 100 <= -q.distDrop && share < q.distBuy && avgOld > 0 && avgNew >= q.distVolX * avgOld && C[i] < now.poc;
  }
  // pool start for S4: only usable when the data really begins at the pool start
  let created = typeof c.created === 'string' && !/^\d+$/.test(c.created) ? Date.parse(c.created) || 0 : Number(c.created) || 0;
  if (created > 1e11) created /= 1000;
  let a = -1;
  if (created && n && Math.abs(B[0].time - created) <= 3 * 3600) a = 0;
  const A = c.A !== undefined ? c.A : (a >= 0 ? vpAnchored(B, a, q.migMinBars, q.valuePct) : null);
  const liq = Number(c.liq) || 0;
  const impact = liq > 0 ? Math.min(3, 100 * q.stakeUsd / (liq / 2)) : 0.3;   // constant-product estimate, % per side
  return { B, n, C, V, clv, atr, v48, S, A, drift, driftL, dist, created, cost: c.cost != null && Number.isFinite(Number(c.cost)) ? Number(c.cost) : 1, side: (q.slip + impact) / 100, key: String(c.key || '') };
}

const no = why => ({ ok: false, why });

// ---------- S1: POC / value-area reversion ----------
/** @returns {Signal} */
function sigVaRev(i, P, q){
  const s = P.S[i], b = P.B[i];
  if (!s) return no('nog geen profiel');
  if (!(s.shape === 'D' || s.shape === 'dubbel')) return no('profiel ' + s.shape + ' (geen balans)');
  if (!(Math.abs(P.drift[i]) <= q.revDrift)) return no('POC beweegt ' + (P.drift[i] || 0).toFixed(1) + '% (geen balans)');
  if (!(b.low < s.val)) return no('niet onder VAL geweest');
  if (!(b.close > s.val)) return no('sluit niet terug boven VAL');
  if (!(b.close < s.poc)) return no('al boven POC');
  if (!(b.close > b.open)) return no('geen groene afwijzing');
  const e = b.close, room = (s.poc / e - 1) * 100;
  if (room < q.revRoom * P.cost) return no('te weinig ruimte tot POC (' + room.toFixed(1) + '%)');
  const stop = Math.min(b.low, P.B[i - 1].low) - 0.5 * P.atr[i];
  if (!(stop > 0) || (e - stop) / e * 100 > q.maxRisk) return no('stop te ver');
  return { ok: true, why: 'VAL-afwijzing → POC', stop, tps: [{ px: s.poc, frac: 0.5 }, { px: s.vah, frac: 0.5 }], be: true, time: q.revTime, max: q.revMax, lv: { val: s.val } };
}
/** S1 invalidation: two closes in a row below the VAL of the entry */
function invVaRev(j, P, pos){ return j > pos.i && P.C[j] < pos.lv.val && P.C[j - 1] < pos.lv.val; }

// ---------- S2: LVN breakout / momentum ----------
function sigLvnBrk(i, P, q){
  const s = P.S[i], b = P.B[i], pb = P.B[i - 1];
  if (!s) return no('nog geen profiel');
  if (!(pb.close <= s.vah && b.close > s.vah)) return no('geen uitbraak boven VAH');
  if (!(b.volume >= q.brkVolX * P.v48[i] && b.volume > pb.volume)) return no('geen volume-versnelling');
  if (!(P.clv[i] >= q.brkClv)) return no('kopers niet in controle (slot ' + Math.round(P.clv[i] * 100) + '%)');
  if (!(s.thinAbove <= q.brkThin)) return no('veel volume boven VAH (geen LVN)');
  if (!(P.drift[i] >= 0)) return no('POC zakt');
  if (b.close - s.vah > q.brkExt * P.atr[i]) return no('te ver doorgeschoten');
  const e = b.close, stop = Math.min(b.low, s.vah) - 0.5 * P.atr[i];
  if (!(stop > 0) || (e - stop) / e * 100 > Math.max(q.maxRisk, 12)) return no('stop te ver');
  const R = e - stop, above = s.hvn.filter(h => h > e * (1 + 2 * P.cost / 100)).sort((x, y) => x - y)[0];
  return { ok: true, why: 'LVN-uitbraak boven VAH', stop, tps: [{ px: above || e + 2 * R, frac: 0.5 }], be: true, trailAtr: q.brkTrail, trailFrom: 'tp1', time: q.brkTime, max: q.brkMax };
}

// ---------- S3: HVN support in an up-market ----------
function sigHvnSup(i, P, q){
  const s = P.S[i], b = P.B[i];
  if (!s) return no('nog geen profiel');
  if (!(P.driftL[i] >= q.hvnUp)) return no('POC stijgt niet (geen opwaarts regime)');
  if (!(b.close > s.poc)) return no('prijs onder POC');
  const h = s.hvn.filter(x => x < b.close).sort((x, y) => y - x)[0];
  if (!h) return no('geen HVN onder de prijs');
  if (!(b.low <= h * (1 + q.hvnTouch / 100))) return no('raakt de HVN niet');
  if (!(b.close > b.open && P.clv[i] >= 0.5)) return no('geen groene reactie');
  if (b.close - h > P.atr[i]) return no('te ver boven de HVN');
  const e = b.close, stop = h - Math.max(0.5 * P.atr[i], h * 0.012);
  if (!(stop > 0) || (e - stop) / e * 100 > q.maxRisk) return no('stop te ver');
  let hi = -Infinity; for (let k = Math.max(0, i - 24); k < i; k++) hi = Math.max(hi, P.B[k].high);
  const R = e - stop, tp = hi > e * (1 + 2 * P.cost / 100) ? hi : e + 1.5 * R;
  return { ok: true, why: 'bounce op HVN', stop, tps: [{ px: tp, frac: 0.5 }], be: true, trailAtr: q.hvnTrail, trailFrom: 'tp1', time: q.hvnTime, max: q.hvnMax };
}

// ---------- S4: post-migration (anchored profile) ----------
function sigPostMig(i, P, q){
  if (!P.A) return no('pool-start niet in de data');
  const b = P.B[i], age = (b.time - P.created) / 3600;
  if (age > q.migAgeH) return no('pool ouder dan ' + q.migAgeH + ' u');
  const s = P.A[i];
  if (!s) return no('te weinig candles sinds de start');
  if (!(P.B[i - 1].close <= s.vah && b.close > s.vah)) return no('geen uitbraak boven VAH (anker)');
  let vs = 0, k0 = Math.max(0, i - 48); for (let k = k0; k < i; k++) vs += P.V[k];
  if (!(b.volume >= q.migVolX * vs / Math.max(1, i - k0))) return no('geen volume-piek');
  if (!(b.close > b.open && P.clv[i] >= 0.6)) return no('kopers niet in controle');
  const back = P.C[Math.max(0, i - Math.round(3600 / q.tfSec))];
  if ((b.close / back - 1) * 100 >= q.migRun) return no('al te hard gestegen');
  const e = b.close, stop = Math.max(e * (1 - q.migSl / 100), s.poc < e * 0.97 ? s.poc * 0.98 : 0);
  return { ok: true, why: 'uitbraak na migratie', stop, tps: [], be: false, trailPct: q.migTrail, trailFrom: 'start', max: q.migMax };
}

const SIG = { vaRev: sigVaRev, lvnBrk: sigLvnBrk, hvnSup: sigHvnSup, postMig: sigPostMig };
const INV = { vaRev: invVaRev };

/** deterministic "random" 0…1 from a text (failed transactions must be the same in every run) */
function hash01(str){ let h = 2166136261; for (let k = 0; k < str.length; k++){ h ^= str.charCodeAt(k); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

/**
 * Simulate one strategy on one coin.
 * @param {string} strat 'vaRev' | 'lvnBrk' | 'hvnSup' | 'postMig'
 * @param {object} P vpPrep()
 * @param {object} q vpParams()
 * @returns {VpTrade[]}
 */
function vpSim(strat, P, q){
  const sig = SIG[strat], inv = INV[strat], B = P.B, n = P.n, C = P.C, side = P.side, out = [];
  let pos = null, cool = 0, distAt = -1e9;
  const start = Math.max(q.window, 60);
  for (let i = start; i < n; i++){
    const b = B[i];
    if (P.dist[i]) distAt = i;
    if (pos){
      if (i < pos.i) continue;
      let exitPx = null, why = '';
      const fail = k => hash01(P.key + strat + pos.t + ':' + k) < q.failPct / 100 ? 1 - q.failSellPct / 100 : 1;
      if (b.low <= pos.stop){ exitPx = Math.min(pos.stop, b.open); why = pos.tp ? 'trail/BE' : 'stop'; }
      else {
        for (const tp of pos.tps){
          if (tp.hit || !(b.high >= tp.px)) continue;
          tp.hit = true; pos.left -= tp.frac; pos.gross += tp.frac * (tp.px * (1 - side) * fail('tp' + tp.px) / pos.e - 1); pos.tp = true; pos.ex.push({ j: i, px: tp.px, frac: tp.frac });
          if (pos.be) pos.stop = Math.max(pos.stop, pos.e);
        }
        if (pos.left <= 1e-9){ out.push(close(pos, i, null, 'doelen')); pos = null; cool = i + q.cool; continue; }
        pos.hh = Math.max(pos.hh, b.high);
        if (pos.trailAtr && (pos.trailFrom === 'start' || pos.tp) && P.atr[i] > 0) pos.stop = Math.max(pos.stop, pos.hh - pos.trailAtr * P.atr[i]);
        if (pos.trailPct && (pos.trailFrom === 'start' || pos.tp)) pos.stop = Math.max(pos.stop, pos.hh * (1 - pos.trailPct / 100));
        if (q.distExit && P.dist[i]){ exitPx = C[i]; why = 'distributie'; }
        else if (inv && inv(i, P, pos)){ exitPx = C[i]; why = 'ongeldig'; }
        else if (pos.time && !pos.tp && i - pos.i >= pos.time && C[i] <= pos.e){ exitPx = C[i]; why = 'tijd'; }
        else if (i - pos.i >= pos.max){ exitPx = C[i]; why = 'max'; }
      }
      pos.hh = Math.max(pos.hh, b.high);
      if (exitPx != null){ out.push(close(pos, i, exitPx * fail('x'), why)); pos = null; cool = i + q.cool; }
      continue;
    }
    if (i < cool || i + (q.lat ? 1 : 0) >= n) continue;
    if (q.distBlock && i - distAt <= q.distAgo) continue;
    const s = sig(i, P, q);
    if (!s.ok) continue;
    const fi = q.lat ? (P.fillIdx ? P.fillIdx(i) : i + 1) : i;   // P.fillIdx: latency-honest fill (lab, 13-10b)
    if (fi < 0 || fi >= n) continue;
    const raw = q.lat ? B[fi].open : C[i], t = B[i].time;
    if (hash01(P.key + strat + t) < q.failPct / 100){
      out.push({ strat, entryTime: t, t: t + q.tfSec, fillT: B[fi].time, exitTime: t + q.tfSec, ret: -q.failFee / 100, failed: true, why: s.why, exit: 'mislukt', bars: 0, peak: 0 });
      cool = i + 1; continue;
    }
    if (!(raw > s.stop)){ continue; }   // opened below the stop: the bot would not buy
    pos = { i: fi, t, e: raw * (1 + side), stop: s.stop, tps: (s.tps || []).map(x => ({ px: x.px, frac: x.frac })), be: !!s.be, trailAtr: s.trailAtr || 0,
      trailPct: s.trailPct || 0, trailFrom: s.trailFrom || 'tp1', time: s.time || 0, max: s.max || 72, lv: s.lv || {}, left: 1, gross: 0, tp: false, hh: raw, why: s.why, ex: [] };
  }
  if (pos){ const tr = close(pos, n - 1, C[n - 1], 'open'); tr.open = true; tr.exitTime = null; out.push(tr); }
  return out;

  function close(p, j, px, why){
    const g = p.gross + (px != null ? p.left * (px * (1 - side) / p.e - 1) : 0);
    return { strat, entryTime: p.t, t: p.t + q.tfSec, fillT: B[p.i].time, exitTime: B[j].time + q.tfSec, ret: g - P.cost / 100, why: p.why, exit: why, bars: j - p.i + 1, peak: p.hh / p.e - 1,
      i: p.i, e: p.e, exits: p.ex.concat(px != null ? [{ j, px, frac: p.left }] : []) };
  }
}

/**
 * Run all switched-on strategies on one coin.
 * @param {Bar[]} B
 * @param {object} q vpParams()
 * @param {object=} ctx see vpPrep
 * @returns {{ trades: VpTrade[], P: object }}
 */
function vpRun(B, q, ctx){
  const P = vpPrep(B, q, ctx), on = String(q.on || '').split(',').map(s => s.trim()).filter(s => SIG[s]);
  const trades = []; on.forEach(s => vpSim(s, P, q).forEach(t => trades.push(t)));
  return { trades, P };
}

/**
 * Why did (or didn't) each strategy buy on candle i (default: the last one)? For the log and /vp.
 * @returns {{ strat:string, name:string, ok:boolean, why:string }[]}
 */
function vpExplain(P, q, i){
  const k = i == null ? P.n - 1 : i, on = String(q.on || '').split(',').map(s => s.trim()).filter(s => SIG[s]), out = [];
  let blocked = '';
  if (q.distBlock) for (let j = Math.max(0, k - q.distAgo); j <= k; j++) if (P.dist[j]) blocked = 'distributie-waarschuwing (geen nieuwe kopen)';
  on.forEach(s => {
    if (k < Math.max(q.window, 60)) { out.push({ strat: s, name: VP_NAMES[s], ok: false, why: 'te weinig candles' }); return; }
    const r = SIG[s](k, P, q);
    out.push({ strat: s, name: VP_NAMES[s], ok: r.ok && !blocked, why: r.ok && blocked ? blocked : r.why });
  });
  return out;
}

// ---------- metrics ----------
/**
 * @param {{ret:number, t:number, failed?:boolean}[]} trades ret as a fraction of the stake, after costs
 * @param {number=} days length of the period (for trades per day)
 */
function vpMetrics(trades, days){
  const L = trades.slice().sort((a, b) => a.t - b.t), r = L.map(x => x.ret), n = r.length;
  const wins = r.filter(x => x > 0), losses = r.filter(x => x <= 0);
  const sum = r.reduce((a, x) => a + x, 0), mean = n ? sum / n : 0;
  const gw = wins.reduce((a, x) => a + x, 0), gl = -losses.reduce((a, x) => a + x, 0);
  const sd = n > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const dsd = n > 1 ? Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / (n - 1)) : 0;
  let eq = 0, peak = 0, dd = 0; r.forEach(x => { eq += x; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); });
  return { n, failed: L.filter(x => x.failed).length, win: n ? wins.length / n : 0, exp: mean, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0, sum, maxDD: dd,
    sharpe: sd > 0 ? mean / sd : 0, sortino: dsd > 0 ? mean / dsd : 0, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, perDay: days ? n / days : null,
    best: n ? Math.max(...r) : 0, worst: n ? Math.min(...r) : 0 };
}

/**
 * Apply an exit signal (e.g. the distribution flag) to trades of ANOTHER strategy afterwards.
 * Needs per trade: entry index i, entry price e, and the exits [{ j, px, frac }] in time order.
 * The part still open at the first flagged candle after the entry is sold at that candle's close.
 * @returns {{ ret:number, cut:boolean }}
 */
function vpCutAt(flags, C, tr, side, costPct){
  const ex = tr.exits.slice().sort((a, b) => a.j - b.j), last = ex.length ? ex[ex.length - 1].j : tr.i;
  let left = 1, g = 0, k = 0;
  for (let j = tr.i; j <= last; j++){
    while (k < ex.length && ex[k].j === j){ g += ex[k].frac * (ex[k].px * (1 - side) / tr.e - 1); left -= ex[k].frac; k++; }   // stops/targets inside the candle come first
    if (left <= 1e-9) break;
    if (j > tr.i && flags[j]){ g += left * (C[j] * (1 - side) / tr.e - 1); return { ret: g - costPct / 100, cut: true, j }; }
  }
  return { ret: g - costPct / 100, cut: false };
}

if (typeof module !== 'undefined') module.exports = { VP_DEFAULTS, VP_STRATS, VP_NAMES, vpParams, vpSeries, vpAnchored, vpPrep, vpSim, vpRun, vpExplain, vpMetrics, vpCutAt, stepLadder, hash01, atrOf };
