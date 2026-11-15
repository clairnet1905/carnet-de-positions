// Cours de clôture des actions hors USA (ex. EL Essilor à Paris, WKL Wolters Kluwer à Amsterdam) via EODHD (offre gratuite :
// 20 requêtes par jour, fin de journée). Codes choisis dans l'app : Réglages › Cours automatiques (S.settings.eodSym, ex. { EL: 'EL.PA' }).
// Résultat dans le Gist du radar (« carnet-eu.json ») ; l'app les enregistre comme cours automatiques. La clé ne sort jamais du robot.
export const EU_FILE = 'carnet-eu.json';
const iso = t => new Date(t).toISOString().slice(0, 10);
const addD = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// Jours de fermeture d'Euronext : week-end, 1er janvier, Vendredi saint, lundi de Pâques, 1er mai, 25 et 26 décembre.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((8 * b + 13) / 25)) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4) - 7 * Math.floor((h + 11 * Math.floor(c / 4)) / 29)) % 7;
  const m = Math.floor((h + l + 114) / 31), d = ((h + l + 114) % 31) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function euroClosed(d) {
  const w = new Date(d + 'T12:00:00Z').getUTCDay(), y = +d.slice(0, 4), e = easter(y);
  return w === 0 || w === 6 || [`${y}-01-01`, addD(e, -2), addD(e, 1), `${y}-05-01`, `${y}-12-25`, `${y}-12-26`].includes(d);
}
// Positions ouvertes dont le cours se saisit hors Finnhub : cochées « cours manuel », avec un code EODHD,
// ou au moins 3 cours saisis à la main et aucun cours automatique.
export function manualOpen(S) {
  const st = S.settings || {}, manual = new Set((st.manualTickers || []).map(t => String(t).toUpperCase())), eod = st.eodSym || {};
  const rem = l => l.qty - (l.events || []).filter(x => x.type === 'sell').reduce((a, x) => a + x.qty, 0);
  const open = [...new Set((S.lots || []).filter(l => !l.demo && rem(l) > 1e-9).map(l => l.ticker))];
  const byHand = t => { const p = (S.prices || {})[t] || []; return p.length >= 3 && p.every(x => x.src !== 'auto'); };
  return open.filter(t => manual.has(String(t).toUpperCase()) || eod[t] || byHand(t));
}

// Renvoie { ok: { EL: [[date, close], …] }, err: { EL: message } } pour les 10 derniers jours.
export async function fetchEU(S, key, log) {
  const map = (S.settings && S.settings.eodSym) || {}, ok = {}, err = {};
  const from = iso(Date.now() - 14 * 864e5);
  for (const [t, sym] of Object.entries(map)) {
    if (!/^[A-Z0-9.\-]{1,20}$/i.test(sym || '')) continue;
    try {
      const r = await fetch(`https://eodhd.com/api/eod/${encodeURIComponent(sym)}?fmt=json&from=${from}&api_token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { err[t] = 'HTTP ' + r.status; continue; }
      const j = await r.json();
      const rows = Array.isArray(j) ? j.filter(x => x && /^\d{4}-\d\d-\d\d$/.test(x.date) && x.close > 0).map(x => [x.date, Math.round(x.close * 10000) / 10000]) : [];
      if (rows.length) ok[t] = rows; else err[t] = 'aucune donnée';
    } catch (e) { err[t] = e.message; }
  }
  log(`EODHD : ${Object.keys(ok).map(t => `${t} ${ok[t][ok[t].length - 1].join(' ')}`).join(', ') || 'rien'}${Object.keys(err).length ? ' · erreurs : ' + Object.entries(err).map(([t, m]) => t + ' (' + m + ')').join(', ') : ''}`);
  return { ok, err };
}
// Fusionne avec le fichier existant (30 dernières clôtures par action, actions retirées des réglages oubliées).
export function mergeEU(prev, got, S) {
  const keep = new Set(Object.keys((S.settings && S.settings.eodSym) || {})), px = {};
  for (const t of keep) {
    const m = new Map(((prev && prev.px && prev.px[t]) || []).map(x => [x[0], x[1]]));
    for (const [d, c] of got[t] || []) m.set(d, c);
    if (m.size) px[t] = [...m].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-30);
  }
  return { at: Date.now(), px };
}
