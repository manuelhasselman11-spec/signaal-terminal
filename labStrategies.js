'use strict';
/**
 * Strategy library for the lab (13-10a) — PAPER ONLY. Every strategy works on closed 5m candles and only looks backwards
 * (index i = the candle that just closed; the fill happens at the open of i + 1 in lab.js).
 *
 * A strategy = { name, title, group, params, sig(i, P, p) }.
 *   sig returns { ok:false, why } or { ok:true, why, stop, tps:[{ px, frac }], trailAtr?, trailPct?, trailFrom?, beAt?, time?, max?, conf, volExit? }
 *   - stop: price; tps: partial take-profits (fractions of the position); trailAtr / trailPct: trailing stop;
 *   - trailFrom: 'start' | 'tp1' | '1R' (when the trailing stop switches on); beAt: 'tp1' | '1R' (stop to entry);
 *   - time: candles without a target before a "no progress" exit; max: max holding time in candles;
 *   - conf 0…1: how strong the signal is (sets the size tier together with the risk score in lab.js);
 *   - volExit: sell when selling takes over (2 red closes at the bottom of the candle on high volume while under water).
 *
 * What CANNOT be built from candles (and is therefore not here): smart-wallet signals (use /volg in the bot), holder growth,
 * dev/bundle behaviour (RugCheck gives some of that as a safety gate), social buzz. Order-flow strategies (CVD, absorption,
 * buy pressure) use a candle PROXY for buy/sell volume: where the candle closed in its range. Real buy/sell needs swaps.
 */
/** @typedef {{ ok:boolean, why:string, stop?:number, tps?:{px:number,frac:number}[], trailAtr?:number, trailPct?:number, trailFrom?:string, beAt?:string, time?:number, max?:number, conf?:number, volExit?:boolean }} LabSignal */

const no = why => ({ ok: false, why });
const okSig = (why, o) => Object.assign({ ok: true, why, tps: [], time: 0, max: 72, conf: 0.5 }, o);
const green = (P, i) => P.C[i] > P.O[i];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** stop distance check (max % below entry) */
function stopOk(e, stop, maxPct){ return stop > 0 && stop < e && (e - stop) / e * 100 <= maxPct; }
/** take-profit at entry + r × risk, but at least `minPct` % (so targets beat the round-trip costs) */
function tpR(e, stop, r, minPct){ return Math.max(e + r * (e - stop), e * (1 + (minPct || 0) / 100)); }

const S = [];

// ---------------- 7.1 volume profile (extra; POC/LVN/HVN/migration live in vpStrategies.js) ----------------
S.push({ name: 'nakedPoc', title: 'Naked POC (trekt naar onbezocht niveau)', group: 'volumeprofiel',
  params: { minGap: 3, maxGap: 15, volX: 1.5 },
  sig(i, P, p){
    if (i < 300) return no('te weinig candles');
    const np = P.nakedPoc[i];
    if (!np) return no('geen naked POC boven de prijs');
    const gap = (np / P.C[i] - 1) * 100;
    if (gap < p.minGap || gap > p.maxGap) return no('naked POC ' + gap.toFixed(1) + '% weg');
    if (!(P.C[i] > P.ema21[i] && P.ema21[i] > P.ema21[i - 3])) return no('geen opwaartse druk');
    if (!(green(P, i) && P.V[i] >= p.volX * P.med48[i])) return no('geen groene volume-candle');
    const e = P.C[i], stop = Math.min(P.L[i], P.L[i - 1]) - P.atr[i];
    if (!stopOk(e, stop, 10)) return no('stop te ver');
    return okSig('naar naked POC +' + gap.toFixed(1) + '%', { stop, tps: [{ px: np, frac: 1 }], beAt: '1R', time: 36, max: 96, conf: clamp(gap / 10, 0.3, 0.8) });
  } });
S.push({ name: 'shapeP', title: 'P-vorm: retest van de POC', group: 'volumeprofiel',
  params: { touch: 0.4 },
  sig(i, P, p){
    const s = P.vp[i];
    if (!s) return no('nog geen profiel');
    if (s.shape !== 'P') return no('profiel ' + s.shape);
    if (!(P.L[i] <= s.poc * (1 + p.touch / 100) && P.C[i] > s.poc && green(P, i))) return no('geen retest van de POC');
    const e = P.C[i], stop = s.poc - Math.max(P.atr[i], s.poc * 0.01);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('P-vorm, POC houdt', { stop, tps: [{ px: Math.max(s.vah, tpR(e, stop, 1.5, 2)), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 24, max: 72, conf: 0.5 });
  } });
S.push({ name: 'avwapReclaim', title: 'Anchored VWAP-reclaim (vanaf launch of volumepiek)', group: 'volumeprofiel',
  params: { volX: 1.5 },
  sig(i, P, p){
    const a = P.avwap[i];
    if (!a) return no('geen anker');
    if (!(P.C[i - 1] < P.avwap[i - 1] && P.C[i] > a)) return no('geen reclaim van de AVWAP');
    if (!(P.V[i] >= p.volX * P.med48[i] && P.clv[i] >= 0.6)) return no('reclaim zonder volume');
    const e = P.C[i], stop = Math.min(P.L[i], a) - 0.5 * P.atr[i];
    if (!stopOk(e, stop, 10)) return no('stop te ver');
    return okSig('AVWAP-reclaim', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 24, max: 96, conf: 0.55 });
  } });

// ---------------- 7.2 volume and order flow ----------------
S.push({ name: 'volSpike', title: 'Volume-piek uitbraak', group: 'volume',
  params: { volX: 4, look: 20 },
  sig(i, P, p){
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('geen volumepiek');
    if (!(P.C[i] > P.hiN(i, p.look) && green(P, i))) return no('geen uitbraak');
    if ((P.C[i] / P.C[i - 12] - 1) > 0.4) return no('al te ver gestegen');
    const e = P.C[i], stop = e - 2 * P.atr[i];
    if (!stopOk(e, stop, 12)) return no('stop te ver');
    return okSig('volume ' + (P.V[i] / P.med48[i]).toFixed(1) + '× + uitbraak', { stop, trailAtr: 3, trailFrom: 'start', time: 12, max: 72, conf: clamp(P.V[i] / P.med48[i] / 10, 0.4, 0.9), volExit: true });
  } });
S.push({ name: 'dryUp', title: 'Volume dry-up → expansie', group: 'volume',
  params: { dry: 0.5, volX: 2.5 },
  sig(i, P, p){
    if (i < 110) return no('te weinig candles');
    let v12 = 0; for (let k = i - 12; k < i; k++) v12 += P.V[k];
    if (!(v12 / 12 <= p.dry * P.med48[i - 12])) return no('geen droogte vooraf');
    if (!(P.atrPct[i - 1] <= P.atrPctQ25[i - 1])) return no('geen compressie');
    if (!(P.V[i] >= p.volX * P.med48[i] && P.C[i] > P.hiN(i, 12) && green(P, i))) return no('geen expansie');
    const e = P.C[i], stop = Math.min(P.loN(i, 12), e - 1.5 * P.atr[i]);
    if (!stopOk(e, stop, 10)) return no('stop te ver');
    return okSig('rust → uitbraak', { stop, tps: [{ px: tpR(e, stop, 2, 3), frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.6 });
  } });
S.push({ name: 'climax', title: 'Climax/uitputting → omkeer', group: 'volume',
  params: { volX: 6, drop: 15 },
  sig(i, P, p){
    const k = i - 1;   // the climax candle; i = confirmation
    if (!(P.V[k] >= p.volX * P.med48[k])) return no('geen climax-volume');
    if (!((1 - P.L[k] / P.H[P.argHi(k, 12)]) * 100 >= p.drop)) return no('geen flinke daling ervoor');
    if (!(P.clv[k] >= 0.4)) return no('climax sloot onderin');
    if (!(green(P, i) && P.C[i] > P.C[k])) return no('geen bevestiging');
    const e = P.C[i], stop = P.L[k] - 0.3 * P.atr[i], back = P.H[P.argHi(k, 12)];
    if (!stopOk(e, stop, 12)) return no('stop te ver');
    return okSig('verkoop-climax opgevangen', { stop, tps: [{ px: e + 0.5 * (back - e), frac: 0.6 }, { px: back, frac: 0.4 }], beAt: 'tp1', time: 12, max: 48, conf: 0.5 });
  } });
S.push({ name: 'cvdDiv', title: 'CVD-divergentie (proxy uit candles)', group: 'orderflow',
  params: { look: 24 },
  sig(i, P, p){
    const a = P.argLo(i - 3, p.look), b = i;   // earlier low vs now
    if (a < 0 || i - a < 6) return no('geen eerdere bodem');
    if (!(P.L[b] < P.L[a])) return no('geen lagere bodem');
    if (!(P.cvd[b] > P.cvd[a])) return no('CVD bevestigt de daling');
    if (!(green(P, i) && P.clv[i] >= 0.6)) return no('geen groene reactie');
    const e = P.C[i], stop = P.L[b] - 0.5 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('prijs lager, kopers sterker', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 48, conf: 0.45 });
  } });
S.push({ name: 'absorb', title: 'Absorptie (veel verkoop, prijs houdt)', group: 'orderflow',
  params: { volX: 2, hold: 1.5 },
  sig(i, P, p){
    let sellBars = 0, lo = Infinity, hi = -Infinity;
    for (let k = i - 3; k < i; k++){ if (P.clv[k] < 0.35 && P.V[k] >= p.volX * P.med48[k]) sellBars++; lo = Math.min(lo, P.L[k]); hi = Math.max(hi, P.H[k]); }
    if (sellBars < 2) return no('geen zware verkoop');
    if (!((hi / lo - 1) * 100 <= p.hold * 2)) return no('prijs gaf mee');
    if (!(green(P, i) && P.C[i] > hi)) return no('geen uitbraak na absorptie');
    const e = P.C[i], stop = lo - 0.5 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('verkoop geabsorbeerd', { stop, tps: [{ px: tpR(e, stop, 2, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: 0.5 });
  } });
S.push({ name: 'buyPress', title: 'Kopersdruk versnelt', group: 'orderflow',
  params: { share: 0.65 },
  sig(i, P, p){
    let bv = 0, tv = 0, bv0 = 0, tv0 = 0;
    for (let k = i - 5; k <= i; k++){ bv += P.V[k] * P.clv[k]; tv += P.V[k]; }
    for (let k = i - 11; k <= i - 6; k++){ bv0 += P.V[k] * P.clv[k]; tv0 += P.V[k]; }
    const s1 = tv > 0 ? bv / tv : 0, s0 = tv0 > 0 ? bv0 / tv0 : 0;
    if (!(s1 >= p.share && s1 > s0 + 0.05)) return no('kopersaandeel ' + Math.round(s1 * 100) + '%');
    if (!(tv > 1.3 * tv0)) return no('volume neemt niet toe');
    if (!(P.C[i] > P.ema21[i] && P.ema21[i] > P.ema50[i])) return no('niet boven de trend');
    const e = P.C[i], stop = Math.min(P.loN(i, 6), e - 1.5 * P.atr[i]);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('kopers ' + Math.round(s1 * 100) + '% en stijgend', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: clamp((s1 - 0.5) * 3, 0.3, 0.8), volExit: true });
  } });
S.push({ name: 'sweep', title: 'Liquidity sweep + reclaim', group: 'orderflow',
  params: { look: 24, depth: 0.5, volX: 1.5 },
  sig(i, P, p){
    const lvl = P.loN(i, p.look);
    if (!(P.L[i] < lvl * (1 - p.depth / 100))) return no('geen sweep onder de bodem');
    if (!(P.C[i] > lvl && P.clv[i] >= 0.6)) return no('geen reclaim');
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('sweep zonder volume');
    const e = P.C[i], stop = P.L[i] - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('stops onder de bodem gepakt, terug erboven', { stop, tps: [{ px: tpR(e, stop, 2, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: 0.55 });
  } });

// ---------------- 7.3 chart patterns ----------------
S.push({ name: 'engulf', title: 'Bullish engulfing met volume', group: 'patroon',
  params: { volX: 1.5 },
  sig(i, P, p){
    if (!(P.C[i - 1] < P.O[i - 1] && P.C[i - 2] < P.O[i - 2] && P.C[i - 3] < P.O[i - 3])) return no('geen 3 rode candles ervoor');
    if (!(green(P, i) && P.O[i] <= P.C[i - 1] && P.C[i] >= P.O[i - 1])) return no('geen engulfing');
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('engulfing zonder volume');
    const e = P.C[i], stop = Math.min(P.L[i], P.L[i - 1]) - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('engulfing na daling', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 36, conf: 0.45 });
  } });
S.push({ name: 'hammer', title: 'Hamer na daling met volume', group: 'patroon',
  params: { volX: 1.5, drop: 6 },
  sig(i, P, p){
    const body = Math.abs(P.C[i] - P.O[i]), low = Math.min(P.C[i], P.O[i]) - P.L[i], rng = P.H[i] - P.L[i];
    if (!(rng > 0 && low >= 2 * body && P.clv[i] >= 0.7)) return no('geen hamer');
    if (!((1 - P.C[i] / P.H[P.argHi(i - 1, 12)]) * 100 >= p.drop)) return no('geen daling ervoor');
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('hamer zonder volume');
    const e = P.C[i], stop = P.L[i] - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('hamer', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 36, conf: 0.4 });
  } });
S.push({ name: 'bosRetest', title: 'Break of structure + retest', group: 'patroon',
  params: { within: 12, touch: 0.5 },
  sig(i, P, p){
    // a confirmed swing high that was broken in the last `within` candles, and now price comes back to it and holds
    const sh = P.lastSwingHigh(i - 2);
    if (!sh) return no('geen swing high');
    let brk = -1; for (let k = Math.max(sh.k + 1, i - p.within); k < i; k++) if (P.C[k] > sh.px){ brk = k; break; }
    if (brk < 0) return no('geen doorbraak van de structuur');
    if (!(P.L[i] <= sh.px * (1 + p.touch / 100) && P.C[i] > sh.px && green(P, i))) return no('geen retest');
    const e = P.C[i], stop = sh.px - Math.max(P.atr[i], sh.px * 0.01);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('BOS-retest', { stop, tps: [{ px: tpR(e, stop, 2, 2.5), frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.55 });
  } });
S.push({ name: 'choch', title: 'Change of character (eerste hogere top na daling)', group: 'patroon',
  params: {},
  sig(i, P, p){
    const h2 = P.lastSwingHigh(i - 2), h1 = h2 && P.lastSwingHigh(h2.k - 1);
    if (!h1 || !h2) return no('te weinig swings');
    if (!(h2.px < h1.px)) return no('geen dalende toppen ervoor');
    if (!(P.C[i] > h2.px && P.C[i - 1] <= h2.px && green(P, i))) return no('geen doorbraak van de laatste lagere top');
    const sl = P.lastSwingLow(i - 2);
    const e = P.C[i], stop = (sl ? sl.px : P.loN(i, 12)) - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 10)) return no('stop te ver');
    return okSig('CHoCH', { stop, tps: [{ px: tpR(e, stop, 1.5, 3), frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.5 });
  } });
S.push({ name: 'bullFlag', title: 'Bull flag', group: 'patroon',
  params: { pole: 8, maxRetr: 0.5 },
  sig(i, P, p){
    // pole: ≥ pole% rise within 6 candles, ending 3–12 candles ago; flag: shallow pullback on lower volume; breakout now
    for (let f = 3; f <= 12; f++){
      const top = i - f; if (top < 10) break;
      const base = P.loN(top + 1, 6), poleH = P.H[top] - base;
      if (!((P.H[top] / base - 1) * 100 >= p.pole)) continue;
      let flo = Infinity, fhi = -Infinity, fv = 0, pv = 0;
      for (let k = top + 1; k < i; k++){ flo = Math.min(flo, P.L[k]); fhi = Math.max(fhi, P.H[k]); fv += P.V[k]; }
      for (let k = top - 5; k <= top; k++) pv += P.V[k];
      if (!(P.H[top] - flo <= p.maxRetr * poleH)) continue;
      if (!(fv / (i - top - 1 || 1) < pv / 6)) continue;
      if (!(P.C[i] > Math.max(fhi, P.H[top] * 0.995) && green(P, i))) return no('vlag, nog geen uitbraak');
      const e = P.C[i], stop = flo - 0.3 * P.atr[i];
      if (!stopOk(e, stop, 12)) return no('stop te ver');
      return okSig('bull flag (paal +' + ((P.H[top] / base - 1) * 100).toFixed(0) + '%)', { stop, tps: [{ px: e + poleH * 0.6, frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: 0.6 });
    }
    return no('geen vlag');
  } });
S.push({ name: 'rangeBreak', title: 'Range-uitbraak', group: 'patroon',
  params: { look: 24, width: 6, volX: 2 },
  sig(i, P, p){
    const hi = P.hiN(i, p.look), lo = P.loN(i, p.look);
    if (!((hi / lo - 1) * 100 <= p.width)) return no('geen nauwe range');
    if (!(P.C[i] > hi && green(P, i) && P.V[i] >= p.volX * P.med48[i])) return no('geen uitbraak met volume');
    const e = P.C[i], stop = Math.max(lo, hi - 1.5 * P.atr[i]) - 0.2 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('uit de range', { stop, tps: [{ px: Math.max(e + (hi - lo), e * 1.025), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: 0.55 });
  } });
S.push({ name: 'doubleBottom', title: 'Dubbele bodem', group: 'patroon',
  params: { tol: 1.5, peak: 4 },
  sig(i, P, p){
    const b2 = P.lastSwingLow(i - 2), b1 = b2 && P.lastSwingLow(b2.k - 1);
    if (!b1 || !b2 || b2.k - b1.k < 6) return no('geen twee bodems');
    if (!(Math.abs(b2.px / b1.px - 1) * 100 <= p.tol)) return no('bodems niet gelijk');
    let neck = -Infinity; for (let k = b1.k; k <= b2.k; k++) neck = Math.max(neck, P.H[k]);
    if (!((neck / Math.max(b1.px, b2.px) - 1) * 100 >= p.peak)) return no('geen top ertussen');
    if (!(P.C[i] > neck && P.C[i - 1] <= neck && green(P, i))) return no('nekschouder niet doorbroken');
    const e = P.C[i], stop = Math.min(b1.px, b2.px) - 0.3 * P.atr[i];
    const st = stopOk(e, stop, 12) ? stop : e - 2 * P.atr[i];
    return okSig('dubbele bodem', { stop: st, tps: [{ px: neck + (neck - Math.min(b1.px, b2.px)), frac: 0.5 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.55 });
  } });
S.push({ name: 'squeeze', title: 'Bollinger-squeeze uitbraak', group: 'patroon',
  params: { q: 0.15 },
  sig(i, P, p){
    if (!(P.bbW[i - 1] <= P.bbWq[i - 1] && P.bbUp[i - 1] < P.kcUp[i - 1])) return no('geen squeeze');
    if (!(P.C[i] > P.bbUp[i] && green(P, i))) return no('geen uitbraak uit de squeeze');
    const e = P.C[i], stop = Math.min(P.bbMid[i], e - 1.5 * P.atr[i]);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('squeeze → uitbraak', { stop, trailAtr: 2.5, trailFrom: 'start', time: 12, max: 48, conf: 0.5 });
  } });
S.push({ name: 'emaCross', title: 'EMA 9/21-kruis met trend en volume', group: 'indicator',
  params: { volX: 1.3 },
  sig(i, P, p){
    if (!(P.ema9[i] > P.ema21[i] && P.ema9[i - 1] <= P.ema21[i - 1])) return no('geen kruis');
    if (!(P.ema50[i] > P.ema50[i - 6] && P.C[i] > P.ema50[i])) return no('geen stijgende trend');
    if (!(P.rsi[i] >= 50 && P.rsi[i] <= 70)) return no('RSI ' + Math.round(P.rsi[i]));
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('kruis zonder volume');
    const e = P.C[i], stop = Math.min(P.loN(i, 6), e - 1.5 * P.atr[i]);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('EMA 9/21 omhoog', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.45 });
  } });
S.push({ name: 'rsiDiv', title: 'RSI-divergentie', group: 'indicator',
  params: { os: 35 },
  sig(i, P, p){
    const b2 = P.lastSwingLow(i - 2), b1 = b2 && P.lastSwingLow(b2.k - 1);
    if (!b1 || !b2 || b2.k - b1.k < 5 || i - b2.k > 6) return no('geen twee bodems');
    if (!(b2.px < b1.px && P.rsi[b2.k] > P.rsi[b1.k] && P.rsi[b1.k] <= p.os)) return no('geen divergentie');
    if (!(green(P, i) && P.C[i] > P.H[b2.k])) return no('geen bevestiging');
    const e = P.C[i], stop = b2.px - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('RSI-divergentie', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 48, conf: 0.45 });
  } });
S.push({ name: 'vwapReclaim', title: 'VWAP-reclaim (24 u)', group: 'indicator',
  params: { volX: 1.5 },
  sig(i, P, p){
    const w = P.vwap[i];
    if (!w) return no('geen VWAP');
    if (!(P.C[i - 1] < P.vwap[i - 1] && P.C[i] > w && green(P, i))) return no('geen reclaim');
    if (!(P.V[i] >= p.volX * P.med48[i])) return no('reclaim zonder volume');
    const e = P.C[i], stop = Math.min(P.L[i], w) - 0.5 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('VWAP terug', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.45 });
  } });
S.push({ name: 'dipBuy', title: 'Dip kopen in een stijgende trend', group: 'indicator',
  params: { touch: 0.3 },
  sig(i, P, p){
    if (!(P.ema21[i] > P.ema50[i] && P.ema50[i] > P.ema50[i - 12] && P.C[i] > P.ema50[i])) return no('geen stijgende trend');
    if (!(P.L[i] <= P.ema21[i] * (1 + p.touch / 100) && P.C[i] > P.ema21[i] && green(P, i))) return no('geen tik op EMA21');
    if (!(P.V[i - 1] < P.V[i - 2] && P.V[i - 2] < P.V[i - 3])) return no('verkoopvolume daalt niet');
    const e = P.C[i], stop = Math.min(P.L[i], P.ema50[i]) - 0.5 * P.atr[i];
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('dip op EMA21', { stop, tps: [{ px: Math.max(P.hiN(i, 24), tpR(e, stop, 1.5, 2.5)), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 18, max: 72, conf: 0.5 });
  } });
S.push({ name: 'fib', title: 'Fibonacci-pullback (0,5–0,618)', group: 'indicator',
  params: { swing: 10 },
  sig(i, P, p){
    const hk = P.argHi(i - 1, 24), lk = P.argLo(hk - 1, 24);
    if (hk < 0 || lk < 0) return no('geen swing');
    const hi = P.H[hk], lo = P.L[lk];
    if (!((hi / lo - 1) * 100 >= p.swing)) return no('swing te klein');
    const f5 = hi - 0.5 * (hi - lo), f6 = hi - 0.618 * (hi - lo);
    if (!(P.L[i] <= f5 && P.L[i] >= f6 * 0.995 && green(P, i) && P.clv[i] >= 0.6)) return no('niet in de 0,5–0,618-zone');
    const e = P.C[i], stop = hi - 0.786 * (hi - lo);
    if (!stopOk(e, stop, 12)) return no('stop te ver');
    return okSig('fib-zone houdt', { stop, tps: [{ px: hi, frac: 0.6 }], trailAtr: 2.5, trailFrom: 'tp1', beAt: 'tp1', time: 24, max: 72, conf: 0.5 });
  } });

// ---------------- 7.4 meme-specific (from candles only) ----------------
S.push({ name: 'migSnipe', title: 'Migratie-snipe (pool < 2 u)', group: 'meme',
  params: { ageH: 2, volX: 1.5 },
  sig(i, P, p){
    if (P.age[i] == null) return no('pool-start onbekend');
    if (P.age[i] > p.ageH) return no('pool ouder dan ' + p.ageH + ' u');
    if (i < 3) return no('te vroeg');
    let v = 0; for (let k = 0; k < i; k++) v += P.V[k];
    if (!(green(P, i) && P.V[i] >= p.volX * v / i && P.clv[i] >= 0.6)) return no('geen groene volume-candle');
    const e = P.C[i], stop = e * 0.85;
    return okSig('jonge pool, kopers', { stop, trailPct: 15, trailFrom: 'start', time: 6, max: 24, conf: 0.3 });
  } });
S.push({ name: 'earlyMom', title: 'Vroeg momentum (pool < 6 u)', group: 'meme',
  params: { ageH: 6 },
  sig(i, P, p){
    if (P.age[i] == null || P.age[i] > p.ageH) return no('geen jonge pool');
    if (!(P.V[i] > P.V[i - 1] && P.V[i - 1] > P.V[i - 2] && green(P, i) && green(P, i - 1))) return no('geen versnelling');
    let top = -Infinity; for (let k = 0; k < i; k++) top = Math.max(top, P.H[k]);
    if (!(P.C[i] > top)) return no('geen nieuwe top sinds de start');
    const e = P.C[i], stop = e * 0.8;
    return okSig('nieuwe top + versnelling', { stop, trailPct: 25, trailFrom: 'start', time: 12, max: 72, conf: 0.35 });
  } });
S.push({ name: 'revival', title: 'Revival / tweede golf', group: 'meme',
  params: { drop: 50, volX: 3 },
  sig(i, P, p){
    if (i < 288) return no('te weinig historie');
    const top = P.H[P.argHi(i - 1, Math.min(i - 1, 864))];
    if (!((1 - P.C[i] / top) * 100 >= p.drop)) return no('niet ver genoeg gedaald');
    if (!(P.atrPct[i - 1] <= P.atrPctQ25[i - 1])) return no('nog onrustig');
    if (!(P.V[i] >= p.volX * P.med48[i] && P.C[i] > P.hiN(i, 24) && green(P, i))) return no('geen nieuwe volumegolf');
    const e = P.C[i], stop = Math.min(P.loN(i, 24), e - 2 * P.atr[i]);
    if (!stopOk(e, stop, 15)) return no('stop te ver');
    return okSig('tweede golf', { stop, trailPct: 20, trailFrom: '1R', beAt: '1R', time: 24, max: 144, conf: 0.4 });
  } });
S.push({ name: 'flushRev', title: 'Terugveren na een flush', group: 'meme',
  params: { drop: 10, back: 0.4 },
  sig(i, P, p){
    const pre = P.H[P.argHi(i - 1, 4)], lo = Math.min(P.L[i - 1], P.L[i - 2], P.L[i - 3]);
    const dd = (1 - lo / pre) * 100;
    if (!(dd >= p.drop)) return no('geen flush');
    if (!(green(P, i) && P.C[i] >= lo + p.back * (pre - lo) && P.V[i] >= P.med48[i])) return no('geen herstel op volume');
    const e = P.C[i], stop = lo - 0.3 * P.atr[i];
    if (!stopOk(e, stop, 15)) return no('stop te ver');
    return okSig('flush −' + dd.toFixed(0) + '% opgevangen', { stop, tps: [{ px: pre, frac: 0.6 }], beAt: '1R', time: 12, max: 36, conf: 0.4 });
  } });

// ---------------- real order flow (needs swaps: GeckoTerminal /trades; without them these never trade) ----------------
const flowOk = (P, a, b) => P.flow && P.flow.has[a] && P.flow.has[b];
S.push({ name: 'flowPress', title: 'Echte kopersdruk (swaps)', group: 'orderflow-echt',
  params: { share: 0.62 },
  sig(i, P, p){
    if (!flowOk(P, i - 5, i)) return no('geen swap-data');
    const F = P.flow, sum = (a, b, arr) => { let x = 0; for (let k = a; k <= b; k++) x += arr[k]; return x; };
    const b1 = sum(i - 2, i, F.buy), s1 = sum(i - 2, i, F.sell), b0 = sum(i - 5, i - 3, F.buy), s0 = sum(i - 5, i - 3, F.sell);
    const sh = b1 + s1 > 0 ? b1 / (b1 + s1) : 0;
    if (!(sh >= p.share)) return no('echte kopers ' + Math.round(sh * 100) + '%');
    if (!(b1 + s1 >= 1.3 * (b0 + s0))) return no('volume versnelt niet');
    if (!(sum(i - 2, i, F.buyers) > sum(i - 5, i - 3, F.buyers))) return no('niet meer kopers dan ervoor');
    if (sum(i - 2, i, F.bigSell) > 0.3 * b1) return no('walvissen verkopen');
    if (!(P.C[i] > P.ema21[i])) return no('onder EMA21');
    const e = P.C[i], stop = Math.min(P.loN(i, 6), e - 1.5 * P.atr[i]);
    if (!stopOk(e, stop, 8)) return no('stop te ver');
    return okSig('echte kopers ' + Math.round(sh * 100) + '%, meer wallets', { stop, tps: [{ px: tpR(e, stop, 1.5, 2.5), frac: 0.5 }], trailAtr: 2, trailFrom: 'tp1', beAt: 'tp1', time: 12, max: 48, conf: 0.55, volExit: true });
  } });
S.push({ name: 'flowBuyers', title: 'Groei unieke kopers (swaps)', group: 'orderflow-echt',
  params: { growth: 2, min: 15 },
  sig(i, P, p){
    if (!flowOk(P, i - 11, i)) return no('geen swap-data');
    const F = P.flow; let u1 = 0, u0 = 0, b = 0, s = 0;
    for (let k = i - 5; k <= i; k++){ u1 += F.buyers[k]; b += F.buy[k]; s += F.sell[k]; }
    for (let k = i - 11; k <= i - 6; k++) u0 += F.buyers[k];
    if (!(u1 >= p.min && u1 >= p.growth * Math.max(1, u0))) return no('kopers ' + u0 + ' → ' + u1);
    if (!(b / Math.max(1e-9, b + s) >= 0.55)) return no('meer verkoop dan koop');
    if (!(P.C[i] > P.hiN(i, 6) && P.C[i] > P.O[i])) return no('geen nieuwe top');
    const e = P.C[i], stop = Math.min(P.loN(i, 6), e - 2 * P.atr[i]);
    if (!stopOk(e, stop, 12)) return no('stop te ver');
    return okSig('kopers ' + u0 + ' → ' + u1, { stop, trailAtr: 2.5, trailFrom: 'start', time: 12, max: 72, conf: 0.5, volExit: true });
  } });

const LAB_STRATS = S;
const LAB_BY_NAME = Object.fromEntries(S.map(s => [s.name, s]));
if (typeof module !== 'undefined') module.exports = { LAB_STRATS, LAB_BY_NAME, stopOk, tpR };
