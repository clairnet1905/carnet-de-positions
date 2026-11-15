// Rappel de la clôture européenne (17 h 30 à Paris), lancé par GitHub Actions (voir .github/workflows/rappel.yml).
// Lit vos données synchronisées (Gist « carnet-positions.json ») et envoie une notification ntfy s'il manque le cours du jour
// d'une position ouverte en saisie manuelle. Rien si tout est saisi, ni le week-end, ni les jours de fermeture d'Euronext.
// Le nom du canal ntfy n'est jamais écrit dans le journal.
import { fetchEU, mergeEU, euroClosed, manualOpen, EU_FILE } from './eod.mjs';

const { GIST_TOKEN, FORCE, EODHD_KEY } = process.env;
const STATE_FILE = 'carnet-positions.json', RADAR_FILE = 'carnet-radar.json', SITE = 'https://clairnet1905.github.io/carnet-de-positions/';
const log = (...a) => console.log(...a);
if (!GIST_TOKEN) { console.error('Secret GIST_TOKEN manquant.'); process.exit(1); }

// Heure de Paris (gère l'heure d'été) : les deux horaires du workflow couvrent l'hiver et l'été, un seul tombe dans la fenêtre.
const P = {};
for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) P[x.type] = x.value;
const today = `${P.year}-${P.month}-${P.day}`, min = +P.hour * 60 + +P.minute, wd = new Date(today + 'T12:00:00Z').getUTCDay();


const force = FORCE === 'true';
if (!force && (wd === 0 || wd === 6)) { log(`${today} : week-end, pas de rappel.`); process.exit(0); }
if (!force && euroClosed(today) && !(wd === 0 || wd === 6)) { log(`${today} : Euronext fermé, pas de rappel.`); process.exit(0); }
if (!force && (min < 17 * 60 + 30 || min >= 18 * 60 + 30)) { log(`${P.hour}:${P.minute} à Paris : hors de la fenêtre 17:30 – 18:30, rien à faire (l'autre horaire s'en charge).`); process.exit(0); }

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, { ...opts, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GIST_TOKEN, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'carnet-rappel', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}
let main = null, radar = null;
for (let page = 1; page <= 10 && !(main && radar); page++) {
  const list = await gh('/gists?per_page=100&page=' + page);
  for (const x of list) { if (x.files && x.files[STATE_FILE] && !main) main = x.id; if (x.files && x.files[RADAR_FILE] && !radar) radar = x.id; }
  if (list.length < 100) break;
}
if (!main) { console.error('Gist de l’application introuvable.'); process.exit(1); }
const g = await gh('/gists/' + main), f = g.files[STATE_FILE];
const S = JSON.parse(f.truncated || f.content == null ? await (await fetch(f.raw_url)).text() : f.content);
S.settings = S.settings || {}; S.prices = S.prices || {};

// Clôtures EODHD (actions avec un code dans Réglages › Cours automatiques) : enregistrées pour l'app dans le Gist du radar.
const eod = S.settings.eodSym || {}, euToday = new Set();
if (EODHD_KEY && Object.keys(eod).length && radar) {
  try {
    const got = await fetchEU(S, EODHD_KEY, log), rg = await gh('/gists/' + radar), ef = rg.files[EU_FILE];
    let prev = null; try { prev = ef ? JSON.parse(ef.truncated || ef.content == null ? await (await fetch(ef.raw_url)).text() : ef.content) : null; } catch (e) {}
    const EU = mergeEU(prev, got.ok, S);
    for (const t in EU.px) if (EU.px[t].some(x => x[0] === today)) euToday.add(t);
    if (Object.keys(got.ok).length) await gh('/gists/' + radar, { method: 'PATCH', body: JSON.stringify({ files: { [EU_FILE]: { content: JSON.stringify(EU) } } }) });
  } catch (e) { log('EODHD : ' + e.message); }
} else if (Object.keys(eod).length && !EODHD_KEY) log('EODHD : secret EODHD_KEY absent, cours européens non récupérés.');
// Rappel : actions sans code EODHD (à saisir à la main) dont le cours du jour manque. Celles avec un code : le robot du soir réessaie
// EODHD et ne prévient que s'il n'a toujours rien.
const watch = manualOpen(S);
const missing = watch.filter(t => !eod[t] && !euToday.has(t) && !(S.prices[t] || []).some(x => x.date === today)).sort();
log(`${today} ${P.hour}:${P.minute} à Paris · hors Finnhub : ${watch.join(', ') || 'aucune'} · par EODHD aujourd’hui : ${[...euToday].join(', ') || 'aucune'} · à saisir : ${missing.join(', ') || 'aucune'}`);
if (!missing.length && !force) process.exit(0);

const NT = S.settings.ntfy || {};
if (!NT.on || !/^[A-Za-z0-9_-]{12,64}$/.test(NT.topic || '')) { log('ntfy non activé dans l’app (Réglages › Notifications) : rappel non envoyé.'); process.exit(0); }
const msg = missing.length ? `Saisissez les cours de ${missing.join(', ')} (pas encore saisis aujourd’hui).` : 'Test : tous les cours manuels du jour sont saisis.';
const r = await fetch('https://ntfy.sh/', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: NT.topic, title: 'Clôture Europe', message: msg, click: SITE + '#pos', priority: 3 }) });
log(r.ok ? 'ntfy : rappel envoyé.' : 'ntfy refusé : ' + r.status);
