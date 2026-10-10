/**
 * Chart-patronen herkennen (alleen met candles tot en met nu — nooit vooruit kijken).
 * Dezelfde code staat in de website (index.html), zodat chart, oefen-trades en de bot hetzelfde zien.
 *
 * Positieve patronen:  trend_omhoog, hogere_bodems, dip_in_trend, squeeze_uitbraak, bull_flag, dubbele_bodem, volume_piek
 * Waarschuwing:        te_ver_gestegen (koop niet na een te grote sprint), dalende_trend
 */
'use strict';
const PATTERN_NAMES = {
  trend_omhoog: 'trend omhoog', hogere_bodems: 'hogere bodems', dip_in_trend: 'dip in trend', squeeze_uitbraak: 'uitbraak na rust',
  bull_flag: 'bull flag', dubbele_bodem: 'dubbele bodem', volume_piek: 'volume-piek', te_ver_gestegen: 'te ver gestegen', dalende_trend: 'dalende trend',
};
const PATTERN_BAD = ['te_ver_gestegen', 'dalende_trend'];
const patCache = new WeakMap();
function patPrep(bars){
  let c = patCache.get(bars);
  if (c) return c;
  const n = bars.length, C = bars.map(b => b.close), H = bars.map(b => b.high), L = bars.map(b => b.low), V = bars.map(b => b.volume || 0);
  const ema = len => { const k = 2 / (len + 1), out = new Array(n); out[0] = C[0]; for (let i = 1; i < n; i++) out[i] = C[i] * k + out[i - 1] * (1 - k); return out; };
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - C[i - 1]), Math.abs(b.low - C[i - 1])) : b.high - b.low);
  const atr = new Array(n); let s = 0;
  for (let i = 0; i < n; i++){ s += tr[i]; if (i >= 14) s -= tr[i - 14]; atr[i] = s / Math.min(i + 1, 14); }
  // pivot lows: lower than 2 candles on each side (only known 2 candles later — used with that delay)
  const piv = [];
  for (let i = 2; i < n - 2; i++) if (L[i] < L[i - 1] && L[i] < L[i - 2] && L[i] <= L[i + 1] && L[i] <= L[i + 2]) piv.push(i);
  c = { n, C, H, L, V, e20: ema(20), e50: ema(50), atr, piv };
  patCache.set(bars, c);
  return c;
}
/** patterns present on candle i (that candle is closed) */
function patternsAt(bars, i){
  const d = patPrep(bars), { C, H, L, V, e20, e50, atr } = d, out = [];
  if (i < 60 || i >= d.n) return out;
  const green = C[i] > bars[i].open;
  const up = e20[i] > e50[i] && e50[i] > e50[i - 5];
  if (up) out.push('trend_omhoog');
  if (e20[i] < e50[i] && e50[i] < e50[i - 5]) out.push('dalende_trend');
  // swing lows that are already confirmed at i (pivot + 2 candles)
  const lows = d.piv.filter(k => k + 2 <= i && k >= i - 40).slice(-3);
  if (lows.length === 3 && L[lows[0]] < L[lows[1]] && L[lows[1]] < L[lows[2]]) out.push('hogere_bodems');
  if (up && green && L[i] <= e20[i] + 0.5 * atr[i] && C[i] > e20[i]) out.push('dip_in_trend');
  // quiet range (narrow compared with the 100 candles before), then a close above it
  let hi20 = -Infinity, lo20 = Infinity;
  for (let k = i - 20; k < i; k++){ hi20 = Math.max(hi20, H[k]); lo20 = Math.min(lo20, L[k]); }
  const w = (hi20 - lo20) / C[i - 1];
  const widths = [];
  for (let k = Math.max(20, i - 100); k < i - 20; k += 5){ let a = -Infinity, b = Infinity; for (let j = k - 20; j < k; j++){ a = Math.max(a, H[j]); b = Math.min(b, L[j]); } widths.push((a - b) / C[k - 1]); }
  widths.sort((x, y) => x - y);
  if (widths.length >= 5 && w < widths[Math.floor(widths.length / 2)] * 0.7 && C[i] > hi20) out.push('squeeze_uitbraak');
  // bull flag: strong push up, small calm pullback, then a break above the flag
  for (let k = i - 12; k <= i - 3; k++){
    if (k < 8) continue;
    const base = Math.min(L[k - 6], L[k - 5], L[k - 4], L[k - 3]);
    const push = H[k] / base - 1;
    if (push < 4 * atr[k] / C[k] || push < 0.04) continue;
    let fl = Infinity, fh = -Infinity, fv = 0, pv = 0;
    for (let j = k + 1; j < i; j++){ fl = Math.min(fl, L[j]); fh = Math.max(fh, H[j]); fv += V[j]; }
    for (let j = k - 5; j <= k; j++) pv += V[j];
    const retrace = (H[k] - fl) / (H[k] - base);
    if (retrace > 0 && retrace < 0.5 && fv / Math.max(1, i - k - 1) <= pv / 6 && C[i] > fh){ out.push('bull_flag'); break; }
  }
  // double bottom: two lows at about the same level, a bounce between them, now back above the bounce top
  const pl = d.piv.filter(k => k + 2 <= i && k >= i - 50);
  for (let a = 0; a < pl.length - 1 && !out.includes('dubbele_bodem'); a++){
    for (let b = a + 1; b < pl.length; b++){
      const x = pl[a], y = pl[b];
      if (y - x < 5 || i - y > 12) continue;
      if (Math.abs(L[y] / L[x] - 1) > 0.015) continue;
      let neck = -Infinity; for (let j = x; j <= y; j++) neck = Math.max(neck, H[j]);
      if (neck / Math.max(L[x], L[y]) - 1 < 0.03) continue;
      if (C[i] > neck && C[i - 1] <= neck){ out.push('dubbele_bodem'); break; }
    }
  }
  let va = 0; for (let k = i - 20; k < i; k++) va += V[k];
  if (va > 0 && green && V[i] > 2.5 * va / 20) out.push('volume_piek');
  if (C[i] > e20[i] + 4 * atr[i] || C[i] / C[Math.max(0, i - 6)] - 1 > Math.max(0.25, 10 * atr[i] / C[i])) out.push('te_ver_gestegen');
  return out;
}
/**
 * SOL-marktfilter: memecoins dalen bijna altijd mee als SOL zakt.
 * Uit SOL-uurcandles maakt dit een functie (tijd in seconden) → true = kopen mag, false = SOL zit in een 1-uurs-daaltrend.
 * Alleen uren die op dat moment al afgesloten waren tellen (nooit vooruit kijken). Onbekend = kopen mag.
 */
function marketFilterFrom(hourBars){
  if (!hourBars || hourBars.length < 25) return null;
  const times = hourBars.map(b => b.time), C = hourBars.map(b => b.close), k = 2 / 21, e = [C[0]];
  for (let i = 1; i < C.length; i++) e.push(C[i] * k + e[i - 1] * (1 - k));
  const fn = t => {
    let lo = 0, hi = times.length - 1, j = -1;
    while (lo <= hi){ const m = (lo + hi) >> 1; if (times[m] + 3600 <= t){ j = m; lo = m + 1; } else hi = m - 1; }
    if (j < 23) return true;
    return !(C[j] < e[j] && e[j] < e[j - 3]);
  };
  fn.trendAt = t => fn(t) ? 'omhoog / zijwaarts' : 'omlaag';
  return fn;
}
/** simple quality score: good patterns +1, warnings -2 */
function patternScore(list){ return (list || []).reduce((s, p) => s + (PATTERN_BAD.includes(p) ? -2 : 1), 0); }

if (typeof module !== 'undefined') module.exports = { patternsAt, patternScore, marketFilterFrom, PATTERN_NAMES, PATTERN_BAD };
