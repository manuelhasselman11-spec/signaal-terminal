/**
 * Oefen-modus: de bot draait je strategie met nep-geld op coins waar je NIET in zit, met echte charts,
 * en stuurt elke afgesloten oefen-trade naar het cloud-geheugen. Zo leert hij veel sneller.
 *
 * Variables in Railway (standaard tussen haakjes):
 * PAPER_SCOUT (1)          0 = uit
 * PAPER_COINS (6)          op hoeveel coins tegelijk oefenen (elke coin kost 1 GeckoTerminal-verzoek per candle)
 * PAPER_SOL (0.05)         nep-inzet per oefen-trade
 * PAPER_MIN_LIQ (50000)    alleen coins met minstens zoveel liquiditeit ($)
 * PAPER_REPICK_H (6)       zo vaak nieuwe coins kiezen (coins met een open oefen-positie blijven)
 * PAPER_HISTORY (1)        bij een nieuwe coin ook de trades van de laatste ± 300 candles meetellen (snel leren)
 */
'use strict';

function createScout(o){
  const env = o.env || process.env;
  const n = (k, f) => { const v = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : f; };
  const cfg = {
    on: !['0', 'false'].includes(String(env.PAPER_SCOUT || '1').toLowerCase()),
    coins: Math.max(1, Math.min(15, Math.floor(n('PAPER_COINS', 6)))),
    sol: n('PAPER_SOL', 0.05),
    minLiq: n('PAPER_MIN_LIQ', 50000),
    repickH: Math.max(1, n('PAPER_REPICK_H', 6)),
    history: !['0', 'false'].includes(String(env.PAPER_HISTORY || '1').toLowerCase()),
    tf: o.timeframe || 'minute:5',
  };
  const now = o.now || (() => Date.now());
  let st = { coins: {}, done: [], pickedAt: 0, stats: { n: 0, wins: 0, pnl: 0 } };
  // coins[mint] = { symbol, ctx, since (sec), open (bool), liq }
  // done = keys "mint:entryTime" already sent to the memory (so nothing is counted twice)

  async function pick(){
    const list = (await o.candidates()) || [];
    const keep = Object.entries(st.coins).filter(([, c]) => c.open).map(([m]) => m);
    const chosen = keep.slice();
    for (const c of list){
      if (chosen.length >= cfg.coins) break;
      if (!chosen.includes(c.mint) && !(o.isActive && o.isActive(c.mint)) && (c.liq || 0) >= cfg.minLiq) chosen.push(c.mint);
    }
    const next = {};
    chosen.forEach(m => {
      const cand = list.find(c => c.mint === m) || {};
      next[m] = st.coins[m] || { symbol: cand.symbol || m.slice(0, 6), ctx: null, since: null, open: false, liq: cand.liq || 0 };
      if (cand.liq) next[m].liq = cand.liq;
    });
    st.coins = next; st.pickedAt = now();
    return Object.keys(next);
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
        const bars = await o.fetchOHLCV(c.ctx.network, c.ctx.poolAddress, unit, agg, mint);
        if (!bars || bars.length < 60) continue;
        const p = o.getParams();
        const res = o.runEngine(bars, p);
        const formingTime = bars[bars.length - 1].time;
        if (c.since == null) c.since = cfg.history ? 0 : formingTime;   // without history: only trades that start from now
        const trades = o.tradesFromEvents(res.events, p, bars[bars.length - 1].close);
        c.open = trades.some(t => t.open);
        for (const t of trades){
          if (t.open || t.exitTime == null || t.entryTime < c.since) continue;
          if (t.exitTime >= formingTime) continue;   // exit inside a candle that is still forming: wait until it closed
          const key = mint + ':' + t.entryTime;
          if (st.done.includes(key)) continue;
          st.done.push(key);
          const buy = res.events.find(e => e.type === 'BUY' && e.time === t.entryTime) || {};
          const exit = res.events.filter(e => e.time === t.exitTime && e.type !== 'BUY' && e.type !== 'TP1' && !(e.type === 'TP2' && e.frac != null)).pop() || {};
          const pnlSol = cfg.sol * t.ret;
          st.stats.n++; if (t.ret > 0) st.stats.wins++; st.stats.pnl += pnlSol;
          found++;
          if (o.record) await o.record({ kind: 'papier', mint, symbol: c.symbol, source: buy.src || 'EMA', liq: c.liq, spentSol: cfg.sol, pnlSol, pnlPct: t.ret * 100,
            exit: exit.type || 'EXIT', buyTime: t.entryTime * 1000, sellTime: t.exitTime * 1000, sig: 'papier:' + mint + ':' + t.entryTime });
        }
        if (st.done.length > 3000) st.done = st.done.slice(-2000);
      } catch (e){ console.error('oefen', c.symbol, e.message); if (!/geckoterminal/i.test(e.message)) c.ctx = null; }
    }
    return found;
  }

  function text(){
    if (!cfg.on) return '🎓 Oefen-modus staat uit (PAPER_SCOUT=0).';
    const coins = Object.values(st.coins);
    const s = st.stats;
    return '🎓 Oefen-modus (nep-geld, echte charts)\n'
      + (coins.length ? 'Oefent nu op: ' + coins.map(c => c.symbol + (c.open ? ' (in oefen-trade)' : '')).join(', ') : 'Kiest zo meteen coins…')
      + '\n' + (s.n ? 'Sinds start: ' + s.n + ' oefen-trades · ' + Math.round(s.wins / s.n * 100) + '% winst · ' + (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(4) + ' SOL (bij ' + cfg.sol + ' SOL per trade, na kosten)' : 'Nog geen afgesloten oefen-trades.')
      + '\nAlles gaat naar het cloud-geheugen (/geheugen).';
  }
  function exportState(){ return { coins: Object.fromEntries(Object.entries(st.coins).map(([m, c]) => [m, { symbol: c.symbol, since: c.since, open: c.open, liq: c.liq }])), done: st.done.slice(-2000), pickedAt: st.pickedAt, stats: st.stats }; }
  function importState(s){
    if (!s || !s.coins) return;
    st = { coins: {}, done: Array.isArray(s.done) ? s.done : [], pickedAt: Number(s.pickedAt) || 0, stats: s.stats || { n: 0, wins: 0, pnl: 0 } };
    Object.entries(s.coins).forEach(([m, c]) => { st.coins[m] = Object.assign({ ctx: null }, c); });
  }
  return { cfg, round, pick, text, exportState, importState, get state(){ return st; } };
}

module.exports = { createScout };
