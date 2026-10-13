'use strict';
/**
 * Lab in the bot (13-10a) — PAPER ONLY. Runs all lab strategies on every practice coin, forward only, through the cage (§3.1).
 *
 *  - every strategy is an "agent" with its own score, its own budget (bandit, Thompson sampling) and a decision
 *    (DOORGAAN / BIJSTUREN / PAUZEREN / STOPPEN) on rolling windows;
 *  - a signal the cage does not allow (max positions, exposure, coin, loss per hour/day/week, agent pause, budget)
 *    is followed as a SHADOW trade with its skip reason, so we learn which filters save money and which block profit (§3.5);
 *  - outliers: PULL (above Q3 + 3×IQR of the strategy's earlier trades) and RUG? (−80 % within 30 min — a proxy, no LP data);
 *  - an hourly report (Telegram text + a CSV with EVERY trade of that hour) and /lab on request.
 *
 * Nothing here can send a transaction; it never imports liveTrade.js.
 *
 * Railway variables (defaults in brackets):
 *  LAB_PRACTICE (1)        0 = off
 *  LAB_ON ()               comma list of strategy names; empty = all 27
 *  LAB_REPORT_H (1)        hourly report every N hours (0 = only /lab)
 *  LAB_COST_PCT (1)        cost guess (% per round trip, route + pool fees) for a coin whose Jupiter round trip is not measured yet;
 *                          LAB_JUP_COST (1) measures it per coin (2 read-only quotes, every 6 h). Fixed SOL fees are counted separately, once.
 *  MAX_ROUND_TRIP_PCT (8)  coins dearer than this are skipped (the live bot refuses them too)
 *  LAB_FLOW_COINS (0)      fetch real swaps for the N most liquid practice coins (order-flow agents); each costs 1 extra
 *                          GeckoTerminal call per round, so keep it small (e.g. 5)
 *  LAB_CAPITAL_SOL (1)     paper capital; tier A = 8 % of it (= 0.08 SOL, the real stake)
 *  LAB_HONEST_FILL (1)     13-10b: a signal is filled at the FIRST LOOK after its candle closed, at the open of the candle forming then
 *                          (0 = old behaviour: the open of the next candle, which can be a whole look-interval in the past)
 *  cage (only the owner changes these): LAB_MAX_OPEN (8) LAB_MAX_EXP_PCT (40) LAB_COIN_MAX_PCT (8) LAB_RISK_PCT (1.5)
 *                                       LAB_HOUR_LOSS_PCT (4) LAB_DAY_LOSS_PCT (8) LAB_WEEK_LOSS_PCT (15)
 */
const LAB = require('./lab');

const FEE_SOL = LAB.LAB_DEFAULTS.feeSol;   // network + priority fees of one round trip
const emptyStat = () => ({ n: 0, wins: 0, pnl: 0, gw: 0, gl: 0, sumR: 0 });
function add(s, pnl, ret){ s.n++; s.pnl += pnl; s.sumR += ret; if (pnl > 0){ s.wins++; s.gw += pnl; } else s.gl -= pnl; }

/**
 * @param {{ env?:object, now?:()=>number, tfSec?:number, cost?:()=>number, solEur?:()=>number|null, solUsd?:()=>number|null }} o
 */
function createLabTrack(o){
  const env = o.env || process.env, now = o.now || (() => Date.now()), tf = o.tfSec || 300;
  const num = (k, d) => { const v = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : d; };
  const cfg = {
    on: !['0', 'false'].includes(String(env.LAB_PRACTICE || '1').toLowerCase()),
    names: String(env.LAB_ON || '').trim(),
    reportH: Math.max(0, num('LAB_REPORT_H', 1)),
    maxRoundTrip: num('MAX_ROUND_TRIP_PCT', 8),   // same refusal as the live bot
    honest: !['0', 'false'].includes(String(env.LAB_HONEST_FILL || '1').toLowerCase()),   // 13-10b: fill at the look that saw the signal
    q: { tfSec: tf, capital: num('LAB_CAPITAL_SOL', 1), maxOpen: num('LAB_MAX_OPEN', 8), maxExpPct: num('LAB_MAX_EXP_PCT', 40), coinMaxPct: num('LAB_COIN_MAX_PCT', 8),
      riskPct: num('LAB_RISK_PCT', 1.5), hourLossPct: num('LAB_HOUR_LOSS_PCT', 4), dayLossPct: num('LAB_DAY_LOSS_PCT', 8), weekLossPct: num('LAB_WEEK_LOSS_PCT', 15),
      vp: 0, runner: 0 }   // volume profile and runner have their own practice tracks (/vp, /oefen)
  };
  cfg.q.on = cfg.names;
  const fresh = () => ({ stats: {}, shadow: {}, res: {}, pos: {}, closed: [], skip: {}, done: [], decision: {}, alloc: {}, why: {}, signals: 0, attempts: 0, failed: 0,
    hourStart: now(), reportedAt: now(), startedAt: now() });
  let st = fresh();
  const doneSet = () => new Set(st.done);
  let done = doneSet();

  // ---------- the cage, live (same rules as lab.portfolio) ----------
  // The cage is judged at the TRADE's own time (not the wall clock): a coin is looked at every few minutes to hours and its new
  // candles are replayed, so "lost in the last hour" means: before that signal. Coins are replayed one after the other, so a
  // trade can be judged AFTER trades that started later on other coins; to never break "max 8 open", every taken position that is
  // still open at or after T counts (also those that started after T) — a little strict, never too loose.
  const openAt = T => Object.values(st.pos).filter(p => p.admit)
    .concat(st.closed.filter(c => c.taken && c.exitTime > T).map(c => ({ strat: c.strat, coin: c.mint, size: c.size })));
  const lossSince = (fromSec, toSec) => -st.closed.filter(c => c.taken && c.exitTime > fromSec && (toSec == null || c.exitTime <= toSec)).reduce((a, c) => a + c.pnlSol, 0);
  function admit(t, coin){
    const q = cfg.q, cap = q.capital, T = t.t, open = openAt(T), nowS = T;
    const exp = open.reduce((a, p) => a + p.size, 0), agExp = open.filter(p => p.strat === t.strat).reduce((a, p) => a + p.size, 0);
    const d = st.decision[t.strat];
    if (d === 'PAUZEREN' || d === 'STOPPEN') return 'agent ' + d.toLowerCase() + ' (besluit)';
    if (open.length >= q.maxOpen) return 'max ' + q.maxOpen + ' posities';
    if (exp + t.size > cap * q.maxExpPct / 100 + 1e-9) return 'max blootstelling ' + q.maxExpPct + '%';
    if (open.some(p => p.coin === coin)) return 'al in deze coin';
    const al = st.alloc[t.strat];
    if (al != null && agExp + t.size > al * cap * q.maxExpPct / 100 + 1e-9) return 'budget van deze agent op';
    const ag = st.agent && st.agent[t.strat];
    if (ag && ag.pauseUntil > nowS && nowS >= (ag.pauseFrom || 0)) return 'agent-pauze na 5 verliezen';
    if (lossSince(nowS - 3600, nowS) >= cap * q.hourLossPct / 100) return 'uurverlies ≥ ' + q.hourLossPct + '%';
    if (lossSince(nowS - 86400, nowS) >= cap * q.dayLossPct / 100) return 'dagverlies ≥ ' + q.dayLossPct + '%';
    if (lossSince(nowS - 7 * 86400, nowS) >= cap * q.weekLossPct / 100) return 'weekverlies ≥ ' + q.weekLossPct + '%';
    if (t.size > 0 && FEE_SOL / t.size > 0.04) return 'te klein: vaste kosten > 4%';
    return null;
  }

  /**
   * One coin, one round (called by the practice mode after it fetched the candles).
   * @param {{ mint:string, symbol:string, liq:number, created?:any, bars:object[], formingTime:number, fwdFrom:number }} c
   * @returns {number} closed lab trades (taken + shadow) this call
   */
  /** paper positions on a coin that is no longer followed (rotated out by the practice mode) would block the cage forever:
   *  after 6 h without new candles they are dropped and counted as "verlopen" (no win, no loss) */
  function expire(){
    const lim = now() - 6 * 3600000; st.fedAt = st.fedAt || {};
    for (const [k, p] of Object.entries(st.pos)){
      const fed = st.fedAt[p.coin] || p.t * 1000;
      if (fed < lim){ delete st.pos[k]; st.expired = (st.expired || 0) + 1; if (!done.has(k)){ done.add(k); st.done.push(k); } }
    }
    for (const m of barStore.keys()) if (!(st.fedAt[m] >= lim)) barStore.delete(m);
    // per-coin notes of coins not seen for a day are forgotten (practice coins rotate: otherwise these maps grow forever)
    const day = now() - 86400000;
    for (const m of Object.keys(st.fedAt)) if (st.fedAt[m] < day && !Object.values(st.pos).some(p => p.coin === m)){
      delete st.fedAt[m]; ['jup', 'whySeen', 'lastForming', 'tooDear', 'looks'].forEach(k => { if (st[k]) delete st[k][m]; });
    }
  }
  // Candles per coin, anchored at the first look: every look ADDS its new candles instead of replaying a sliding window, so each
  // strategy's chain of trades stays exactly the same as in real time (memory only; after a restart it starts again from the window).
  const barStore = new Map();
  function anchored(mint, bars){
    const old = barStore.get(mint), first = bars[0].time;
    let all;
    if (old && old.length && old[old.length - 1].time >= first && old[0].time <= first){
      let k = old.length; while (k > 0 && old[k - 1].time >= first) k--;       // keep the older, final candles; take the rest new (the forming one changed)
      all = old.slice(0, k).concat(bars);
    } else all = bars.slice();                                                  // first look, or a gap the window does not bridge: start again
    if (all.length > 2000) all = all.slice(-1000);                              // very long-followed coin: re-anchor (the phantom guard below covers it)
    barStore.set(mint, all);
    return all;
  }
  const hasOpen = mint => Object.values(st.pos).some(p => p.coin === mint);
  function onCoin(c){
    if (!cfg.on || !c.bars || c.bars.length < 80) return 0;
    expire(); st.fedAt = st.fedAt || {}; st.fedAt[c.mint] = now();
    // cost per coin: the measured Jupiter round trip (route + pool fees + impact) if the practice mode has one, else the default guess
    const jup = c.jup != null && Number.isFinite(Number(c.jup)) ? Number(c.jup) : null;
    st.jup = st.jup || {}; if (jup != null) st.jup[c.mint] = +jup.toFixed(3);
    if (jup != null && jup > cfg.maxRoundTrip){ st.tooDear = st.tooDear || {}; st.tooDear[c.mint] = +jup.toFixed(2); return 0; }   // live would refuse this coin (MAX_ROUND_TRIP_PCT)
    const bars = anchored(c.mint, c.bars);
    // honest fills (13-10b): remember when this coin was looked at; a signal is filled at the first look after its candle closed
    st.looks = st.looks || {};
    const lk = st.looks[c.mint] = st.looks[c.mint] || [];
    if (c.formingTime != null && lk[lk.length - 1] !== c.formingTime) lk.push(c.formingTime);
    while (lk.length > 1 && lk[1] <= bars[0].time) lk.shift();
    if (lk.length > 800) lk.splice(0, lk.length - 800);
    const r = LAB.labRunCoin(bars, Object.assign({}, cfg.q, { solUsd: (o.solUsd && o.solUsd()) || 110 }), { cost: jup != null ? jup : (o.cost ? o.cost() : 1), liq: c.liq, created: c.created, key: c.mint, trades: c.trades || null, cover: c.cover || null, looks: cfg.honest ? lk : null });
    let closedN = 0;
    // Each look replays the coin's latest candles. When that window slides, a strategy's chain of trades can shift (a position
    // that blocked a later signal falls out of the window), so a trade "from the past" may suddenly appear. In real time it
    // could not have happened: a NEW trade must start on or after the candle that was still forming at the previous look.
    st.lastForming = st.lastForming || {};
    const prevForming = st.lastForming[c.mint];
    for (const t of r.trades){
      if (t.t - tf < c.fwdFrom) continue;                      // only signals from the first look on (forward)
      const key = t.strat + ':' + c.mint + ':' + t.t;
      if (done.has(key)) continue;
      const startAt = cfg.honest && t.fillT != null ? t.fillT : t.t - tf;   // honest fills: the fill candle; else the signal candle
      if (prevForming != null && !st.pos[key] && startAt < prevForming){ st.phantom = (st.phantom || 0) + 1; done.add(key); st.done.push(key); continue; }
      if (t.failed){ st.attempts++; st.failed++; done.add(key); st.done.push(key); continue; }
      if (!st.pos[key]){
        st.signals++; st.attempts++;
        // exploration budget (§9.3): an agent with < 30 measured trades trades as tier X (15 % of the base size)
        const explore = (st.res[t.strat] || []).length < 30, tier = explore ? 'X' : t.tier;
        const size = explore ? t.size / LAB.TIER_MULT[t.tier] * LAB.TIER_MULT.X : t.size;
        const why = admit(Object.assign({}, t, { size }), c.mint);
        st.pos[key] = { strat: t.strat, coin: c.mint, sym: c.symbol, t: t.t, size, tier, admit: !why, why, e: t.e };
      }
      if (t.open || t.exitTime == null || t.exitTime > c.formingTime) continue;   // still open, or the exit candle is still forming
      const p = st.pos[key]; delete st.pos[key];
      const pnlSol = p.size * (t.retP != null ? t.retP : t.ret) - FEE_SOL;   // fixed fees once, at the size this track really used (tier X is smaller)
      const rec = { strat: t.strat, sym: c.symbol, mint: c.mint, t: t.t, fillT: t.fillT != null ? t.fillT : null, exitTime: t.exitTime, e: t.e, ret: t.ret, retP: t.retP != null ? t.retP : null, pnlSol, size: p.size, tier: p.tier, exit: t.exit, why: t.why,
        bars: t.bars, regime: t.regime, rug: t.rug, taken: p.admit, skip: p.why || '', costPct: t.costPct != null ? t.costPct : null };
      LAB.classify([].concat(st.closed.filter(x => x.strat === rec.strat).slice(-200), [rec]));
      if (p.admit){
        add(st.stats[rec.strat] = st.stats[rec.strat] || emptyStat(), pnlSol, rec.ret);
        st.agent = st.agent || {}; const ag = st.agent[rec.strat] = st.agent[rec.strat] || { streak: 0, pauseUntil: 0 };
        if (pnlSol < 0){ ag.streak++; if (ag.streak >= 5){ ag.pauseFrom = rec.exitTime; ag.pauseUntil = rec.exitTime + 7200; ag.streak = 0; } } else ag.streak = 0;   // 2 h pause in trade time
      } else {
        add(st.shadow[rec.strat] = st.shadow[rec.strat] || emptyStat(), pnlSol, rec.ret);
        const k = rec.skip.replace(/[\d.,]+%?/g, '#'), s = st.skip[k] = st.skip[k] || { n: 0, sumR: 0, pnl: 0 }; s.n++; s.sumR += rec.ret; s.pnl += pnlSol;
      }
      const res = st.res[rec.strat] = st.res[rec.strat] || []; res.push(+rec.ret.toFixed(5)); if (res.length > 300) res.shift();
      st.closed.push(rec); if (st.closed.length > 3000) st.closed.splice(0, st.closed.length - 3000);
      done.add(key); st.done.push(key); closedN++;
    }
    // a tracked position that the replay no longer contains (its chain changed, e.g. new swaps or a new cost measurement) is dropped
    const inReplay = new Set(r.trades.map(t => t.strat + ':' + c.mint + ':' + t.t));
    for (const [k, p] of Object.entries(st.pos)) if (p.coin === c.mint && !inReplay.has(k)){ delete st.pos[k]; st.vanished = (st.vanished || 0) + 1; if (!done.has(k)){ done.add(k); st.done.push(k); } }
    st.lastForming[c.mint] = c.formingTime;
    if (st.done.length > 30000){ st.done = st.done.slice(-20000); done = doneSet(); }
    // why (not) for the candle that just closed: counted once per candle per coin
    const k = bars.length - 2;
    st.whySeen = st.whySeen || {};
    if (k > 60 && st.whySeen[c.mint] !== bars[k].time){
      st.whySeen[c.mint] = bars[k].time;
      LAB.labExplain(r.P, cfg.q, k).forEach(x => { const w = st.why[x.strat] = st.why[x.strat] || {}, key2 = x.ok ? '✅ signaal' : String(x.why).replace(/[\d.,]+%?/g, '#'); w[key2] = (w[key2] || 0) + 1; });
    }
    return closedN;
  }

  // ---------- decisions and bandit (rolling windows) ----------
  function decide(){
    const out = {};
    Object.entries(st.res).forEach(([s, r]) => {
      const last = r.slice(-100), n = last.length;
      if (n < 30){ out[s] = 'DOORGAAN'; return; }
      const ci = LAB.bootstrapCI(last, 1000, 3), m = last.reduce((a, b) => a + b, 0) / n;
      out[s] = r.length >= 200 && ci[1] < 0 ? 'STOPPEN' : ci[1] < 0 ? 'PAUZEREN' : m < 0 ? 'BIJSTUREN' : 'DOORGAAN';
    });
    st.decision = out;
    const by = {}; LAB.LAB_STRATS.forEach(d => { if (!cfg.names || cfg.names.split(',').includes(d.name)) by[d.name] = (st.res[d.name] || []).slice(-200); });
    st.alloc = LAB.thompson(by, 2000, Math.floor(now() / 3600000));
    return out;
  }

  // ---------- go-criteria §12 (paper evidence only — live ALWAYS needs the owner's explicit "ga live") ----------
  /** per agent: ≥ 200 forward results · 95 % interval above 0 · gross ≥ 1,5 × costs · still ≥ 0 at 2 × costs · positive without PULLs */
  function goCheck(){
    const out = {}, avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    for (const [s, r] of Object.entries(st.res)){
      const n = r.length, m = avg(r), ci = n >= 30 ? LAB.bootstrapCI(r, 1000, 7) : [NaN, NaN];
      const recs = st.closed.filter(x => x.strat === s), cs = recs.filter(x => x.costPct != null).map(x => x.costPct), cost = cs.length ? avg(cs) : null;
      const noPull = recs.filter(x => x.cls !== 'PULL').map(x => x.ret);
      const c = { n: n >= 200, ci: ci[0] > 0, ev: cost != null && m + cost >= 1.5 * cost, stress: cost != null && m - cost >= 0, b: noPull.length >= 30 && avg(noPull) > 0 };
      out[s] = { c, ok: Object.values(c).every(Boolean), passed: Object.values(c).filter(Boolean).length, n, m, ci };
    }
    return out;
  }
  function goLine(){
    const g = goCheck(), e = Object.entries(g), ready = e.filter(([, v]) => v.ok).map(([k]) => k);
    const best = e.filter(([, v]) => !v.ok).sort((a, b) => b[1].passed - a[1].passed || b[1].m - a[1].m)[0];
    const label = { n: '≥200 trades', ci: 'interval > 0', ev: 'bruto ≥ 1,5× kosten', stress: 'ok bij 2× kosten', b: 'winst zonder pulls' };
    return 'Go-criteria §12: ' + (ready.length ? '✅ ' + ready.join(', ') + ' voldoen in paper' : e.length ? '0 van ' + e.length + ' agents voldoen' : 'nog geen agent met trades') + (best ? ' · dichtstbij: ' + best[0] + ' (' + best[1].passed + '/5; mist: ' + Object.entries(best[1].c).filter(([, v]) => !v).map(([k]) => label[k]).join(', ') + ')' : '') + ' · live gaat NOOIT vanzelf aan: alleen na jouw "ga live".';
  }

  // ---------- reporting ----------
  const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
  const sol = x => (x >= 0 ? '+' : '') + x.toFixed(Math.abs(x) < 0.01 ? 5 : 4);
  const openTxt = () => { const v = Object.values(st.pos), a = v.filter(p => p.admit).length; return a + ' open in paper' + (v.length > a ? ' (+' + (v.length - a) + ' in de schaduw)' : ''); };
  const eur = x => { const px = o.solEur && o.solEur(); return px ? ' (' + (x >= 0 ? '+' : '−') + '€' + Math.abs(x * px).toFixed(2) + ')' : ''; };
  /** the hourly report: text + CSV of every trade that closed in the window */
  // §3.5 anti-overfiltering: share of signals the cage skipped, and per reason whether its shadow trades did better than the taken ones
  // (then the filter blocks profit) or worse (it prevents loss). All closed trades since the start, so the verdict is not one hour of noise.
  function skipVerdict(){
    const tk = st.closed.filter(x => x.taken), sh = st.closed.filter(x => !x.taken);
    if (tk.length + sh.length < 20) return '';
    const avg = a => a.reduce((x, y) => x + y.ret, 0) / a.length, base = tk.length ? avg(tk) : 0, share = sh.length / (tk.length + sh.length);
    const by = {}; sh.forEach(x => { const k = String(x.skip || '?').replace(/[\d.,]+%?/g, '#'); (by[k] = by[k] || []).push(x); });
    const parts = Object.entries(by).filter(([, a]) => a.length >= 10).sort((a, b) => b[1].length - a[1].length).slice(0, 4)
      .map(([k, a]) => { const m = avg(a); return k + ' ' + (m > base + 0.002 ? 'BLOKKEERT WINST? (' + pct(m) + ' vs genomen ' + pct(base) + ')' : 'voorkomt verlies (' + pct(m) + ')'); });
    return 'Skip-analyse §3.5: ' + Math.round(share * 100) + '% van de signalen geskipt' + (share > 0.6 ? ' (> 60%: geanalyseerd)' : '') + (parts.length ? ' · ' + parts.join(' · ') : '') + ' · de kooi zelf wordt nooit automatisch verruimd';
  }
  // honest fills: how long after the signal candle closed the paper fill happened (the bot only acts when it looks at a coin)
  function latencyLine(list){
    const d = list.filter(x => x.fillT != null).map(x => (x.fillT - x.t) / 60).sort((a, b) => a - b);
    if (!d.length) return '';
    return 'Vertraging signaal → vulling (eerlijke vulling): mediaan ' + Math.round(d[Math.floor(d.length / 2)]) + ' min · 90% ≤ ' + Math.round(d[Math.floor(0.9 * (d.length - 1))]) + ' min';
  }
  function hourly(sinceMs){
    decide();
    const since = (sinceMs || st.reportedAt) / 1000, list = st.closed.filter(x => x.exitTime > since), taken = list.filter(x => x.taken), hours = Math.max(0.25, (now() / 1000 - since) / 3600);
    const all24 = st.closed.filter(x => x.exitTime > now() / 1000 - 86400 && x.taken);
    const m = LAB.metrics3(taken, hours), m24 = LAB.metrics3(all24, 24);
    const by = {}; all24.forEach(x => (by[x.strat] = by[x.strat] || []).push(x));
    const rank = Object.entries(by).map(([k, x]) => [k, x.length, x.reduce((a, y) => a + y.ret, 0) / x.length, x.reduce((a, y) => a + y.pnlSol, 0)]).sort((a, b) => b[3] - a[3]);
    const skips = Object.entries(st.skip).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
    const lines = ['🧪 Lab-uurrapport (PAPER, nep-geld) — ' + new Date(now()).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }),
      'Dit uur: ' + list.length + ' afgesloten (' + taken.length + ' genomen, ' + (list.length - taken.length) + ' schaduw) · tempo ' + (list.length / hours).toFixed(0) + '/uur (doel 100) · ' + openTxt(),
      '(a) alles: ' + taken.length + ' trades · ' + Math.round(m.a.win * 100) + '% winst · gem. ' + pct(m.a.exp) + ' · ' + sol(m.a.sol) + ' SOL' + eur(m.a.sol),
      '(b) zonder pulls: ' + sol(m.b.sol) + ' · (c) zonder pulls en rugs: ' + sol(m.c.sol),
      '24 u: ' + m24.a.n + ' trades · gem. ' + pct(m24.a.exp) + ' · ' + sol(m24.a.sol) + ' SOL' + eur(m24.a.sol) + (m24.a.n >= 30 ? ' · 95%-interval ' + pct(m24.a.ci[0]) + ' … ' + pct(m24.a.ci[1]) : ''),
      rank.length ? 'Beste 24 u: ' + rank.slice(0, 3).map(r => r[0] + ' ' + r[1] + 't ' + pct(r[2])).join(' · ') : 'Nog geen trades in 24 u',
      rank.length > 3 ? 'Slechtste 24 u: ' + rank.slice(-3).reverse().map(r => r[0] + ' ' + r[1] + 't ' + pct(r[2])).join(' · ') : '',
      skips.length ? 'Overgeslagen (schaduw-uitkomst): ' + skips.map(([k, s]) => k + ' ' + s.n + '× gem. ' + pct(s.sumR / s.n)).join(' · ') : '',
      skipVerdict(),
      latencyLine(list),
      (() => { const d = ['STOPPEN', 'PAUZEREN', 'BIJSTUREN'].map(x => { const a = Object.entries(st.decision).filter(([, v]) => v === x).map(([k]) => k); return a.length ? x.toLowerCase() + ': ' + a.join(', ') : ''; }).filter(Boolean).join(' · ');
        return 'Besluiten: ' + (d || 'alle agents doorgaan (nog te weinig trades voor een oordeel)'); })(),
      (() => { const c = taken.filter(x => x.costPct != null); if (!c.length) return ''; const cost = c.reduce((a, x) => a + x.costPct, 0) / c.length, gross = c.reduce((a, x) => a + x.ret + x.costPct, 0) / c.length;
        return 'Kosten: gem. ' + (cost * 100).toFixed(2) + '% per trade (incl. ' + FEE_SOL + ' SOL vaste fees bij 0,08 SOL) · bruto vóór kosten ' + pct(gross) + (gross > 0 ? ' · kosten = ' + Math.round(cost / gross * 100) + '% van de bruto winst' : ' · bruto al negatief'); })(),
      goLine(),
      'Bandit-budget top: ' + Object.entries(st.alloc).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + ' ' + Math.round(v * 100) + '%').join(' · '),
      'Live: UIT. Niets hiervan is echt geld.'].filter(Boolean);
    const csv = ['nr;tijd_utc;coin;strategie;signaal;BUY/SELL;tier;prijs_in;grootte_sol;kosten_in_ret;netto_sol;netto_pct;houdtijd_min;tag;status;reden_skip;exit'];
    list.forEach((x, k) => csv.push([k + 1, new Date(x.t * 1000).toISOString().slice(0, 16) + '→' + new Date(x.exitTime * 1000).toISOString().slice(11, 16), x.sym, x.strat, '"' + String(x.why).replace(/"/g, "'") + '"', 'BUY→SELL', x.tier,
      x.e != null ? Number(x.e).toPrecision(6) : '', x.size.toFixed(4), 'ja', x.pnlSol.toFixed(5), (x.ret * 100).toFixed(2), x.bars != null ? x.bars * tf / 60 : '', x.cls || 'NORMAAL', x.taken ? 'PAPER' : 'SCHADUW', x.skip, x.exit].join(';')));
    st.reportedAt = now();
    return { text: lines.join('\n'), csv: csv.join('\n'), n: list.length };
  }
  function dueReport(){ return cfg.on && cfg.reportH > 0 && now() - st.reportedAt >= cfg.reportH * 3600000; }
  function text(){
    if (!cfg.on) return '🧪 Lab staat uit (LAB_PRACTICE=0).';
    decide();
    const rows = LAB.LAB_STRATS.filter(d => !cfg.names || cfg.names.split(',').includes(d.name)).map(d => {
      const s = st.stats[d.name] || emptyStat(), sh = st.shadow[d.name] || emptyStat(), w = st.why[d.name] || {};
      const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
      return '• ' + d.name + ' — ' + (s.n ? s.n + 't ' + Math.round(s.wins / s.n * 100) + '% gem. ' + pct(s.sumR / s.n) + ' ' + sol(s.pnl) : '0 trades') + (sh.n ? ' · schaduw ' + sh.n + 't ' + pct(sh.sumR / sh.n) : '')
        + ' · ' + (st.decision[d.name] || 'DOORGAAN').toLowerCase() + (top ? ' · meest: ' + top[0] : '');
    });
    const tot = Object.values(st.stats).reduce((a, s) => { a.n += s.n; a.pnl += s.pnl; a.r += s.sumR; return a; }, { n: 0, pnl: 0, r: 0 });
    return '🧪 Lab — ' + rows.length + ' strategie-agents, ALLEEN PAPER (nep-geld, echte charts, kosten eraf)\n'
      + 'Totaal genomen: ' + tot.n + ' trades · ' + sol(tot.pnl) + ' SOL' + eur(tot.pnl) + (tot.n ? ' · gem. ' + pct(tot.r / tot.n) : '') + ' · ' + openTxt() + ' · ' + st.signals + ' signalen sinds start' + (st.expired ? ' · ' + st.expired + ' verlopen (coin niet meer gevolgd)' : '') + (st.phantom ? ' · ' + st.phantom + ' nagespeelde trades uit het verleden genegeerd' : '') + (st.vanished ? ' · ' + st.vanished + ' gevolgde posities verdwenen uit de herhaling' : '') + '\n'
      + rows.join('\n')
      + (() => { const g = {}; st.closed.forEach(x => { if (x.regime) (g[x.regime] = g[x.regime] || []).push(x.ret); }); const e = Object.entries(g).filter(([, r]) => r.length >= 10); return e.length ? '\nPer marktregime (alle agents, incl. schaduw): ' + e.map(([k, r]) => k + ' ' + r.length + 't ' + pct(r.reduce((a, b) => a + b, 0) / r.length)).join(' · ') : ''; })()
      + (() => { const g = {}; st.closed.forEach(x => { const h = new Date(x.t * 1000).getUTCHours(); (g[h] = g[h] || []).push(x.ret); });
        const e = Object.entries(g).filter(([, r]) => r.length >= 10).map(([h, r]) => [h, r.length, r.reduce((a, b) => a + b, 0) / r.length]).sort((a, b) => a[2] - b[2]);
        const f = x => x[0] + 'u ' + x[1] + 't ' + pct(x[2]);
        return e.length >= 6 ? '\nPer instap-uur (UTC, incl. schaduw): slechtst ' + e.slice(0, 3).map(f).join(' · ') + ' · best ' + e.slice(-3).reverse().map(f).join(' · ') + ' (backtest: 13u en 19u UTC zwak — hier vooruit gecontroleerd)' : ''; })()
      + (() => { const v = Object.values(st.jup || {}).sort((a, b) => a - b); if (!v.length) return '\nKosten: nog niet per coin gemeten (standaard ' + (o.cost ? o.cost() : 1) + '% + vaste fees).';
        const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))]; const dear = Object.keys(st.tooDear || {}).length;
        return '\nKosten per coin (Jupiter heen+terug, gemeten): ' + v.length + ' coins · mediaan ' + q(0.5).toFixed(2) + '% · 10–90%: ' + q(0.1).toFixed(2) + '–' + q(0.9).toFixed(2) + '%' + (dear ? ' · ' + dear + ' coins overgeslagen (> ' + cfg.maxRoundTrip + '%, live zou weigeren)' : '') + ' · plus ' + FEE_SOL + ' SOL vaste fees per trade'; })()
      + '\n' + goLine()
      + '\nKooi: max ' + cfg.q.maxOpen + ' posities · ' + cfg.q.maxExpPct + '% blootstelling · ' + cfg.q.coinMaxPct + '% per coin · verlies max ' + cfg.q.hourLossPct + '%/u, ' + cfg.q.dayLossPct + '%/dag, ' + cfg.q.weekLossPct + '%/week van ' + cfg.q.capital + ' SOL (paper).';
  }
  function exportState(){ return Object.assign({}, st, { closed: st.closed.slice(-1500), done: st.done.slice(-20000) }); }
  function importState(s){
    if (!s || typeof s !== 'object') return;
    st = Object.assign(fresh(), s, { pos: {} });      // open paper positions are re-detected from the charts after a restart
    ['stats', 'shadow'].forEach(k => { Object.keys(st[k] || {}).forEach(n => { st[k][n] = Object.assign(emptyStat(), st[k][n]); }); });
    st.closed = Array.isArray(st.closed) ? st.closed : []; st.done = Array.isArray(st.done) ? st.done : []; done = doneSet();
    st.lastForming = {};   // after a restart the open positions must be found again, so the first look accepts everything since fwdFrom
  }
  /** dashboard: per agent n / win / pnl / decision */
  function summary(){
    decide();
    return { on: cfg.on, agents: Object.fromEntries(Object.entries(st.stats).map(([k, s]) => [k, { n: s.n, wins: s.wins, pnl: +s.pnl.toFixed(5), exp: s.n ? +(s.sumR / s.n * 100).toFixed(2) : 0, d: st.decision[k] || 'DOORGAAN' }])),
      go: (() => { const g = goCheck(); return { ready: Object.entries(g).filter(([, v]) => v.ok).map(([k]) => k).slice(0, 10), total: Object.keys(g).length }; })(),
      jupMed: (() => { const v = Object.values(st.jup || {}).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(),
      open: Object.values(st.pos).filter(p => p.admit).length, shadowOpen: Object.values(st.pos).filter(p => !p.admit).length, signals: st.signals, skip: Object.fromEntries(Object.entries(st.skip).slice(0, 8).map(([k, s]) => [k, { n: s.n, exp: +(s.sumR / s.n * 100).toFixed(2) }])) };
  }
  return { cfg, onCoin, hasOpen, expire, goCheck, goLine, hourly, dueReport, text, decide, exportState, importState, summary, get state(){ return st; } };
}

module.exports = { createLabTrack };
