/**
 * Oefen-modus: de bot draait je strategie met nep-geld op coins waar je NIET in zit, met echte charts,
 * en stuurt elke afgesloten oefen-trade naar het cloud-geheugen. Zo leert hij veel sneller.
 *
 * Twee soorten oefen-trades:
 *  - historie: bij elke nieuwe coin de trades van de afgelopen dagen (snel veel leerstof)
 *  - vooruit:  trades die vanaf nu live ontstaan. Alleen DEZE tellen voor "klaar voor echt geld",
 *              want daar kon de bot niet vooruit kijken.
 *
 * Variables in Railway (standaard tussen haakjes):
 * PAPER_SCOUT (1)          0 = uit
 * PAPER_COINS (300 bij 15m, 100 bij 5m, 30 bij 1m)  op hoeveel coins tegelijk oefenen
 * PAPER_PER_ROUND (auto)   hoeveel daarvan per ronde bekeken worden (past bij het gratis GeckoTerminal-budget; de rest volgt
 *                          in de volgende rondes — de bot speelt de grafiek opnieuw af, dus er gaat geen trade verloren)
 * PAPER_SOL (0.05)         nep-inzet per oefen-trade
 * PAPER_MIN_LIQ (50000)    alleen coins met minstens zoveel liquiditeit ($)
 * PAPER_REPICK_H (2, of 6 bij veel coins) zo vaak nieuwe coins kiezen (coins met een open oefen-positie blijven); steeds andere coins = meer leerstof
 * PAPER_HISTORY_DAYS (3)   bij een nieuwe coin zoveel dagen terug alle trades meetellen (0 = alleen vanaf nu)
 * PAPER_GOAL (200)         zoveel vooruit-oefentrades (die door de lessen heen kwamen) voordat de bot "klaar" zegt
 *
 * 12-10c: volume-profiel-strategieën (o.vp) oefenen hier ook mee, elk met een eigen score, alleen vooruit, nooit in de cloud-lessen
 * en nooit met echt geld. Per strategie: resultaat, laatste 20 vs eerder (drift), waarom er wel/niet gekocht werd, laatste signalen.
 */
'use strict';

// coin groups by liquidity (same buckets as the cloud memory): a strategy can work on small coins and fail on big ones
const GROUPS = ['50K-250K', '250K-1M', '>1M'];
function groupOf(liq){ liq = Number(liq) || 0; return liq < 250000 ? '50K-250K' : liq < 1000000 ? '250K-1M' : '>1M'; }
const emptyStat = () => ({ n: 0, wins: 0, pnl: 0, gw: 0, gl: 0, qn: 0, qs: 0, qq: 0 });
// qn/qs/qq: count, sum and sum of squares of the result per trade → how sure are we the profit is not luck (t-value)
function addStat(s, pnl){ s.n++; s.pnl += pnl; if (pnl > 0){ s.wins++; s.gw += pnl; } else s.gl -= pnl; s.qn = (s.qn || 0) + 1; s.qs = (s.qs || 0) + pnl; s.qq = (s.qq || 0) + pnl * pnl; }
function tValue(s){
  const n = s.qn || 0; if (n < 2) return 0;
  const mean = s.qs / n, v = (s.qq - s.qs * s.qs / n) / (n - 1);
  return v > 0 ? mean / Math.sqrt(v / n) : (mean > 0 ? Infinity : 0);
}

function createScout(o){
  const env = o.env || process.env;
  const n = (k, f) => { const v = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : f; };
  const tfSec = (() => { const [u, a] = String(o.timeframe || 'minute:5').split(':'); return ({ second: 1, minute: 60, hour: 3600, day: 86400 }[u] || 60) * (Number(a) || 1); })();
  const defCoins = tfSec >= 900 ? 300 : tfSec >= 300 ? 100 : 30;
  const coinsWant = Math.max(1, Math.min(500, Math.floor(n('PAPER_COINS', defCoins))));
  // 13-10e: every coin must be looked at at least every PAPER_MAX_LOOK_MIN (60) minutes. Railway showed 300 coins at 33 per round on
  // 15m candles = each coin only every ±2,3 h, so (with honest fills) almost every signal was hours old. 0 = no cap.
  const perRoundWant = Math.max(1, Math.floor(n('PAPER_PER_ROUND', o.perRound || coinsWant))), lookMin = Math.max(0, n('PAPER_MAX_LOOK_MIN', 60));
  const coinsN = lookMin > 0 ? Math.min(coinsWant, Math.max(perRoundWant, perRoundWant * Math.floor(lookMin * 60 / tfSec))) : coinsWant;
  const cfg = {
    on: !['0', 'false'].includes(String(env.PAPER_SCOUT || '1').toLowerCase()),
    coins: coinsN, coinsWant,
    perRound: perRoundWant,   // coins looked at per round (GeckoTerminal budget)
    sol: n('PAPER_SOL', n('TRADE_AMOUNT_SOL', 0.05)),   // same stake as the real bot, so the fees in % match
    minLiq: n('PAPER_MIN_LIQ', 50000),
    repickH: Math.max(0.5, n('PAPER_REPICK_H', coinsN > 50 ? 6 : 2)),
    historyDays: Math.max(0, Math.min(14, n('PAPER_HISTORY_DAYS', env.PAPER_HISTORY === '0' ? 0 : 3))),
    goal: Math.max(20, Math.floor(n('PAPER_GOAL', 200))),
    minT: Math.max(0, n('PAPER_MIN_T', 2)),   // how sure (t-value) the practice profit must be before "ready"; 2 ≈ 95% sure it is not luck
    huntGoal: Math.max(20, Math.floor(n('PAPER_HUNT_GOAL', 100))),   // the hunter is pickier, so fewer trades are needed
    tf: o.timeframe || 'minute:5',
  };
  const now = o.now || (() => Date.now());
  const fresh = () => ({ coins: {}, done: [], pickedAt: 0, used: {}, stats: emptyStat(), fwd: emptyStat(), ok: emptyStat(), hunt: emptyStat(), fresh: emptyStat(), freshHunt: emptyStat(), okBy: {}, huntBy: {}, hist: 0, coinsSeen: 0, announced: '', announcedHunt: '', runner: emptyStat(), runnerBy: {}, runnerBest: {},
    vp: {}, vpRes: {}, vpSig: [], vpLast: [], vpWhy: {}, vpAlerted: {}, day: { key: '', ok: 0, vp: 0 } });
  let st = fresh();
  let vpNew = 0;   // volume-profile practice trades finished in the last round
  // the practice day follows Dutch time, like the real bot's day (for the daily goal)
  const nlDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(now()));
  function dayRoll(){ const k = nlDay(); if (st.day.key !== k){ st.day = { key: k, ok: 0, vp: 0 }; st.vpWhy = {}; } return st.day; }
  function dayAdd(kind, pnl){ const d = dayRoll(); d[kind] = (d[kind] || 0) + pnl; }
  const closedAt = [];   // when practice trades were finished (this run only; for the night report)
  // coins[mint] = { symbol, ctx, fwdFrom (sec: trades that start from here are "vooruit"), mined, open, liq, entryOk: {entryTime: bool} }
  // done = "mint:entryTime" already sent to the memory · used[mint] = when the coin was last picked (rotation)

  async function pick(){
    const list = (await o.candidates()) || [];
    // coins with an open practice position stay — also open lab positions, otherwise they could never close (and would block the lab cage)
    const keep = Object.entries(st.coins).filter(([m, c]) => c.open || (o.lab && o.lab.hasOpen && o.lab.hasOpen(m))).map(([m]) => m);
    const ok = list.filter(c => (c.liq || 0) >= cfg.minLiq && !(o.isActive && o.isActive(c.mint)) && !keep.includes(c.mint));
    // rotation: coins we have not practised on in the last 24 h first — every new coin brings days of history to learn from
    const dayAgo = now() - 86400000;
    const order = ok.filter(c => !(st.used[c.mint] > dayAgo)).concat(ok.filter(c => st.used[c.mint] > dayAgo).sort((a, b) => (st.used[a.mint] || 0) - (st.used[b.mint] || 0)));
    const chosen = keep.concat(order.map(c => c.mint)).filter((m, i, a) => a.indexOf(m) === i).slice(0, Math.max(cfg.coins, keep.length));
    const next = {};
    chosen.forEach(m => {
      const cand = list.find(c => c.mint === m) || {};
      next[m] = st.coins[m] || { symbol: cand.symbol || m.slice(0, 6), ctx: null, fwdFrom: null, mined: false, open: false, liq: cand.liq || 0, entryOk: {} };
      if (cand.liq) next[m].liq = cand.liq;
      if (!st.used[m]) st.coinsSeen++;
      st.used[m] = now();
    });
    // forget rotation info older than a week
    Object.keys(st.used).forEach(m => { if (st.used[m] < now() - 7 * 86400000) delete st.used[m]; });
    st.coins = next; st.pickedAt = now();
    return Object.keys(next);
  }

  // keep every "mint:entryTime" that can still be on a chart (300 candles + history days + a day of margin), drop older ones
  function pruneDone(){
    const cutoff = Math.floor(now() / 1000) - Math.max(300 * tfSec, cfg.historyDays * 86400) - 86400;
    st.done = st.done.filter(k => Number(String(k).split(':').pop()) >= cutoff);
    if (st.done.length > 40000) st.done = st.done.slice(-40000);
  }
  async function allowed(c, mint, source, patterns){
    if (!o.check) return true;
    try { return (await o.check({ kind: 'strategie', mint, source, liq: c.liq, patterns: patterns || [] })).ok !== false; } catch (_){ return true; }
  }

  // Candles per coin, anchored at the first look (memory only): a sliding window can shift a strategy's chain of trades
  // (a position that blocked a later signal falls out of view) so old trades would suddenly look new. New candles are added instead.
  function anchorBars(c, bars){
    const old = c.barsAll, first = bars[0].time;
    let all = bars;
    if (old && old.length && old[old.length - 1].time >= first && old[0].time <= first){
      let k = old.length; while (k > 0 && old[k - 1].time >= first) k--;
      all = old.slice(0, k).concat(bars);
    }
    if (all.length > 2000) all = all.slice(-1000);
    c.barsAll = all;
    return all;
  }

  /** one round over all practice coins; returns the number of finished practice trades */
  async function round(){
    if (!cfg.on) return 0;
    // also re-pick early when there are far fewer coins than asked (an older setting, or a coin list that failed to load) — at most every 30 min
    const tooFew = Object.keys(st.coins).length < cfg.coins / 2 && now() - st.pickedAt > 1800000;
    if (!Object.keys(st.coins).length || tooFew || now() - st.pickedAt > cfg.repickH * 3600000){
      try { await pick(); } catch (e){ console.error('oefen: coins kiezen mislukt', e.message); }
    }
    const [unit, agg] = cfg.tf.split(':');
    let found = 0, jupN = 0; vpNew = 0; dayRoll();
    // with many coins: each round the ones that waited longest (never-seen first), so every coin gets its turn
    const todo = Object.entries(st.coins).filter(([m]) => !(o.isActive && o.isActive(m)))
      .sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0)).slice(0, cfg.perRound);
    st.lastRound = { looked: todo.length, of: Object.keys(st.coins).length };
    for (const [mint, c] of todo){
      c.seenAt = now();
      try {
        if (!c.ctx) c.ctx = await o.fetchBestPair(mint);
        let bars;
        if (!c.mined && cfg.historyDays > 0 && o.fetchHistory)
          bars = await o.fetchHistory(c.ctx.network, c.ctx.poolAddress, unit, agg, Math.floor(now() / 1000) - cfg.historyDays * 86400, mint);
        else bars = await o.fetchOHLCV(c.ctx.network, c.ctx.poolAddress, unit, agg, mint);
        if (!bars || bars.length < 60) continue;
        bars = anchorBars(c, bars);   // same start every look → every strategy's chain of trades is exactly as in real time
        const p = o.getParams();
        const res = o.runEngine(bars, p);
        const formingTime = bars[bars.length - 1].time;
        if (c.fwdFrom == null) c.fwdFrom = formingTime;            // from here on trades count as "vooruit"
        const mineHistory = !c.mined && cfg.historyDays > 0;
        c.mined = true;
        const trades = o.tradesFromEvents(res.events, p, bars[bars.length - 1].close);
        c.open = trades.some(t => t.open);
        // a new forward position: decide NOW whether the lessons would have let it through (no peeking at the result)
        for (const t of trades){
          if (t.open && t.entryTime >= c.fwdFrom && c.entryOk[t.entryTime] == null){
            const buy = res.events.find(e => e.type === 'BUY' && e.time === t.entryTime) || {};
            c.entryOk[t.entryTime] = await allowed(c, mint, buy.src || 'EMA', buy.pats);
            // would the hunter (the bot that buys with real money) have taken this one? decided now, at the buy
            c.entryHunt = c.entryHunt || {};
            c.entryHunt[t.entryTime] = o.huntGate ? !!(await o.huntGate({ mint, liq: c.liq, src: buy.src || 'EMA', pats: buy.pats || [] })) : false;
            // 13-10b: was this BUY on the candle that JUST closed? Only such a fresh signal can be bought live (the hunter takes only
            // those). A BUY that the bot first sees one or more candles late was filled in the past in practice — not possible live.
            c.entryFresh = c.entryFresh || {};
            c.entryFresh[t.entryTime] = bars.length >= 2 && t.entryTime === bars[bars.length - 2].time;
          }
        }
        for (const t of trades){
          if (t.open || t.exitTime == null) continue;
          if (t.exitTime >= formingTime) continue;               // exit inside a candle that is still forming: wait until it closed
          const isFwd = t.entryTime >= c.fwdFrom;
          if (!isFwd && !mineHistory) continue;                  // older than our first look and history is off
          const key = mint + ':' + t.entryTime;
          if (st.done.includes(key)) continue;
          st.done.push(key);
          const buy = res.events.find(e => e.type === 'BUY' && e.time === t.entryTime) || {};
          const exit = res.events.filter(e => e.time === t.exitTime && e.type !== 'BUY' && e.type !== 'TP1' && !(e.type === 'TP2' && e.frac != null)).pop() || {};
          const pnlSol = cfg.sol * t.ret;
          addStat(st.stats, pnlSol);
          if (isFwd){
            addStat(st.fwd, pnlSol);
            let ok = c.entryOk[t.entryTime];
            if (ok == null) ok = await allowed(c, mint, buy.src || 'EMA', buy.pats);   // opened and closed between two looks
            const grp = groupOf(c.liq);
            if (ok){ addStat(st.ok, pnlSol); addStat(st.okBy[grp] = st.okBy[grp] || emptyStat(), pnlSol); dayAdd('ok', pnlSol); }
            delete c.entryOk[t.entryTime];
            c.entryHunt = c.entryHunt || {};
            let hg = c.entryHunt[t.entryTime];
            if (hg == null && o.huntGate) hg = !!(await o.huntGate({ mint, liq: c.liq, src: buy.src || 'EMA', pats: buy.pats || [] }));
            if (hg && ok){ addStat(st.hunt, pnlSol); addStat(st.huntBy[grp] = st.huntBy[grp] || emptyStat(), pnlSol); }
            delete c.entryHunt[t.entryTime];
            c.entryFresh = c.entryFresh || {};
            if (c.entryFresh[t.entryTime] === true){ addStat(st.fresh, pnlSol); if (hg && ok) addStat(st.freshHunt, pnlSol); }   // opened and closed between two looks = never fresh
            delete c.entryFresh[t.entryTime];
          } else st.hist++;
          found++;
          if (isFwd) closedAt.push(now()); if (closedAt.length > 5000) closedAt.splice(0, closedAt.length - 5000);
          if (o.record) await o.record({ kind: 'papier', hist: !isFwd, mint, symbol: c.symbol, source: buy.src || 'EMA', liq: c.liq, spentSol: cfg.sol, pnlSol, pnlPct: t.ret * 100,
            exit: exit.why || exit.type || 'EXIT', buyTime: t.entryTime * 1000, sellTime: t.exitTime * 1000, sig: 'papier@' + cfg.tf + ':' + mint + ':' + t.entryTime, patterns: buy.pats || [] });
        }
        // 🏃 runner strategy (practice only): its own trades and its own score, never in the cloud lessons
        if (o.runner){
          for (const t of o.runner(bars)){
            if (t.open || t.exitTime == null || t.exitTime >= formingTime || t.entryTime < c.fwdFrom) continue;
            const key = 'r:' + mint + ':' + t.entryTime;
            if (st.done.includes(key)) continue;
            st.done.push(key);
            const pnlSol = cfg.sol * t.ret, grp = groupOf(c.liq);
            addStat(st.runner, pnlSol); addStat(st.runnerBy[grp] = st.runnerBy[grp] || emptyStat(), pnlSol);
            if (t.ret > (st.runnerBest.ret || 0)) st.runnerBest = { ret: t.ret, symbol: c.symbol, t: t.exitTime };
            closedAt.push(now());
          }
        }
        // the coin's real cost (volume-profile + lab practice): a Jupiter round-trip quote for this coin (read-only), refreshed every 6 h
        if ((o.lab || o.vp) && o.jupCost && jupN < Math.max(0, n('LAB_JUP_PER_ROUND', 20)) && (!(c.jupAt > 0) || now() - c.jupAt > 6 * 3600000)){
          c.jupAt = now(); jupN++;   // at most LAB_JUP_PER_ROUND (20) coins measured per round: gentle on Jupiter's free API
          try { const v = await o.jupCost(mint); if (Number.isFinite(v) && v > -1 && v < 100) c.jup = Math.max(0, v); } catch (_){}
        }
        // 📊 volume-profile strategies (practice only): own score per strategy, never in the cloud lessons
        if (o.vp){
          let r = null;
          try { r = o.vp(bars, { mint, liq: c.liq, created: c.ctx && c.ctx.pair ? c.ctx.pair.pairCreatedAt : null, jup: c.jup != null ? c.jup : null }); } catch (e){ console.error('vp', c.symbol, e.message); }
          if (r){
            for (const t of r.trades || []){
              if (t.open || t.exitTime == null || t.exitTime > formingTime || t.entryTime < c.fwdFrom) continue;   // only closed candles, only forward
              const key = 'v:' + t.strat + ':' + mint + ':' + t.entryTime;
              if (st.done.includes(key)) continue;
              st.done.push(key);
              const pnlSol = cfg.sol * t.ret;
              addStat(st.vp[t.strat] = st.vp[t.strat] || emptyStat(), pnlSol);
              const res = st.vpRes[t.strat] = st.vpRes[t.strat] || []; res.push(+t.ret.toFixed(5)); if (res.length > 200) res.shift();
              st.vpLast.unshift({ s: t.strat, sym: c.symbol, ret: +t.ret.toFixed(4), exit: t.exit, why: t.why, t: t.exitTime }); if (st.vpLast.length > 40) st.vpLast.pop();
              dayAdd('vp', pnlSol); vpNew++; closedAt.push(now());
            }
            // why (not): once per closed candle per coin, counted per strategy for today
            const closed = bars.length >= 2 ? bars[bars.length - 2].time : null;
            if (closed && c.vpSeen !== closed){
              c.vpSeen = closed;
              for (const x of r.explain || []){
                const w = st.vpWhy[x.strat] = st.vpWhy[x.strat] || {}, k = x.ok ? '✅ signaal' : String(x.why || '?').replace(/\s*\(.*\)$/, '');
                w[k] = (w[k] || 0) + 1;
                if (x.ok){
                  st.vpSig.unshift({ s: x.strat, m: mint, sym: c.symbol, t: closed, why: x.why }); if (st.vpSig.length > 30) st.vpSig.pop();
                  console.log('VP-signaal (oefen)', x.name || x.strat, c.symbol, '—', x.why);
                }
              }
            }
          }
        }
        // 🧪 lab (13-10a): 27 strategy agents, paper only, through the cage — its own state, never in the cloud lessons
        if (o.lab){
          try {
            // real swaps (order flow) for the most liquid practice coins only — costs one extra GeckoTerminal call per coin
            let trades = null;
            const flowN = Math.max(0, Math.floor(n('LAB_FLOW_COINS', 0)));
            if (flowN && o.fetchTrades && c.ctx && Object.values(st.coins).sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, flowN).includes(c)){
              try { trades = await o.fetchTrades(c.ctx.network, c.ctx.poolAddress, mint); } catch (_){ trades = null; }
              if (trades && trades.length){
                // this fetch holds every swap from its oldest one until now → one covered stretch; merge overlapping stretches
                const t0 = trades.reduce((a, x) => Math.min(a, x[0]), Infinity), w = (c.swapCover || []).concat([[t0, Math.floor(now() / 1000)]]).sort((a, b) => a[0] - b[0]), m = [];
                w.forEach(x => { const L = m[m.length - 1]; if (L && x[0] <= L[1]) L[1] = Math.max(L[1], x[1]); else m.push([x[0], x[1]]); });
                c.swapCover = m.filter(x => x[1] >= bars[0].time).slice(-50);
                const prev = c.swaps || [], seen = new Set(prev.map(x => x[0] + ':' + x[2] + ':' + x[4])); trades.forEach(x => { if (!seen.has(x[0] + ':' + x[2] + ':' + x[4])) prev.push(x); }); c.swaps = prev.filter(x => x[0] >= bars[0].time).slice(-5000); trades = c.swaps;
              }
            }
            vpNew += o.lab.onCoin({ mint, symbol: c.symbol, liq: c.liq, created: c.ctx && c.ctx.pair ? c.ctx.pair.pairCreatedAt : null, bars, formingTime, fwdFrom: c.fwdFrom, trades, cover: trades ? c.swapCover || null : null, jup: c.jup != null ? c.jup : null });
          } catch (e){ console.error('lab', c.symbol, e.message); }
        }
        if (st.done.length > 6000) pruneDone();
        // a fresh BUY on the candle that JUST closed: hand it to the hunter (it decides if it is good enough for real money)
        const lastClosed = bars.length >= 2 ? bars[bars.length - 2].time : null;
        const fresh = res.events.find(e => e.type === 'BUY' && e.time === lastClosed);
        if (fresh && o.onSignal && c.lastSignal !== fresh.time){
          c.lastSignal = fresh.time;
          try { await o.onSignal({ mint, symbol: c.symbol, src: fresh.src || 'EMA', pats: fresh.pats || [], liq: c.liq, price: fresh.price, ctx: c.ctx, time: fresh.time }); }
          catch (e){ console.error('jager', c.symbol, e.message); }
        }
      } catch (e){ console.error('oefen', c.symbol, e.message); if (!/geckoterminal/i.test(e.message)) c.ctx = null; }
    }
    return found;
  }

  /** Is the strategy (with what the memory learned) good enough for real money? Only forward trades count. */
  // kind 'ok' = everything the lessons allow · 'hunt' = only what the hunter would buy (stricter: pattern, liquidity, edge)
  // with liq: readiness of THAT coin group only (half the goal, same certainty rules) — real money only goes where it was proven
  function readiness(kind, liq){
    const g = liq != null ? groupOf(liq) : null;
    const s = g ? ((kind === 'hunt' ? st.huntBy : st.okBy)[g] || emptyStat()) : (kind === 'hunt' ? st.hunt : st.ok);
    const goal = Math.ceil((kind === 'hunt' ? cfg.huntGoal : cfg.goal) / (g ? 2 : 1));
    const pf = s.gl > 0 ? s.gw / s.gl : (s.gw > 0 ? Infinity : 0);
    const win = s.n ? s.wins / s.n : 0;
    // also needs t ≥ 2: with a strategy that has NO edge, "PF ≥ 1.2 after 200 trades" still happened by luck ±1 in 7 times
    const t = tValue(s), sure = (s.qn || 0) >= 30 && t >= cfg.minT;
    const ready = s.n >= goal && s.pnl > 0 && pf >= 1.2 && sure;
    const bad = s.n >= goal && !ready && !(s.pnl > 0 && pf >= 1.2 && !sure);   // profitable but not yet sure enough = keep going, not "bad"
    const unsure = s.n >= goal && s.pnl > 0 && pf >= 1.2 && !sure;
    return { group: g, n: s.n, goal, pnl: s.pnl, pf, win, t, qn: s.qn || 0, unsure, ready, bad, pct: Math.min(unsure ? 99 : 100, Math.round(s.n / goal * 100)) };
  }
  const fmtS = x => (x >= 0 ? '+' : '') + x.toFixed(4) + ' SOL';
  // why "not sure yet": too few trades measured since the update, or the profit is still too uneven
  const sureTxt = r => r.qn < 30 ? 'de zekerheidsmeting heeft nog ' + (30 - r.qn) + ' nieuwe trades nodig (geteld sinds de update)'
    : 'zekerheid ' + (isFinite(r.t) ? r.t.toFixed(1) : '∞') + ', nodig ' + cfg.minT;
  const line = (label, s) => label + ': ' + s.n + ' trades · ' + (s.n ? Math.round(s.wins / s.n * 100) : 0) + '% winst · ' + fmtS(s.pnl) + (s.gl > 0 ? ' · PF ' + (s.gw / s.gl).toFixed(2) : '');
  function huntReadyText(){
    const r = readiness('hunt');
    return '🎯 Zoals de Jager koopt: ' + (r.ready ? '✅ klaar (' + r.n + ' trades, ' + fmtS(r.pnl) + ', PF ' + (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') + ') — de Jager mag echt kopen'
      : r.unsure ? '⏳ winst, maar nog niet zeker genoeg (' + r.n + ' trades, ' + fmtS(r.pnl) + ', ' + sureTxt(r) + ')'
      : r.bad ? '❌ niet goed genoeg (' + r.n + ' trades, ' + fmtS(r.pnl) + ') — de Jager koopt niet echt'
      : r.pct + '% (' + r.n + ' van ' + r.goal + ' trades' + (r.n ? ', ' + fmtS(r.pnl) : '') + ')');
  }
  function readyText(){
    const r = readiness();
    if (r.ready) return '✅ KLAAR voor echt geld: ' + r.n + ' vooruit-oefentrades (die door de lessen kwamen) samen ' + fmtS(r.pnl) + ', PF ' + (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') + '. Begin met je huidige inzet (TRADE_AMOUNT_SOL) — de kosten in het oefenen zijn daarop berekend.';
    if (r.unsure) return '⏳ Bijna: ' + r.n + ' vooruit-oefentrades samen ' + fmtS(r.pnl) + ' (PF ' + (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') + '), maar nog niet zeker genoeg dat dit geen geluk is (' + sureTxt(r) + '). Hij oefent door.';
    if (r.bad) return '❌ Nog NIET klaar: na ' + r.n + ' vooruit-oefentrades is het resultaat ' + fmtS(r.pnl) + ' (PF ' + (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') + '). De strategie verdient zo niet genoeg na kosten — echt geld zou nu verlies geven. Laat hem verder leren, of probeer andere instellingen (/tune).';
    return '⏳ Gereedheid ' + r.pct + '%: ' + r.n + ' van ' + r.goal + ' vooruit-oefentrades' + (r.n ? ' (tot nu toe ' + fmtS(r.pnl) + ')' : '') + '. Pas daarna zegt de bot eerlijk of echt geld verstandig is.';
  }
  function text(){
    if (!cfg.on) return '🎓 Oefen-modus staat uit (PAPER_SCOUT=0).';
    const coins = Object.values(st.coins);
    return '🎓 Oefen-modus (nep-geld, echte charts)\n'
      + (coins.length ? 'Oefent nu op ' + coins.length + ' coins: ' + coins.slice(0, 25).map(c => c.symbol + (c.open ? '*' : '')).join(', ') + (coins.length > 25 ? ' … en ' + (coins.length - 25) + ' meer' : '') + (coins.some(c => c.open) ? ' (* = in oefen-trade)' : '') : 'Kiest zo meteen coins…')
      + (st.lastRound && st.lastRound.of > st.lastRound.looked ? '\nPer ronde bekijkt hij ' + st.lastRound.looked + ' van de ' + st.lastRound.of + ' coins (gratis GeckoTerminal-limiet); elke coin komt ± elke ' + Math.ceil(st.lastRound.of / Math.max(1, st.lastRound.looked)) + ' rondes aan de beurt. Er gaan geen trades verloren: de grafiek wordt opnieuw afgespeeld.' : '')
      + '\nAl ' + st.coinsSeen + ' verschillende coins bekeken · nieuwe coins elke ' + cfg.repickH + ' uur'
      + '\n' + line('Alles', st.stats) + (st.hist ? ' (waarvan ' + st.hist + ' uit de historie — die leren de bot NIET wat hij moet blokkeren: ze komen van coins die al gestegen waren)' : '')
      + '\n' + line('Vooruit (vanaf nu)', st.fwd)
      + '\n' + line('Vooruit, met geleerde lessen', st.ok)
      + '\n' + line('Vooruit, zoals de Jager koopt', st.hunt)
      + '\n' + line('Vooruit, alleen verse signalen (wat live echt kon)', st.fresh) + (st.fwd.n ? ' — ' + Math.round(st.fresh.n / st.fwd.n * 100) + '% van de vooruit-trades was vers; de rest zag de bot pas later, live had hij die gemist of duurder gekocht' : '')
      + '\n' + line('…en daarvan zoals de Jager koopt', st.freshHunt)
      + '\n' + readyText()
      + '\n' + huntReadyText()
      + '\nPer coin-groep (echt geld gaat alleen naar een groep die zelf ✅ klaar is):\n' + GROUPS.map(g => {
        const r = readiness('ok', g === '50K-250K' ? 100000 : g === '250K-1M' ? 500000 : 2e6);
        return '• ' + g + ': ' + (r.ready ? '✅ klaar' : r.bad ? '❌ niet goed genoeg' : r.unsure ? '⏳ winst, nog niet zeker' : '⏳ ' + r.pct + '%') + ' (' + r.n + ' trades' + (r.n ? ', ' + fmtS(r.pnl) + (r.gl > 0 || isFinite(r.pf) ? ', PF ' + (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') : '') : '') + ')';
      }).join('\n')
      + (o.runner ? '\n🏃 Runner-strategie (alleen oefenen, pakt grote stijgers): ' + line('vooruit', st.runner).replace(/^vooruit:?\s*/, '') + (st.runnerBest && st.runnerBest.ret > 0 ? ' · grootste run +' + Math.round(st.runnerBest.ret * 100) + '% (' + st.runnerBest.symbol + ')' : '')
          + (Object.keys(st.runnerBy).length ? '\n   per groep: ' + GROUPS.filter(g => st.runnerBy[g]).map(g => g + ' ' + st.runnerBy[g].n + 't ' + fmtS(st.runnerBy[g].pnl)).join(' · ') : '') : '')
      + (o.vp ? '\n📊 Volume-profiel (alleen oefenen): ' + vpShort() + ' (meer: /vp)' : '')
      + '\n' + goalText()
      + '\nInzet ' + cfg.sol + ' SOL per oefen-trade, kosten zijn er al af. Alles gaat naar het cloud-geheugen (/geheugen).';
  }
  // ---------- daily goal (practice): what today's forward practice would have made, in euro ----------
  function goalText(){
    const d = dayRoll(), goal = o.goalEur != null ? o.goalEur : 20, px = o.solEur ? Number(o.solEur()) || 0 : 0;
    const eur = x => (x >= 0 ? '+' : '−') + '€' + Math.abs(x * px).toFixed(2);
    if (!(goal > 0)) return '🎯 Dagdoel staat uit (DAILY_GOAL_EUR=0).';
    return '🎯 Dagdoel €' + goal + ' — oefenen vandaag (zoals de bot echt zou kopen): ' + (px > 0 ? eur(d.ok) + ' (' + Math.max(0, Math.round(d.ok * px / goal * 100)) + '%)' : fmtS(d.ok))
      + (o.vp ? ' · volume-profiel: ' + (px > 0 ? eur(d.vp) : fmtS(d.vp)) : '') + ' · nep-inzet ' + cfg.sol + ' SOL';
  }
  // ---------- volume profile: score per strategy, drift, why (not), signals ----------
  const vpName = k => (o.vpNames && o.vpNames[k]) || k;
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const pctS = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  function vpShort(){
    const k = Object.keys(st.vp);
    if (!k.length) return 'nog geen vooruit-trades';
    return k.map(s => vpName(s) + ' ' + st.vp[s].n + 't ' + fmtS(st.vp[s].pnl)).join(' · ');
  }
  function vpText(){
    if (!o.vp) return '📊 Volume-profiel staat uit (VP_PRACTICE=0).';
    const lines = ['📊 Volume-profiel — ALLEEN OEFENEN (nep-geld, echte charts, kosten en slippage eraf, alleen trades vanaf nu)'];
    const names = o.vpNames ? Object.keys(o.vpNames).filter(k => k !== 'dist') : Object.keys(st.vp);
    for (const s of names){
      const x = st.vp[s] || emptyStat(), r = st.vpRes[s] || [], t = tValue(x);
      lines.push('• ' + vpName(s) + ': ' + (x.n ? x.n + ' trades · ' + Math.round(x.wins / x.n * 100) + '% winst · ' + fmtS(x.pnl) + (x.gl > 0 ? ' · PF ' + (x.gw / x.gl).toFixed(2) : '') + ' · gem. ' + pctS(mean(r)) + (x.qn >= 10 ? ' · zekerheid t ' + (isFinite(t) ? t.toFixed(1) : '∞') : '') : 'nog geen trades'));
      if (r.length >= 30) lines.push('   laatste 20: gem. ' + pctS(mean(r.slice(-20))) + ' · daarvoor ' + pctS(mean(r.slice(0, -20))));
      const w = st.vpWhy[s];
      if (w){ const top = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 4); lines.push('   vandaag: ' + top.map(([k, n]) => k + ' ' + n + '×').join(' · ')); }
    }
    if (st.vpSig.length) lines.push('Laatste signalen: ' + st.vpSig.slice(0, 6).map(x => new Date(x.t * 1000).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }) + ' ' + vpName(x.s) + ' ' + x.sym).join(' · '));
    if (st.vpLast.length) lines.push('Laatste trades: ' + st.vpLast.slice(0, 6).map(x => vpName(x.s) + ' ' + x.sym + ' ' + pctS(x.ret) + ' (' + x.exit + ')').join(' · '));
    lines.push('Echt geld: nooit automatisch. Eerst bewijs (≥ 100 vooruit-trades per strategie met winst, PF ≥ 1,2 en zekerheid t ≥ 2) en daarna jouw akkoord.');
    return lines.join('\n');
  }
  /** a Telegram warning when a strategy's last 20 practice trades turn (or recover), or it reaches 100 trades — once per change */
  function vpAlerts(){
    const out = [];
    Object.entries(st.vpRes).forEach(([s, r]) => {
      const x = st.vp[s] || emptyStat();
      if (x.n >= 100 && !st.vpAlerted[s + ':100']){
        st.vpAlerted[s + ':100'] = 1;
        const pf = x.gl > 0 ? x.gw / x.gl : Infinity, t = tValue(x);
        out.push(vpName(s) + ': 100 vooruit-oefentrades → ' + fmtS(x.pnl) + ', PF ' + (isFinite(pf) ? pf.toFixed(2) : '∞') + (x.pnl > 0 && pf >= 1.2 && t >= 2 ? ' — sterk genoeg om met jou te bespreken (nog geen echt geld zonder jouw akkoord)' : ' — niet goed genoeg voor echt geld'));
      }
      if (r.length < 40) return;
      const a = mean(r.slice(-20)), b = mean(r.slice(0, -20)), now2 = a < 0 && b > 0 ? 'omlaag' : a > 0 && b < 0 ? 'omhoog' : '';
      if (now2 && st.vpAlerted[s] !== now2) out.push(vpName(s) + ': laatste 20 trades gem. ' + pctS(a) + ' tegen ' + pctS(b) + ' eerder — ' + (now2 === 'omlaag' ? 'werkt nu slechter (markt veranderd?)' : 'werkt nu beter'));
      st.vpAlerted[s] = now2;
    });
    return out.length ? '📊 Volume-profiel (oefenen):\n' + out.join('\n') : null;
  }
  function exportState(){
    return { coins: Object.fromEntries(Object.entries(st.coins).map(([m, c]) => [m, { symbol: c.symbol, fwdFrom: c.fwdFrom, mined: c.mined, open: c.open, liq: c.liq, entryOk: c.entryOk, entryFresh: c.entryFresh || {} }])),
      done: (pruneDone(), st.done), pickedAt: st.pickedAt, used: st.used, stats: st.stats, fwd: st.fwd, ok: st.ok, hunt: st.hunt, fresh: st.fresh, freshHunt: st.freshHunt, okBy: st.okBy, huntBy: st.huntBy, hist: st.hist, coinsSeen: st.coinsSeen, announced: st.announced, announcedHunt: st.announcedHunt, runner: st.runner, runnerBy: st.runnerBy, runnerBest: st.runnerBest,
      vp: st.vp, vpRes: st.vpRes, vpSig: st.vpSig.slice(0, 30), vpLast: st.vpLast.slice(0, 40), vpWhy: st.vpWhy, vpAlerted: st.vpAlerted, day: st.day };
  }
  function importState(s){
    if (!s || !s.coins) return;
    st = fresh();
    st.done = Array.isArray(s.done) ? s.done : []; st.pickedAt = Number(s.pickedAt) || 0; st.used = s.used || {};
    ['stats', 'fwd', 'ok', 'hunt', 'fresh', 'freshHunt'].forEach(k => { if (s[k]) st[k] = Object.assign(emptyStat(), s[k]); });
    ['okBy', 'huntBy'].forEach(k => { if (s[k] && typeof s[k] === 'object') GROUPS.forEach(g => { if (s[k][g]) st[k][g] = Object.assign(emptyStat(), s[k][g]); }); });
    if (s.runner) st.runner = Object.assign(emptyStat(), s.runner);
    if (s.runnerBy && typeof s.runnerBy === 'object') GROUPS.forEach(g => { if (s.runnerBy[g]) st.runnerBy[g] = Object.assign(emptyStat(), s.runnerBy[g]); });
    if (s.runnerBest && typeof s.runnerBest === 'object') st.runnerBest = { ret: Number(s.runnerBest.ret) || 0, symbol: String(s.runnerBest.symbol || ''), t: Number(s.runnerBest.t) || 0 };
    if (s.vp && typeof s.vp === 'object') Object.entries(s.vp).forEach(([k, v]) => { if (v && typeof v === 'object') st.vp[k] = Object.assign(emptyStat(), v); });
    if (s.vpRes && typeof s.vpRes === 'object') Object.entries(s.vpRes).forEach(([k, v]) => { if (Array.isArray(v)) st.vpRes[k] = v.filter(Number.isFinite).slice(-200); });
    ['vpSig', 'vpLast'].forEach(k => { if (Array.isArray(s[k])) st[k] = s[k].slice(0, k === 'vpSig' ? 30 : 40); });
    if (s.vpAlerted && typeof s.vpAlerted === 'object') st.vpAlerted = s.vpAlerted;
    if (s.day && s.day.key === nlDay()){ st.day = { key: s.day.key, ok: Number(s.day.ok) || 0, vp: Number(s.day.vp) || 0 }; if (s.vpWhy && typeof s.vpWhy === 'object') st.vpWhy = s.vpWhy; }
    st.hist = Number(s.hist) || 0; st.announced = s.announced || ''; st.announcedHunt = s.announcedHunt || ''; st.coinsSeen = Number(s.coinsSeen) || Object.keys(s.coins).length;
    // after a restart the bot may have missed candles: forward counting starts again from the next look (no gaps, no peeking)
    Object.entries(s.coins).forEach(([m, c]) => { st.coins[m] = { symbol: c.symbol, ctx: null, fwdFrom: null, mined: true, open: !!c.open, liq: c.liq || 0, entryOk: {} }; });
  }
  /** a message when there is news worth a Telegram ping (25/50/75 % progress, ready, or not good enough), else null */
  function milestone(){
    const r = readiness();
    const tag = r.ready ? 'klaar' : r.bad ? 'niet' : r.pct >= 75 ? '75' : r.pct >= 50 ? '50' : r.pct >= 25 ? '25' : '';
    const h = readiness('hunt'), htag = h.ready ? 'klaar' : h.bad ? 'niet' : '';
    if (htag && htag !== st.announcedHunt){ st.announcedHunt = htag; return '🎓 ' + huntReadyText(); }
    if (!tag || tag === st.announced) return null;
    st.announced = tag;
    return '🎓 ' + readyText();
  }
  return { cfg, round, pick, text, vpText, vpAlerts, goalText, vpNewLast: () => vpNew, day: () => dayRoll(), tradesSince: t => closedAt.filter(x => x >= t).length, readiness, readyText, huntReadyText, milestone, exportState, importState, get state(){ return st; } };
}

module.exports = { createScout, addStat, tValue, groupOf, GROUPS };
