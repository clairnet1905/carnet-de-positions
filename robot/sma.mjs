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
// Barre : [date, clôture] ou [date, clôture, ouverture, haut, bas] (bougies, pour le graphique de l'app).
// xk : nombre de dernières séances dont on garde ouverture, haut et bas, en écarts à la clôture (dix-millièmes) : x = [o, h, l, o, h, l, …].
export function pack(h, xk = 0) {
  const o = [], c = [];
  let prev = null;
  for (const [d, x] of h.bars) { o.push(prev ? days(prev, d) : 0); c.push(Math.round(x * 1e4) / 1e4); prev = d; }
  const p = { s: h.bars.length ? h.bars[0][0] : '', o, c, n: h.n, full: h.full || 0 };
  if (xk > 0) {
    const t = h.bars.slice(-xk), x = [];
    for (const b of t) if (b.length >= 5 && b[1] > 0) x.push(...[b[2], b[3], b[4]].map(v => Math.round((v / b[1] - 1) * 1e4))); else x.push(null, null, null);
    if (x.some(v => v != null)) { p.x = x; p.xn = t.length; }
  }
  return p;
}
export function unpack(p) {
  const bars = []; let d = p.s;
  for (let i = 0; i < p.c.length; i++) { d = i ? addDays(d, p.o[i]) : d; bars.push([d, p.c[i]]); }
  if (p.x && p.xn) for (let j = 0, i0 = bars.length - p.xn; j < p.xn; j++) {
    const b = bars[i0 + j], q = p.x.slice(3 * j, 3 * j + 3); if (!b || q[0] == null) continue;
    b.push(...q.map(v => b[1] * (1 + v / 1e4)));
  }
  return { bars, n: p.n, full: p.full || 0, last: bars.length ? bars[bars.length - 1][0] : '' };
}

// ----- Dividendes manquants dans les cours ajustés -----
// Les dividendes connus de la source se lisent dans le rapport cours ajusté / cours brut : il baisse d'un cran à chaque ex-date.
// Un payeur régulier (mensuel à semestriel) dont il manque un ou deux versements entre deux versements connus
// reçoit des dividendes estimés : date au milieu de l'écart, montant du versement connu le plus proche (comme TradingView avec ADJ).
// Renvoie [[ex-date, facteur, montant estimé]] ; les cours ajustés antérieurs à l'ex-date sont à multiplier par le facteur.
function divEvents(raw, adj) {
  const A = new Map(adj), pts = raw.filter(b => A.has(b[0]) && b[1] > 0 && A.get(b[0]) > 0).map(b => [b[0], b[1], A.get(b[0]) / b[1]]);
  const ev = [];
  for (let i = 1; i < pts.length; i++) {
    const f = pts[i - 1][2] / pts[i][2];
    if (f < 0.9995 && f > 0.8) ev.push({ d: pts[i][0], amt: (1 - f) * pts[i - 1][1] });
  }
  if (ev.length < 3) return null;
  const gaps = ev.slice(1).map((e, i) => days(ev[i].d, e.d)), med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
  return med < 25 || med > 200 ? null : { pts, ev, gaps, med };
}
// Dernier versement en retard (pas de versement connu après lui) : impossible de savoir si l'entreprise a cessé de payer,
// donc rien n'est corrigé : [dernier versement connu, versement attendu vers], à vérifier à la main.
export function divLate(raw, adj) {
  const E = divEvents(raw, adj); if (!E) return null;
  const last = E.ev[E.ev.length - 1].d, g = days(last, E.pts[E.pts.length - 1][0]);
  return g >= 1.6 * E.med && g <= 4 * E.med ? [last, addDays(last, E.med)] : null;
}
export function divGaps(raw, adj) {
  const E = divEvents(raw, adj); if (!E) return [];
  const { pts, ev, gaps, med } = E, out = [];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i], k = Math.round(g / med) - 1;
    if (g < 1.6 * med || k < 1 || k > 3) continue;
    for (let j = 1; j <= k; j++) {
      const target = addDays(ev[i].d, Math.round(g * j / (k + 1)));
      const at = pts.findIndex(p => p[0] >= target); if (at < 1) continue;
      const amt = Math.round((j / (k + 1) <= 0.5 ? ev[i].amt : ev[i + 1].amt) * 100) / 100;   // montant du versement connu le plus proche
      out.push([pts[at][0], 1 - amt / pts[at - 1][1], amt]);
    }
  }
  return out;
}
// Cours ajustés corrigés des dividendes estimés.
export function fixBars(bars, fx) {
  if (!fx || !fx.length) return bars;
  return bars.map(b => { let k = 1; for (const x of fx) if (b[0] < x[0]) k *= x[1]; return [b[0], ...b.slice(1).map(v => v * k)]; });
}
