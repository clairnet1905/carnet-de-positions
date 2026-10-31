// Robot du radar SMA, lancé par GitHub Actions après la clôture de Wall Street (voir .github/workflows/radar.yml).
// 1. Lit vos données synchronisées (Gist « carnet-positions.json ») : actions suivies, alertes vues, appareils abonnés.
// 2. Met à jour l'historique des cours de toutes les actions suivies, une seule fois pour tous vos appareils,
//    dans un second Gist secret (« carnet-radar.json ») que l'app télécharge.
// 3. Envoie une notification groupée aux appareils abonnés pour chaque nouveau croisement de SMA.
// Les clés ne sont jamais écrites dans le code : elles viennent des secrets du dépôt (Settings › Secrets and variables › Actions).
import { addDays, days, lastSession, prevWeekday, barsNeeded, symOf, signals, message, pack, unpack } from './sma.mjs';

const { GIST_TOKEN, TWELVEDATA_KEY, FINNHUB_KEY, VAPID_PRIVATE_KEY, TEST_PUSH } = process.env;
const STATE_FILE = 'carnet-positions.json', RADAR_FILE = 'carnet-radar.json';
const SITE = 'https://clairnet1905.github.io/carnet-de-positions/';
const WEEK = 7 * 864e5, RESYNC_PER_RUN = 40, TD_DAY_LIMIT = 700;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

if (!GIST_TOKEN) { console.error('Secret GIST_TOKEN manquant : ajoutez votre jeton GitHub (droit gist) dans les secrets du dépôt.'); process.exit(1); }

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GIST_TOKEN, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'carnet-radar' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com' + path, { ...opts, headers });
  if (!r.ok) throw new Error(`GitHub ${r.status} sur ${path.replace(/\/gists\/\w+/, '/gists/…')}`);
  return r.status === 204 ? null : r.json();
}
const fileText = async f => f.truncated || f.content == null ? (await fetch(f.raw_url)).text() : f.content;
async function findGists() {
  const found = {};
  for (let page = 1; page <= 10; page++) {
    const list = await gh('/gists?per_page=100&page=' + page);
    for (const g of list) { if (g.files[STATE_FILE] && !found.main) found.main = g.id; if (g.files[RADAR_FILE] && !found.radar) found.radar = g.id; }
    if (list.length < 100) break;
  }
  return found;
}

// ----- Cours -----
let tdCalls = 0, tdLast = 0;
async function twelve(sym, n) {
  if (!TWELVEDATA_KEY) throw new Error('pas de clé Twelve Data');
  if (tdCalls >= TD_DAY_LIMIT) throw new Error('quota Twelve Data du jour réservé');
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = tdLast + 8000 - Date.now(); if (wait > 0) await sleep(wait);   // 8 requêtes par minute (offre gratuite)
    tdLast = Date.now(); tdCalls++;
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=${n}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`);
    const j = await r.json().catch(() => ({}));
    if (j.code === 429 || r.status === 429) { await sleep(61000); continue; }
    if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message || 'erreur ' + r.status);
    return j.values.map(v => [String(v.datetime).slice(0, 10), +v.close]).filter(v => v[1] > 0).sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  throw new Error('limite Twelve Data');
}
let fhLast = 0;
async function finnhub(sym) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = fhLast + 1100 - Date.now(); if (wait > 0) await sleep(wait);   // 60 requêtes par minute
    fhLast = Date.now();
    const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + encodeURIComponent(FINNHUB_KEY));
    if (r.status === 429) { await sleep(61000); continue; }
    if (!r.ok) throw new Error('Finnhub ' + r.status);
    return r.json();
  }
  throw new Error('limite Finnhub');
}

// ----- Programme -----
const ids = await findGists();
if (!ids.main) { console.error('Gist de l’application introuvable : activez d’abord la synchronisation dans l’app, avec le même compte GitHub.'); process.exit(1); }
const main = await gh('/gists/' + ids.main);
const S = JSON.parse(await fileText(main.files[STATE_FILE]));
S.watch = S.watch || []; S.settings = S.settings || {};
let R = { v: 1, hist: {}, notified: {}, ls: '', at: 0, log: [] };
if (ids.radar) {
  const g = await gh('/gists/' + ids.radar);
  try { R = Object.assign(R, JSON.parse(await fileText(g.files[RADAR_FILE]))); } catch (e) { log('Historique illisible, reconstruit.'); }
}
const hist = {};
for (const s in R.hist) hist[s] = unpack(R.hist[s]);

const now = Date.now(), ls = lastSession(now), prev = prevWeekday(ls);
const need = {}, usSym = {};
for (const w of S.watch) { const s = symOf(w); need[s] = Math.max(need[s] || 0, barsNeeded(w)); if (!w.sym) usSym[s] = true; }
const manual = new Set((S.settings.manualTickers || []).map(t => String(t).toUpperCase()));
log(`Séance du ${ls} · ${Object.keys(need).length} action(s), ${S.watch.length} SMA`);

// Ordre : historique absent ou trop court (Twelve Data complet), puis clôture du jour (Finnhub, ou Twelve Data court),
// puis vérification complète hebdomadaire de quelques actions (divisions d'actions, clôtures corrigées).
const full = [], daily = [], resync = [];
for (const s of Object.keys(need)) {
  const h = hist[s];
  if (!h || h.n < need[s] || days(h.last, ls) > 20) full.push(s);   // un trou de quelques jours (jour férié) se comble par une requête courte
  else if (h.last < ls) daily.push(s);
  else if (now - (h.full || 0) > WEEK) resync.push(s);
}
resync.sort((a, b) => (hist[a].full || 0) - (hist[b].full || 0));
const errors = {};
const put = (s, bars, isFull) => {
  bars = bars.filter(b => b[0] <= ls);
  const old = hist[s] && !isFull ? hist[s].bars : [];
  const from = bars.length ? bars[0][0] : '9999';
  const merged = old.filter(b => b[0] < from).concat(bars).slice(-Math.max(need[s] + 30, 60));
  hist[s] = { bars: merged, n: need[s], full: isFull ? Date.now() : (hist[s] && hist[s].full) || 0, last: merged.length ? merged[merged.length - 1][0] : '' };
};
for (const s of full) { try { put(s, await twelve(s, need[s]), true); } catch (e) { errors[s] = e.message; } }
for (const s of daily) {
  try {
    if (FINNHUB_KEY && usSym[s] && !manual.has(s)) {
      const q = await finnhub(s);
      const d = q && q.t ? new Date(q.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : '';
      if (q && q.c > 0 && d === ls && hist[s].last === prev) { put(s, [[d, q.c]], false); continue; }
    }
    put(s, await twelve(s, Math.min(need[s], days(hist[s].last, ls) + 5)), false);
  } catch (e) { errors[s] = e.message; }
}
for (const s of resync.slice(0, RESYNC_PER_RUN)) { try { put(s, await twelve(s, need[s]), true); } catch (e) { errors[s] = e.message; break; } }

// ----- Notifications -----
const subs = (S.push && S.push.subs) || [], pub = S.push && S.push.vapid;
const first = !R.ls;   // premier passage : on mémorise les croisements existants sans notifier (pas d'avalanche)
const sig = signals(S, hist, ls, R.notified, { near: !!S.settings.pushNear });
let sent = 0, dead = [];
const payloads = [];
if (sig.length && !first) payloads.push(message(sig, ls));
if (TEST_PUSH === 'true') payloads.push({ title: 'Carnet de positions', body: `Notifications actives. Radar : ${Object.keys(hist).length} action(s) à jour au ${ls}.`, tag: 'test', url: './#radar' });
if (payloads.length && subs.length && pub && VAPID_PRIVATE_KEY) {
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(SITE, pub, VAPID_PRIVATE_KEY);
  for (const p of payloads) for (const sub of subs) {
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(p), { TTL: 86400, urgency: 'high' }); sent++; }
    catch (e) { log(`Envoi refusé (${sub.label || 'appareil'}) : ${e.statusCode || e.message}`); if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.id); }
  }
} else if (payloads.length) log('Notification non envoyée : ' + (!subs.length ? 'aucun appareil abonné' : !pub ? 'clés de notification non créées dans l’app' : 'secret VAPID_PRIVATE_KEY manquant'));
for (const x of sig) R.notified[x.key] = ls;
for (const k in R.notified) if (days(R.notified[k], ls) > 60) delete R.notified[k];

// ----- Enregistrement -----
const packed = {};
for (const s in hist) if (need[s]) packed[s] = pack(hist[s]);   // les actions retirées du radar sont oubliées
R = { v: 1, ls, at: Date.now(), hist: packed, notified: R.notified, deadSubs: dead, errors,
  log: [{ at: Date.now(), ls, full: full.length, daily: daily.length, resync: Math.min(resync.length, RESYNC_PER_RUN), signals: sig.length, sent, td: tdCalls, errors: Object.keys(errors).length }].concat(R.log || []).slice(0, 30) };
const body = JSON.stringify(R);
if (ids.radar) await gh('/gists/' + ids.radar, { method: 'PATCH', body: JSON.stringify({ files: { [RADAR_FILE]: { content: body } } }) });
else await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Carnet de positions : historique du radar SMA (gist secret, ne pas rendre public)', public: false, files: { [RADAR_FILE]: { content: body } } }) });
log(`Historique : ${full.length} complet(s), ${daily.length} clôture(s) du jour, ${Math.min(resync.length, RESYNC_PER_RUN)} vérification(s) · ${tdCalls} requête(s) Twelve Data · ${(body.length / 1024).toFixed(0)} Ko`);
log(`Signaux : ${sig.length}${first ? ' (premier passage, mémorisés sans notifier)' : ''} · notifications envoyées : ${sent}`);
if (Object.keys(errors).length) log('Erreurs : ' + Object.entries(errors).slice(0, 20).map(([s, m]) => s + ' (' + m + ')').join(', '));
