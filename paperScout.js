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
 * PAPER_COINS (15)         op hoeveel coins tegelijk oefenen (elke coin kost 1 GeckoTerminal-verzoek per candle)
 * PAPER_SOL (0.05)         nep-inzet per oefen-trade
 * PAPER_MIN_LIQ (50000)    alleen coins met minstens zoveel liquiditeit ($)
 * PAPER_REPICK_H (2)       zo vaak nieuwe coins kiezen (coins met een open oefen-positie blijven); steeds andere coins = meer leerstof
 * PAPER_HISTORY_DAYS (3)   bij een nieuwe coin zoveel dagen terug alle trades meetellen (0 = alleen vanaf nu)
 * PAPER_GOAL (200)         zoveel vooruit-oefentrades (die door de lessen heen kwamen) voordat de bot "klaar" zegt
 */
'use strict';

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
  const cfg = {
    on: !['0', 'false'].includes(String(env.PAPER_SCOUT || '1').toLowerCase()),
    coins: Math.max(1, Math.min(25, Math.floor(n('PAPER_COINS', 15)))),
    sol: n('PAPER_SOL', n('TRADE_AMOUNT_SOL', 0.05)),   // same stake as the real bot, so the fees in % match
    minLiq: n('PAPER_MIN_LIQ', 50000),
    repickH: Math.max(0.5, n('PAPER_REPICK_H', 2)),
    historyDays: Math.max(0, Math.min(14, n('PAPER_HISTORY_DAYS', env.PAPER_HISTORY === '0' ? 0 : 3))),
    goal: Math.max(20, Math.floor(n('PAPER_GOAL', 200))),
    minT: Math.max(0, n('PAPER_MIN_T', 2)),   // how sure (t-value) the practice profit must be before "ready"; 2 ≈ 95% sure it is not luck
    huntGoal: Math.max(20, Math.floor(n('PAPER_HUNT_GOAL', 100))),   // the hunter is pickier, so fewer trades are needed
    tf: o.timeframe || 'minute:5',
  };
  const now = o.now || (() => Date.now());
  const fresh = () => ({ coins: {}, done: [], pickedAt: 0, used: {}, stats: emptyStat(), fwd: emptyStat(), ok: emptyStat(), hunt: emptyStat(), hist: 0, coinsSeen: 0, announced: '', announcedHunt: '' });
  let st = fresh();
  // coins[mint] = { symbol, ctx, fwdFrom (sec: trades that start from here are "vooruit"), mined, open, liq, entryOk: {entryTime: bool} }
  // done = "mint:entryTime" already sent to the memory · used[mint] = when the coin was last picked (rotation)

  async function pick(){
    const list = (await o.candidates()) || [];
    const keep = Object.entries(st.coins).filter(([, c]) => c.open).map(([m]) => m);
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

  async function allowed(c, mint, source, patterns){
    if (!o.check) return true;
    try { return (await o.check({ kind: 'strategie', mint, source, liq: c.liq, patterns: patterns || [] })).ok !== false; } catch (_){ return true; }
  }

  /** one round over all practice coins; returns the number of finished practice trades */
  async function round(){
    if (!cfg.on) return 0;
    if (!Object.keys(st.coins).length || now() - st.pickedAt > cfg.repickH * 3600000){
      try { await pick(); } catch (e){ console.error('oefen: coins kiezen mislukt', e.message); }
    }
    const [unit, agg] = cfg.tf.split(':');
    let found = 0;
    for (const [mint, c] of Object.entries(st.coins)){
      if (o.isActive && o.isActive(mint)) continue;   // you trade this one for real now
      try {
        if (!c.ctx) c.ctx = await o.fetchBestPair(mint);
        let bars;
        if (!c.mined && cfg.historyDays > 0 && o.fetchHistory)
          bars = await o.fetchHistory(c.ctx.network, c.ctx.poolAddress, unit, agg, Math.floor(now() / 1000) - cfg.historyDays * 86400, mint);
        else bars = await o.fetchOHLCV(c.ctx.network, c.ctx.poolAddress, unit, agg, mint);
        if (!bars || bars.length < 60) continue;
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
            if (ok) addStat(st.ok, pnlSol);
            delete c.entryOk[t.entryTime];
            c.entryHunt = c.entryHunt || {};
            let hg = c.entryHunt[t.entryTime];
            if (hg == null && o.huntGate) hg = !!(await o.huntGate({ mint, liq: c.liq, src: buy.src || 'EMA', pats: buy.pats || [] }));
            if (hg && ok) addStat(st.hunt, pnlSol);
            delete c.entryHunt[t.entryTime];
          } else st.hist++;
          found++;
          if (o.record) await o.record({ kind: 'papier', mint, symbol: c.symbol, source: buy.src || 'EMA', liq: c.liq, spentSol: cfg.sol, pnlSol, pnlPct: t.ret * 100,
            exit: exit.why || exit.type || 'EXIT', buyTime: t.entryTime * 1000, sellTime: t.exitTime * 1000, sig: 'papier@' + cfg.tf + ':' + mint + ':' + t.entryTime, patterns: buy.pats || [] });
        }
        if (st.done.length > 6000) st.done = st.done.slice(-4000);
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
  function readiness(kind){
    const s = kind === 'hunt' ? st.hunt : st.ok, goal = kind === 'hunt' ? cfg.huntGoal : cfg.goal;
    const pf = s.gl > 0 ? s.gw / s.gl : (s.gw > 0 ? Infinity : 0);
    const win = s.n ? s.wins / s.n : 0;
    // also needs t ≥ 2: with a strategy that has NO edge, "PF ≥ 1.2 after 200 trades" still happened by luck ±1 in 7 times
    const t = tValue(s), sure = (s.qn || 0) >= 30 && t >= cfg.minT;
    const ready = s.n >= goal && s.pnl > 0 && pf >= 1.2 && sure;
    const bad = s.n >= goal && !ready && !(s.pnl > 0 && pf >= 1.2 && !sure);   // profitable but not yet sure enough = keep going, not "bad"
    const unsure = s.n >= goal && s.pnl > 0 && pf >= 1.2 && !sure;
    return { n: s.n, goal, pnl: s.pnl, pf, win, t, qn: s.qn || 0, unsure, ready, bad, pct: Math.min(unsure ? 99 : 100, Math.round(s.n / goal * 100)) };
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
      + (coins.length ? 'Oefent nu op ' + coins.length + ' coins: ' + coins.map(c => c.symbol + (c.open ? '*' : '')).join(', ') + (coins.some(c => c.open) ? ' (* = in oefen-trade)' : '') : 'Kiest zo meteen coins…')
      + '\nAl ' + st.coinsSeen + ' verschillende coins bekeken · nieuwe coins elke ' + cfg.repickH + ' uur'
      + '\n' + line('Alles', st.stats) + (st.hist ? ' (waarvan ' + st.hist + ' uit de historie)' : '')
      + '\n' + line('Vooruit (vanaf nu)', st.fwd)
      + '\n' + line('Vooruit, met geleerde lessen', st.ok)
      + '\n' + line('Vooruit, zoals de Jager koopt', st.hunt)
      + '\n' + readyText()
      + '\n' + huntReadyText()
      + '\nInzet ' + cfg.sol + ' SOL per oefen-trade, kosten zijn er al af. Alles gaat naar het cloud-geheugen (/geheugen).';
  }
  function exportState(){
    return { coins: Object.fromEntries(Object.entries(st.coins).map(([m, c]) => [m, { symbol: c.symbol, fwdFrom: c.fwdFrom, mined: c.mined, open: c.open, liq: c.liq, entryOk: c.entryOk }])),
      done: st.done.slice(-4000), pickedAt: st.pickedAt, used: st.used, stats: st.stats, fwd: st.fwd, ok: st.ok, hunt: st.hunt, hist: st.hist, coinsSeen: st.coinsSeen, announced: st.announced, announcedHunt: st.announcedHunt };
  }
  function importState(s){
    if (!s || !s.coins) return;
    st = fresh();
    st.done = Array.isArray(s.done) ? s.done : []; st.pickedAt = Number(s.pickedAt) || 0; st.used = s.used || {};
    ['stats', 'fwd', 'ok', 'hunt'].forEach(k => { if (s[k]) st[k] = Object.assign(emptyStat(), s[k]); });
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
  return { cfg, round, pick, text, readiness, readyText, huntReadyText, milestone, exportState, importState, get state(){ return st; } };
}

module.exports = { createScout, addStat, tValue };
