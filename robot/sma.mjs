// Calcul des SMA du radar, identique à celui de l'application (carnet/app.js : groupBars, analyzeRaw, radarAlerts).
// Sans dépendance : utilisé par le robot GitHub Actions (Node) et testable dans un navigateur.

export const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const wdOf = d => new Date(d + 'T12:00:00Z').getUTCDay();
export function nextWeekday(d) { do { d = addDays(d, 1); } while (wdOf(d) === 0 || wdOf(d) === 6); return d; }
export function prevWeekday(d) { do { d = addDays(d, -1); } while (wdOf(d) === 0 || wdOf(d) === 6); return d; }
export const weekKey = d => addDays(d, -((wdOf(d) + 6) % 7));
export const periodKey = (tf, d) => tf === 'M' ? d.slice(0, 7) : tf === 'W' ? weekKey(d) : d;
export const symOf = w => (w.sym || w.ticker).toUpperCase();

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function nyParts(ms) {
  const p = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
// Dernière séance terminée à New York (16 h 05 passé un jour de semaine ; jours fériés non gérés).
export function lastSession(ms) {
  const n = nyParts(ms); let d = n.date;
  if (!(wdOf(d) >= 1 && wdOf(d) <= 5 && n.min >= 965)) d = prevWeekday(d);
  return d;
}
// Clôtures journalières nécessaires pour une SMA, avec une marge pour retrouver le dernier croisement.
export function barsNeeded(w) { const n = w.period + 25; return Math.min(5000, w.tf === 'M' ? n * 22 : w.tf === 'W' ? n * 5 : n); }

export function groupBars(daily, tf) {
  if (tf === 'D') return daily.map(([d, c]) => ({ k: d, d, c }));
  const out = [];
  for (const [d, c] of daily) {
    const k = periodKey(tf, d), last = out[out.length - 1];
    if (last && last.k === k) { last.c = c; last.d = d; } else out.push({ k, d, c });
  }
  return out;
}
// Bougies terminées seulement (la semaine ou le mois en cours est exclu), croisements les plus récents d'abord.
export function analyze(w, bars, ls, nearPct) {
  if (!bars || !bars.length) return null;
  const all = groupBars(bars, w.tf);
  let done = all;
  const L = all[all.length - 1];
  if (w.tf !== 'D' && L.k === periodKey(w.tf, ls) && periodKey(w.tf, nextWeekday(ls)) === L.k) done = all.slice(0, -1);
  const n = w.period, c = done.map(b => b.c);
  if (c.length < n + 1) return { short: true, have: c.length };
  const pre = [0]; for (const x of c) pre.push(pre[pre.length - 1] + x);
  const sma = i => (pre[i + 1] - pre[i + 1 - n]) / n;
  const i = c.length - 1, s1 = sma(i), dist = (c[i] - s1) / s1 * 100;
  const crosses = [];
  for (let k = i; k >= n && crosses.length < 5; k--) { const sk = sma(k), a = c[k] > sk, b = c[k - 1] > sma(k - 1); if (a !== b) crosses.push({ dir: a ? 'up' : 'down', date: done[k].d, close: c[k], sma: sk }); }
  return { lastClose: c[i], lastDate: done[i].d, sma: s1, dist, above: c[i] > s1, near: Math.abs(dist) <= (nearPct || 2), crosses, lastCross: crosses[0] || null };
}

// « Vu » dans l'application : même règle de tolérance que l'app (SEEN_TOL).
const SEEN_TOL = { D: 4, W: 10, M: 35 };
export function seenIndex(seen) {
  const m = new Map();
  for (const k in seen || {}) { const i = k.lastIndexOf('|'), p = k.slice(0, i); if (!m.has(p)) m.set(p, []); m.get(p).push(k.slice(i + 1)); }
  return m;
}
// Signaux à notifier : croisements des derniers jours (et « proche » si demandé), ni déjà notifiés ni déjà vus dans l'app.
export function signals(S, hist, ls, notified, opts = {}) {
  const idx = seenIndex(S.seen), out = [], since = addDays(ls, -(opts.recentDays || 5));
  for (const w of S.watch || []) {
    const h = hist[symOf(w)]; if (!h) continue;
    const a = analyze(w, h.bars, ls, S.settings && S.settings.nearPct); if (!a || a.short) continue;
    const id = `${w.id}|${w.tf}${w.period}`;
    const x = a.crosses[0];
    if (x && x.date >= since) {
      const pre = `${id}|${x.dir}`, key = `${pre}|${periodKey(w.tf, x.date)}`, pk = periodKey(w.tf, x.date);
      const seen = (idx.get(pre) || []).some(d => periodKey(w.tf, d) === pk || Math.abs(days(d, x.date)) <= SEEN_TOL[w.tf]);
      if (!notified[key] && !seen) out.push({ key, w, kind: x.dir, date: x.date, close: x.close, sma: x.sma });
    }
    if (opts.near && a.near) {
      const key = `${id}|near|${a.lastCross ? a.lastCross.date : ''}`;
      const since2 = a.lastCross ? a.lastCross.date : '';
      const seen = (idx.get(`${id}|near`) || []).some(d => d >= since2 && days(d, ls) <= 15);
      if (!notified[key] && !seen) out.push({ key, w, kind: 'near', date: a.lastDate, close: a.lastClose, sma: a.sma, dist: a.dist });
    }
  }
  return out;
}
const TF = { D: 'J', W: 'S', M: 'M' };
const usd = x => x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
export function message(sig, ls) {
  const order = { up: 0, down: 1, near: 2 };
  const s = [...sig].sort((a, b) => order[a.kind] - order[b.kind] || (a.w.ticker < b.w.ticker ? -1 : 1));
  const line = x => `${x.w.ticker} ${x.kind === 'up' ? '↑' : x.kind === 'down' ? '↓' : '≈'} SMA ${x.w.period} ${TF[x.w.tf]} (${usd(x.close)})`;
  const up = s.filter(x => x.kind === 'up').length, dn = s.filter(x => x.kind === 'down').length, nr = s.filter(x => x.kind === 'near').length;
  const head = [up && `${up} au-dessus`, dn && `${dn} en dessous`, nr && `${nr} proche(s)`].filter(Boolean).join(' · ');
  const shown = s.slice(0, 6).map(line);
  if (s.length > 6) shown.push(`+ ${s.length - 6} autre(s) dans l’app`);
  return { title: `Radar SMA · ${head}`, body: shown.join('\n'), tag: 'radar-' + ls, url: './#radar' };
}

// Historique compact pour le Gist : dates en écarts de jours, clôtures arrondies.
export function pack(h) {
  const o = [], c = [];
  let prev = null;
  for (const [d, x] of h.bars) { o.push(prev ? days(prev, d) : 0); c.push(Math.round(x * 1e4) / 1e4); prev = d; }
  return { s: h.bars.length ? h.bars[0][0] : '', o, c, n: h.n, full: h.full || 0 };
}
export function unpack(p) {
  const bars = []; let d = p.s;
  for (let i = 0; i < p.c.length; i++) { d = i ? addDays(d, p.o[i]) : d; bars.push([d, p.c[i]]); }
  return { bars, n: p.n, full: p.full || 0, last: bars.length ? bars[bars.length - 1][0] : '' };
}
