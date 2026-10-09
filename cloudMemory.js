/**
 * Cloud-geheugen (Supabase) — beide bots schrijven elke afgesloten trade weg en leren samen van fouten.
 *
 * Variables in Railway:
 * SUPABASE_URL=            https://<jouw-project>.supabase.co
 * SUPABASE_KEY=            de GEHEIME sleutel (Project Settings → API Keys → "secret" / "service_role"). Nooit delen, alleen in Railway.
 * BOT_NAME (bot)           naam van deze bot in de tabel, bv. bot1 / bot2
 * CLOUD_LEARN (1)          0 = alleen opslaan, niet blokkeren
 * CLOUD_MIN_N (5)          een coin/wallet moet minstens zoveel trades hebben voordat de bot er een les uit trekt
 *                          (algemene patronen zoals "Dip-signalen" of "uur 0-4" pas na 2× zoveel)
 * CLOUD_MAX_WINRATE (40)   les "niet meer doen" als winstkans onder dit % ligt EN het totaal verlies is
 * CLOUD_LESSON_DAYS (14)   een les telt zo lang na de laatste trade; daarna krijgt het patroon een nieuwe kans
 * CLOUD_KEEP_BAD_DAYS (7)  verliezende trades zo lang bewaren, daarna wissen (de les blijft). Goede trades blijven altijd.
 */
'use strict';

function hourNL(t){
  return Number(new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(new Date(t || Date.now()))) % 24;
}
function liqBucket(liq){
  liq = Number(liq) || 0;
  if (!liq) return null;
  return liq < 50000 ? '<50K' : liq < 250000 ? '50K-250K' : liq < 1000000 ? '250K-1M' : '>1M';
}
/** Which patterns does a trade belong to? Each pattern gets its own win/loss counter. */
function keysFor(c){
  const k = [];
  if (c.kind !== 'nep-kopie' && c.mint) k.push('coin:' + c.mint);
  if (c.kind === 'strategie' || c.kind === 'papier'){
    if (c.source) k.push('src:' + c.source);
    if (c.hour != null) { const b = Math.floor(c.hour / 4) * 4; k.push('uur:' + b + '-' + (b + 4)); }
    const lb = liqBucket(c.liq); if (lb) k.push('liq:' + lb);
  } else if (c.source) k.push('wallet:' + c.source);
  if (c.kind) k.push('soort:' + (c.kind === 'papier' || c.kind === 'nep-kopie' ? 'oefen' : 'echt'));   // only for the totals, never blocks
  return k;
}
const GENERAL = key => /^(src|uur|liq):/.test(key);
function describeKey(key, sym){
  const [t, v] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (t === 'coin') return 'coin ' + (sym && sym[v] || v.slice(0, 4) + '…' + v.slice(-4));
  if (t === 'wallet') return 'wallet ' + v.slice(0, 4) + '…' + v.slice(-4);
  if (t === 'src') return v.split('+').map(x => ({ REV: 'Dip', BRK: 'Breakout', CONT: 'Herinstap' })[x] || x).join('+') + '-signalen';
  if (t === 'uur') return 'kopen tussen ' + v.replace('-', ':00 en ') + ':00';
  if (t === 'liq') return 'coins met liquiditeit ' + v;
  return key;
}

function createCloud(o = {}){
  const env = o.env || process.env;
  const n = (k, f) => { const v = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(v) ? v : f; };
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(env.SUPABASE_KEY || '').trim();
  const cfg = {
    on: /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url) && key.length > 20,
    bot: String(env.BOT_NAME || 'bot').slice(0, 20),
    learn: !['0', 'false'].includes(String(env.CLOUD_LEARN || '1').toLowerCase()),
    minN: Math.max(2, Math.floor(n('CLOUD_MIN_N', 5))),
    maxWin: n('CLOUD_MAX_WINRATE', 40) / 100,
    lessonDays: n('CLOUD_LESSON_DAYS', 14),
    keepBadDays: Math.max(1, n('CLOUD_KEEP_BAD_DAYS', 7)),
  };
  const fetchFn = o.fetch || ((...a) => fetch(...a));
  const now = o.now || (() => Date.now());
  let lessons = new Map(), loadedAt = 0, warned = false, symbols = {};
  const stats = { saved: 0, blocked: 0, errors: 0 };

  async function api(path, opts = {}){
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;   // old-style service_role JWT
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetchFn(url + '/rest/v1/' + path, Object.assign({ headers: Object.assign(headers, opts.headers || {}), signal: ctrl.signal }, opts.body ? { method: opts.method || 'POST', body: JSON.stringify(opts.body) } : { method: opts.method || 'GET' }));
      const text = await res.text();
      if (!res.ok){
        let msg = text.slice(0, 160);
        if (res.status === 404 || /does not exist|Could not find/i.test(text)) msg = 'tabellen bestaan nog niet — plak supabase-setup.sql in de SQL Editor (' + msg + ')';
        if (res.status === 401 || res.status === 403) msg = 'sleutel geweigerd — gebruik de SECRET/service_role sleutel (' + msg + ')';
        throw new Error('Supabase ' + res.status + ': ' + msg);
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  function fail(e, notify){
    stats.errors++;
    console.error('cloud-geheugen:', e.message);
    if (!warned && notify){ warned = true; notify('⚠️ Cloud-geheugen (Supabase) werkt niet: ' + e.message.slice(0, 200) + '\nDe bot handelt gewoon door, alleen zonder cloud-geheugen.'); }
  }

  async function refresh(force){
    if (!cfg.on) return;
    if (!force && now() - loadedAt < 10 * 60000) return;
    const rows = await api('lessons?select=key,n,wins,pnl_sol,last_at&order=last_at.desc&limit=5000');
    lessons = new Map((rows || []).map(r => [r.key, { n: Number(r.n) || 0, wins: Number(r.wins) || 0, pnl: Number(r.pnl_sol) || 0, last: Date.parse(r.last_at) || now() }]));
    loadedAt = now();
  }

  /** Is this a pattern the bots have lost money on again and again? */
  function badLesson(k){
    if (k.startsWith('soort:')) return null;
    const l = lessons.get(k);
    if (!l) return null;
    const need = GENERAL(k) ? cfg.minN * 2 : cfg.minN;
    if (l.n < need || l.pnl >= 0 || l.wins / l.n >= cfg.maxWin) return null;
    if (now() - l.last > cfg.lessonDays * 86400000) return null;   // old lesson: give it a new chance
    return l;
  }

  /** Before a buy: { ok:true } or { ok:false, reason } */
  async function check(c, notify){
    if (!cfg.on || !cfg.learn) return { ok: true };
    try { await refresh(false); } catch (e){ fail(e, notify); }
    for (const k of keysFor(Object.assign({ hour: hourNL(now()) }, c))){
      const l = badLesson(k);
      if (l){
        stats.blocked++;
        return { ok: false, key: k, reason: describeKey(k, symbols) + ' verloor ' + (l.n - l.wins) + ' van ' + l.n + ' trades (' + l.pnl.toFixed(4) + ' SOL)' };
      }
    }
    return { ok: true };
  }

  /** After a trade closed: store it and learn from it */
  async function record(t, notify){
    if (!cfg.on) return false;
    const pnl = Number(t.pnlSol) || 0, spent = Number(t.spentSol) || 0;
    const row = {
      bot: cfg.bot, kind: t.kind || 'strategie', mint: t.mint || null, symbol: t.symbol || null, source: t.source || null,
      hour: t.buyTime ? hourNL(t.buyTime) : null, liq_usd: t.liq != null ? Math.round(t.liq) : null,
      spent_sol: spent, pnl_sol: pnl, pnl_pct: t.pnlPct != null ? t.pnlPct : (spent > 0 ? pnl / spent * 100 : null),
      exit: t.exit || null, held_min: t.buyTime ? Math.round(((t.sellTime || now()) - t.buyTime) / 60000) : null, sig: t.sig && !String(t.sig).startsWith('(') ? t.sig : null,
      good: pnl > 0,
    };
    if (t.mint && t.symbol) symbols[t.mint] = t.symbol;
    const ks = keysFor({ kind: row.kind, mint: row.mint, source: row.source, hour: row.hour, liq: row.liq_usd });
    const learnLocal = () => ks.forEach(k => { const l = lessons.get(k) || { n: 0, wins: 0, pnl: 0, last: now() }; l.n++; if (pnl > 0) l.wins++; l.pnl += pnl; l.last = now(); lessons.set(k, l); });
    try {
      try { await api('trades', { body: row, headers: { Prefer: 'return=minimal' } }); }
      catch (e){ if (/Supabase 409/.test(e.message)) return 'dup'; throw e; }   // the other bot already stored this practice trade
      learnLocal();
      if (ks.length) await api('rpc/learn', { body: { p_keys: ks, p_win: pnl > 0, p_pnl: pnl } });
      stats.saved++; warned = false;
      return true;
    } catch (e){ learnLocal(); fail(e, notify); return false; }   // Supabase down: at least this bot learns
  }

  async function cleanup(notify){
    if (!cfg.on) return 0;
    try { const r = await api('rpc/forget_bad', { body: { p_days: cfg.keepBadDays } }); return Number(r) || 0; }
    catch (e){ fail(e, notify); return 0; }
  }

  async function text(){
    if (!cfg.on) return '☁️ Cloud-geheugen staat uit. Zet SUPABASE_URL en SUPABASE_KEY in Railway (zie de uitleg).';
    const lines = ['☁️ Cloud-geheugen (gedeeld door je bots)'];
    try { await refresh(true); } catch (e){ return '☁️ Cloud-geheugen: ' + e.message; }
    const all = [...lessons.entries()];
    for (const [k, label] of [['soort:echt', 'echte trades'], ['soort:oefen', 'oefen-trades (nep-geld)']]){
      const l = lessons.get(k);
      if (l && l.n) lines.push('Geleerd van ' + l.n + ' ' + label + ' · ' + Math.round(l.wins / l.n * 100) + '% winst · ' + (l.pnl >= 0 ? '+' : '') + l.pnl.toFixed(4) + ' SOL');
    }
    const bad = all.map(([k]) => [k, badLesson(k)]).filter(x => x[1]).sort((a, b) => a[1].pnl - b[1].pnl).slice(0, 6);
    lines.push(bad.length ? '🚫 Dit doet de bot nu NIET meer (fouten):\n' + bad.map(([k, l]) => '• ' + describeKey(k, symbols) + ': ' + (l.n - l.wins) + '/' + l.n + ' verlies, ' + l.pnl.toFixed(4) + ' SOL').join('\n')
      : '🚫 Nog geen fouten die vaak genoeg terugkwamen (minstens ' + cfg.minN + ' trades per coin/wallet).');
    const good = all.filter(([k, l]) => !k.startsWith('soort:') && l.n >= 3 && l.pnl > 0).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 5);
    if (good.length) lines.push('✅ Werkt goed:\n' + good.map(([k, l]) => '• ' + describeKey(k, symbols) + ': ' + l.wins + '/' + l.n + ' winst, +' + l.pnl.toFixed(4) + ' SOL').join('\n'));
    try {
      const best = await api('trades?select=symbol,pnl_sol,kind,created_at&good=eq.true&order=pnl_sol.desc&limit=5');
      if (best && best.length) lines.push('🏆 Beste bewaarde trades:\n' + best.map(b => '• ' + (b.symbol || '?') + ' +' + Number(b.pnl_sol).toFixed(4) + ' SOL (' + b.kind + ', ' + String(b.created_at).slice(0, 10) + ')').join('\n'));
    } catch (_){}
    lines.push('Verliezende trades worden na ' + cfg.keepBadDays + ' dagen gewist, de les blijft ' + cfg.lessonDays + ' dagen gelden.');
    return lines.join('\n');
  }

  return { cfg, check, record, refresh, cleanup, text, stats, keysFor, get lessons(){ return lessons; } };
}

module.exports = { createCloud, keysFor, hourNL, liqBucket };
