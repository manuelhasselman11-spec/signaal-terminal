'use strict';
/**
 * Auditor (13-10a) — an independent check of the bot's own numbers (§11).
 *
 * Independent on purpose: it imports NO strategy or execution code (not liveTrade.js, lab.js, worker.js), it can only READ
 * (one JSON-RPC method: getTransaction) and it never sees a key — only the wallet's public address.
 *
 *  auditLive(trade)   recomputes a live trade from the chain: the SOL change of the wallet in every transaction of the trade
 *                     (buy, partial sells, final sell) + the rent that came back, against what the bot logged.
 *                     Checks BUY/SELL direction (tokens in on the buy, out on the sells) and the stake against the cage.
 *                     GEVERIFIEERD (≤ 0,5 % of the stake apart) · AFWIJKING (> 0,5 %) · ALARM (> 1 % → the worker pauses buying)
 *                     · ONGEVERIFIEERD (no usable signatures, or the chain did not answer).
 *  auditPaper(list)   data checks on paper trades: duplicates, P&L = size × return − fixed fees, impossible returns,
 *                     time order, size inside the cage. Paper is NEVER reported as live profit.
 *
 * @typedef {{ mint:string, sigs?:string[], sig?:string, wallet?:string, spentSol:number, gotSol:number, pnlSol:number, rentBack?:number, stakeSol?:number, time?:number, symbol?:string }} LiveTrade
 */

/**
 * @param {{ rpc:(method:string, params:any[])=>Promise<any>, maxStakeSol?:number, okPct?:number, alarmPct?:number }} o
 */
function createAuditor(o){
  const okPct = o.okPct != null ? o.okPct : 0.5, alarmPct = o.alarmPct != null ? o.alarmPct : 1;
  const results = [];   // last audits (for /audit and the hourly report)

  /** SOL (lamports) and token (raw units) change of `wallet` in one transaction */
  async function txDelta(sig, wallet, mint){
    const tx = await o.rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || !tx.meta) return { ok: false, err: 'transactie niet gevonden' };
    if (tx.meta.err) return { ok: false, err: 'transactie mislukt op de chain', failed: true, fee: tx.meta.fee || 0 };
    const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys || []).map(k => typeof k === 'string' ? k : k.pubkey);
    const idx = keys.indexOf(wallet);
    if (idx < 0) return { ok: false, err: 'wallet zit niet in deze transactie' };
    const sol = (tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0);
    const amt = list => (list || []).filter(b => b.mint === mint && b.owner === wallet).reduce((a, b) => a + BigInt(b.uiTokenAmount && b.uiTokenAmount.amount || '0'), 0n);
    const tok = amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances);
    return { ok: true, sol, tok, fee: tx.meta.fee || 0 };
  }

  /** @param {LiveTrade} t */
  async function auditLive(t){
    const notes = [], sigs = (t.sigs && t.sigs.length ? t.sigs : [t.sig]).filter(s => typeof s === 'string' && s.length > 40 && !s.startsWith('('));
    const r = { mint: t.mint, symbol: t.symbol, time: t.time, logPnl: t.pnlSol, chainPnl: null, diffPct: null, status: 'ONGEVERIFIEERD', notes, sigs };
    if (!t.wallet) notes.push('geen wallet-adres in het logboek');
    if (!sigs.length) notes.push('geen bruikbare signatures (oude trade of "poging kwam toch aan")');
    if (!t.wallet || !sigs.length){ results.unshift(r); return r; }
    let lamports = 0, ok = true, feeLam = 0;
    for (let k = 0; k < sigs.length; k++){
      let d; try { d = await txDelta(sigs[k], t.wallet, t.mint); } catch (e){ d = { ok: false, err: e.message }; }
      if (!d.ok){ ok = false; notes.push(sigs[k].slice(0, 8) + '…: ' + d.err); if (d.failed) lamports -= d.fee; continue; }
      lamports += d.sol; feeLam += d.fee || 0;
      if (k === 0 && !(d.tok > 0n && d.sol < 0)) notes.push('BUY-richting klopt niet (tokens ' + d.tok + ', SOL ' + d.sol + ')');
      if (k > 0 && !(d.tok < 0n && d.sol > 0)) notes.push('SELL-richting klopt niet bij ' + sigs[k].slice(0, 8));
    }
    if (!ok){ results.unshift(r); return r; }
    const rent = Number(t.rentBack) || 0;                       // the close-account transaction is not in the list: rent comes from the log
    r.chainPnl = lamports / 1e9 + rent;
    if (rent) notes.push('teruggekregen rent (' + rent.toFixed(5) + ' SOL) komt uit het logboek, niet van de chain');
    const stake = Number(t.stakeSol) || Number(t.spentSol) || 0.01;
    r.diffPct = Math.abs(r.chainPnl - t.pnlSol) / stake * 100;
    r.feeSol = feeLam / 1e9; r.feePct = r.feeSol / stake * 100;   // network + priority fees paid in this trade's transactions (§4.5)
    r.status = r.diffPct <= okPct ? 'GEVERIFIEERD' : r.diffPct > alarmPct ? 'ALARM' : 'AFWIJKING';
    if (o.maxStakeSol && stake > o.maxStakeSol * 1.0001) { notes.push('inzet ' + stake + ' SOL boven het maximum ' + o.maxStakeSol); r.status = 'ALARM'; }
    if (notes.some(n => /richting klopt niet/.test(n)) && r.status === 'GEVERIFIEERD') r.status = 'AFWIJKING';
    results.unshift(r); if (results.length > 200) results.pop();
    return r;
  }

  /** checks on paper trades (lab / practice): returns { n, problems:[{why, item}] } */
  function auditPaper(list, opt){
    const q = Object.assign({ feeSol: 0.0004, coinMaxSol: 0.08 }, opt || {}), seen = new Set(), problems = [];
    for (const x of list || []){
      const key = x.strat + ':' + (x.mint || x.coin) + ':' + x.t;
      if (seen.has(key)) problems.push({ why: 'dubbele trade', item: key }); seen.add(key);
      if (!Number.isFinite(x.ret) || x.ret < -1.0001) problems.push({ why: 'onmogelijk rendement ' + x.ret, item: key });
      if (x.exitTime != null && x.exitTime < x.t) problems.push({ why: 'verkoop vóór koop', item: key });
      const r = x.retP != null ? x.retP : x.ret;   // retP = after proportional costs; the fixed fee must be in the SOL result exactly once
      if (x.size != null && x.pnlSol != null && Math.abs(x.pnlSol - (x.size * r - q.feeSol)) > 1e-9) problems.push({ why: 'P&L klopt niet met grootte × rendement − fees (vaste fees niet precies één keer)', item: key });
      if (x.size > q.coinMaxSol * 1.0001) problems.push({ why: 'grootte boven het maximum per coin', item: key });
    }
    return { n: (list || []).length, problems };
  }

  function text(){
    if (!results.length) return '🔎 Auditor: nog geen live trades om te controleren (live handelen staat uit — paper wordt nooit als live-winst geteld).';
    const c = s => results.filter(r => r.status === s).length;
    const fs = results.filter(r => r.feePct != null), feeAvg = fs.length ? fs.reduce((a, r) => a + r.feePct, 0) / fs.length : null;
    return '🔎 Auditor (onafhankelijk, leest alleen de chain): ' + results.length + ' live trades · ✅ ' + c('GEVERIFIEERD') + ' geverifieerd · ⚠️ ' + c('AFWIJKING') + ' afwijking · 🚨 ' + c('ALARM') + ' alarm · ❔ ' + c('ONGEVERIFIEERD') + ' niet te controleren' + (feeAvg != null ? ' · netwerk + priority fees gem. ' + feeAvg.toFixed(2) + '% van de inzet (on-chain gemeten)' : '') + '\n'
      + results.slice(0, 8).map(r => (r.status === 'GEVERIFIEERD' ? '✅' : r.status === 'ALARM' ? '🚨' : r.status === 'AFWIJKING' ? '⚠️' : '❔') + ' ' + (r.symbol || r.mint.slice(0, 6)) + ': log ' + Number(r.logPnl).toFixed(5) + (r.chainPnl != null ? ' · chain ' + r.chainPnl.toFixed(5) + ' (' + r.diffPct.toFixed(2) + '%) · fees ' + r.feePct.toFixed(2) + '% van de inzet' : '') + (r.notes.length ? ' · ' + r.notes[0] : '')).join('\n');
  }
  return { auditLive, auditPaper, txDelta, text, get results(){ return results; } };
}

/** read-only JSON-RPC client (the URL may hold an API key: it is never logged) */
function rpcClient(url, fetchFn){
  const f = fetchFn || fetch;
  return async (method, params) => {
    if (!/^(getTransaction|getBalance|getSignaturesForAddress)$/.test(method)) throw new Error('auditor mag alleen lezen');
    const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error('RPC: ' + (j.error.message || j.error.code));
    return j.result;
  };
}

module.exports = { createAuditor, rpcClient };
