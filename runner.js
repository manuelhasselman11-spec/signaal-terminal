/**
 * Runner strategy (12-10b, PRACTICE ONLY): catch big runs instead of small moves.
 * Buy when a candle closes above the high of the last LOOK hours on a volume spike, in an up-trend, but not after the coin
 * already ran more than MAX_RUN in the last hour. No fixed take-profit: a trailing stop (TRAIL below the highest price)
 * lets winners run; a hard stop (SL) caps a miss; max holding time 24 h.
 * Most trades lose a little, a few big winners must pay for them — that is the nature of this strategy.
 * Backtest 43 coins / 10 days (5m): +1,9 % per trade, but only 2 of 4 time blocks positive → NOT proven, therefore paper only.
 */
function runnerParams(tfSec, env){
  const n = (k, f) => { const v = Number(env && env[k]); return env && env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : f; };
  const per = h => Math.max(2, Math.round(h * 3600 / tfSec));
  return { look: per(n('RUNNER_LOOK_H', 12)), vol: n('RUNNER_VOL', 5), trail: n('RUNNER_TRAIL', 0.4), sl: n('RUNNER_SL', 0.15), maxRun: n('RUNNER_MAX_RUN', 0.3),
    runBars: per(1), maxBars: per(24), volBars: per(4), cool: per(0.5), trendLen: 50, slip: n('RUNNER_SLIP', 0.5) / 100 };
}
/** trades: [{ entryTime, exitTime, ret, peak, open }] — ret is after cost (costPct = round trip in %) */
function runnerTrades(bars, q, costPct){
  const n = bars.length, C = bars.map(b => b.close), V = bars.map(b => b.volume || 0), out = [];
  if (n < Math.max(q.look, q.volBars, q.trendLen) + 10) return out;
  const k = 2 / (q.trendLen + 1), e = [C[0]];
  for (let i = 1; i < n; i++) e.push(C[i] * k + e[i - 1] * (1 - k));
  let pos = null, coolUntil = 0;
  for (let i = Math.max(q.look, q.volBars, q.trendLen, q.runBars, 6); i < n; i++){
    const b = bars[i];
    if (pos){
      if (i < pos.fi) continue;                          // honest fill (lab): the position exists from its fill candle on
      pos.peak = Math.max(pos.peak, b.high);
      const stopPx = Math.max(pos.stop, pos.peak * (1 - q.trail));
      let exit = null;
      if (b.low <= stopPx) exit = Math.min(stopPx, b.open);
      else if (i - pos.i >= q.maxBars) exit = C[i];
      if (exit != null){
        out.push(Object.assign({ entryTime: pos.t, exitTime: b.time, ret: exit * (1 - q.slip) / pos.e - 1 - costPct / 100, peak: pos.peak / pos.e - 1 }, pos.fillT != null ? { fillT: pos.fillT, e: pos.e } : {}));
        pos = null; coolUntil = i + q.cool;
      }
      continue;
    }
    if (i < coolUntil) continue;
    let hi = -Infinity; for (let j = i - q.look; j < i; j++) hi = Math.max(hi, bars[j].high);
    let vs = 0; for (let j = i - q.volBars; j < i; j++) vs += V[j];
    if (!(C[i] > hi && C[i] > b.open)) continue;
    if (!(vs > 0 && V[i] >= q.vol * vs / q.volBars)) continue;
    if (!(C[i] > e[i] && e[i] > e[i - 6])) continue;
    if (C[i] / C[i - q.runBars] - 1 >= q.maxRun) continue;
    const entry = C[i] * (1 + q.slip);
    if (q.fillIdx){                                      // lab, 13-10b: filled at the open of the candle forming at the look that saw it
      const fi = q.fillIdx(i); if (fi < 0 || fi >= n) continue;
      const e2 = bars[fi].open * (1 + q.slip);
      pos = { i, fi, t: b.time, fillT: bars[fi].time, e: e2, stop: e2 * (1 - q.sl), peak: bars[fi].open };
      continue;
    }
    pos = { i, fi: i + 1, t: b.time, e: entry, stop: entry * (1 - q.sl), peak: b.high };
  }
  if (pos) out.push(Object.assign({ entryTime: pos.t, exitTime: null, ret: C[n - 1] * (1 - q.slip) / pos.e - 1 - costPct / 100, peak: pos.peak / pos.e - 1, open: true }, pos.fillT != null ? { fillT: pos.fillT, e: pos.e } : {}));
  return out;
}
module.exports = { runnerParams, runnerTrades };
