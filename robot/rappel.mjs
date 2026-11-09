// Rappel de la clôture européenne (17 h 30 à Paris), lancé par GitHub Actions (voir .github/workflows/rappel.yml).
// Lit vos données synchronisées (Gist « carnet-positions.json ») et envoie une notification ntfy s'il manque le cours du jour
// d'une position ouverte en saisie manuelle. Rien si tout est saisi, ni le week-end, ni les jours de fermeture d'Euronext.
// Le nom du canal ntfy n'est jamais écrit dans le journal.
import { addDays } from './sma.mjs';

const { GIST_TOKEN, FORCE } = process.env;
const STATE_FILE = 'carnet-positions.json', SITE = 'https://clairnet1905.github.io/carnet-de-positions/';
const log = (...a) => console.log(...a);
if (!GIST_TOKEN) { console.error('Secret GIST_TOKEN manquant.'); process.exit(1); }

// Heure de Paris (gère l'heure d'été) : les deux horaires du workflow couvrent l'hiver et l'été, un seul tombe dans la fenêtre.
const P = {};
for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) P[x.type] = x.value;
const today = `${P.year}-${P.month}-${P.day}`, min = +P.hour * 60 + +P.minute, wd = new Date(today + 'T12:00:00Z').getUTCDay();

// Jours de fermeture d'Euronext : 1er janvier, Vendredi saint, lundi de Pâques, 1er mai, 25 et 26 décembre.
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((8 * b + 13) / 25)) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4) - 7 * Math.floor((h + 11 * Math.floor(c / 4)) / 29)) % 7;
  const m = Math.floor((h + l + 114) / 31), d = ((h + l + 114) % 31) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const y = +P.year, e = easter(y);
const closed = new Set([`${y}-01-01`, addDays(e, -2), addDays(e, 1), `${y}-05-01`, `${y}-12-25`, `${y}-12-26`]);

const force = FORCE === 'true';
if (!force && (wd === 0 || wd === 6)) { log(`${today} : week-end, pas de rappel.`); process.exit(0); }
if (!force && closed.has(today)) { log(`${today} : Euronext fermé, pas de rappel.`); process.exit(0); }
if (!force && (min < 17 * 60 + 30 || min >= 18 * 60 + 30)) { log(`${P.hour}:${P.minute} à Paris : hors de la fenêtre 17:30 – 18:30, rien à faire (l'autre horaire s'en charge).`); process.exit(0); }

async function gh(path) {
  const r = await fetch('https://api.github.com' + path, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GIST_TOKEN, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'carnet-rappel' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}
let main = null;
for (let page = 1; page <= 10 && !main; page++) {
  const list = await gh('/gists?per_page=100&page=' + page);
  const g = list.find(x => x.files && x.files[STATE_FILE]); if (g) main = g.id;
  if (list.length < 100) break;
}
if (!main) { console.error('Gist de l’application introuvable.'); process.exit(1); }
const g = await gh('/gists/' + main), f = g.files[STATE_FILE];
const S = JSON.parse(f.truncated || f.content == null ? await (await fetch(f.raw_url)).text() : f.content);
S.settings = S.settings || {}; S.prices = S.prices || {};

// Positions ouvertes en saisie manuelle : cochées « cours manuel » dans l'app, ou au moins 3 cours saisis et aucun cours automatique
// (une action US achetée récemment n'a qu'un cours, celui de l'achat, en attendant sa première clôture automatique).
const manual = new Set((S.settings.manualTickers || []).map(t => String(t).toUpperCase()));
const rem = l => l.qty - (l.events || []).filter(x => x.type === 'sell').reduce((a, x) => a + x.qty, 0);
const open = [...new Set((S.lots || []).filter(l => !l.demo && rem(l) > 1e-9).map(l => l.ticker))];
const byHand = t => { const p = S.prices[t] || []; return p.length >= 3 && p.every(x => x.src !== 'auto'); };
const watch = open.filter(t => manual.has(String(t).toUpperCase()) || byHand(t));
const missing = watch.filter(t => !(S.prices[t] || []).some(x => x.date === today)).sort();
log(`${today} ${P.hour}:${P.minute} à Paris · saisie manuelle : ${watch.join(', ') || 'aucune'} · cours du jour manquant : ${missing.join(', ') || 'aucun'}`);
if (!missing.length && !force) process.exit(0);

const NT = S.settings.ntfy || {};
if (!NT.on || !/^[A-Za-z0-9_-]{12,64}$/.test(NT.topic || '')) { log('ntfy non activé dans l’app (Réglages › Notifications) : rappel non envoyé.'); process.exit(0); }
const msg = missing.length ? `Saisissez les cours de ${missing.join(', ')} (pas encore saisis aujourd’hui).` : 'Test : tous les cours manuels du jour sont saisis.';
const r = await fetch('https://ntfy.sh/', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: NT.topic, title: 'Clôture Europe', message: msg, click: SITE + '#pos', priority: 3 }) });
log(r.ok ? 'ntfy : rappel envoyé.' : 'ntfy refusé : ' + r.status);
