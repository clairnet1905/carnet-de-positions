// Robot du radar SMA, lancé par GitHub Actions après la clôture de Wall Street (voir .github/workflows/radar.yml).
// 1. Lit vos données synchronisées (Gist « carnet-positions.json ») : actions suivies, alertes vues, appareils abonnés.
// 2. Met à jour l'historique des cours de toutes les actions suivies, une seule fois pour tous vos appareils,
//    dans un second Gist secret (« carnet-radar.json ») que l'app télécharge.
// 3. Envoie une notification groupée aux appareils abonnés pour chaque nouveau croisement de SMA.
// Les clés ne sont jamais écrites dans le code : elles viennent des secrets du dépôt (Settings › Secrets and variables › Actions).
import { addDays, days, lastSession, prevWeekday, nextWeekday, weekKey, barsNeeded, symOf, signals, message, analyze, pack, unpack, divGaps, divLate, fixBars } from './sma.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { riskCheck } from './risk.mjs';
import { labUnit, labCombo, packUnit, doneBars, LAB_PERIODS, LAB_MIN_TRADES } from './labsma.mjs';

const { GIST_TOKEN, TWELVEDATA_KEY, FINNHUB_KEY, VAPID_PRIVATE_KEY, TEST_PUSH } = process.env;
const STATE_FILE = 'carnet-positions.json', RADAR_FILE = 'carnet-radar.json', LAB_FILE = 'carnet-lab.json';
const LAB_PER_RUN = 40, LAB_REDO_DAYS = 30, T0 = Date.now();
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
let tdCalls = 0, tdLast = 0, ADJ = 'all';
async function twelve(sym, n, interval = '1day', end = '', adj = ADJ) {
  if (!TWELVEDATA_KEY) throw new Error('pas de clé Twelve Data');
  if (tdCalls >= TD_DAY_LIMIT) throw new Error('quota Twelve Data du jour réservé');
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = tdLast + 8000 - Date.now(); if (wait > 0) await sleep(wait);   // 8 requêtes par minute (offre gratuite)
    tdLast = Date.now(); tdCalls++;
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${n}&adjust=${adj}${end ? '&end_date=' + end : ''}&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`);
    const j = await r.json().catch(() => ({}));
    if (j.code === 429 || r.status === 429) { await sleep(61000); continue; }
    if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message || 'erreur ' + r.status);
    return j.values.map(v => [String(v.datetime).slice(0, 10), +v.close]).filter(v => v[1] > 0).sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  throw new Error('limite Twelve Data');
}
// Journalier depuis le début de l'actif, jusqu'à 80 ans : 5 000 séances par requête au plus (offre gratuite),
// donc une requête de plus par tranche de 20 ans tant que la précédente était pleine (4 au plus).
async function twelveLong(sym) {
  let a = await twelve(sym, 5000, '1day');
  for (let k = 1, got = a.length; k < 4 && got >= 4990; k++) {
    try { const b = (await twelve(sym, 5000, '1day', addDays(a[0][0], -1))).filter(x => x[0] < a[0][0]); got = b.length; a = b.concat(a); }
    catch (e) { if (/quota|limite/.test(e.message)) throw e; break; }   // pas d'historique plus ancien
  }
  return a;
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
// Cours ajustés des dividendes (comme le bouton ADJ de TradingView), sauf si l'app le désactive (Radar › Réglages).
ADJ = S.settings.adjDiv === false ? 'splits' : 'all';
let R = { v: 1, hist: {}, notified: {}, ls: '', at: 0, log: [] }, L = { v: 1, res: {} };
if (ids.radar) {
  const g = await gh('/gists/' + ids.radar);
  try { R = Object.assign(R, JSON.parse(await fileText(g.files[RADAR_FILE]))); } catch (e) { log('Historique illisible, reconstruit.'); }
  try { if (g.files[LAB_FILE]) L = Object.assign(L, JSON.parse(await fileText(g.files[LAB_FILE]))); } catch (e) { log('Résultats du Labo illisibles, recommencés.'); }
}
const hist = {};
for (const s in R.hist) hist[s] = unpack(R.hist[s]);

const now = Date.now(), ls = lastSession(now), prev = prevWeekday(ls);
const adjChanged = (R.adj || 'splits') !== ADJ;   // réglage changé (ou premier passage en cours ajustés) : tout est retéléchargé
const need = {}, usSym = {};
for (const w of S.watch) { const s = symOf(w); need[s] = Math.max(need[s] || 0, barsNeeded(w)); if (!w.sym) usSym[s] = true; }
const manual = new Set((S.settings.manualTickers || []).map(t => String(t).toUpperCase()));
log(`Séance du ${ls} · ${Object.keys(need).length} action(s), ${S.watch.length} SMA · cours ${ADJ === 'all' ? 'ajustés des dividendes' : 'ajustés des divisions seulement'}${adjChanged ? ' (réglage changé : tout est retéléchargé)' : ''}`);

// Ordre : historique absent ou trop court (Twelve Data complet), puis clôture du jour (Twelve Data court, qui recale l’historique ajusté ; Finnhub si les cours ne sont pas ajustés),
// puis vérification complète hebdomadaire de quelques actions (divisions d'actions, clôtures corrigées).
const full = [], daily = [], resync = [];
for (const s of Object.keys(need)) {
  const h = hist[s];
  if (!h || adjChanged || h.n < need[s] || days(h.last, ls) > 20) full.push(s);   // un trou de quelques jours (jour férié) se comble par une requête courte
  else if (h.last < ls) daily.push(s);
  else if (now - (h.full || 0) > WEEK) resync.push(s);
}
resync.sort((a, b) => (hist[a].full || 0) - (hist[b].full || 0));
const errors = {}, adjusted = [];
const put = (s, bars, isFull) => {
  bars = bars.filter(b => b[0] <= ls);
  const old = hist[s] && !isFull ? hist[s].bars : [];
  const from = bars.length ? bars[0][0] : '9999';
  // Un dividende ou une division d'actions récents décalent tous les cours ajustés antérieurs d'un même facteur :
  // on le mesure sur une clôture commune aux deux séries et on l'applique à l'historique gardé.
  const same = old.find(b => b[0] === from), k = same ? bars[0][1] / same[1] : 1, shift = Math.abs(k - 1) > 2e-4;
  if (shift) adjusted.push(s);
  const older = old.filter(b => b[0] < from).map(([d, c]) => [d, shift ? c * k : c]);
  const merged = older.concat(bars).slice(-Math.max(need[s] + 30, 60));
  hist[s] = { bars: merged, n: need[s], full: isFull ? Date.now() : (hist[s] && hist[s].full) || 0, last: merged.length ? merged[merged.length - 1][0] : '' };
};
for (const s of full) { try { put(s, await twelve(s, need[s]), true); } catch (e) { errors[s] = e.message; } }
for (const s of daily) {
  try {
    if (ADJ === 'splits' && FINNHUB_KEY && usSym[s] && !manual.has(s)) {
      const q = await finnhub(s);
      const d = q && q.t ? new Date(q.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : '';
      if (q && q.c > 0 && d === ls && hist[s].last === prev) { put(s, [[d, q.c]], false); continue; }
    }
    put(s, await twelve(s, Math.min(need[s], days(hist[s].last, ls) + 5)), false);
  } catch (e) { errors[s] = e.message; }
}
for (const s of resync.slice(0, RESYNC_PER_RUN)) { try { put(s, await twelve(s, need[s]), true); } catch (e) { errors[s] = e.message; break; } }

// ----- Dividendes manquants (cours ajustés seulement) : actions en position, vérifiées une fois par semaine (1 requête chacune) -----
// Le cours brut comparé au cours ajusté donne les dividendes connus de Twelve Data ; un versement manquant est estimé (sma.mjs : divGaps).
// L'historique gardé reste celui de Twelve Data : la correction s'applique au calcul des SMA (ici et dans l'app).
const isOpen = l => !l.demo && l.qty - (l.events || []).filter(e => e.type === 'sell').reduce((a, e) => a + e.qty, 0) > 1e-9;
const posSym = ADJ === 'all' ? [...new Set((S.lots || []).filter(isOpen).flatMap(l => S.watch.filter(w => w.ticker === l.ticker && !w.idx).map(symOf)))] : [];
const DF = ADJ === 'all' && R.adj === ADJ ? Object.assign({}, R.divfix) : {};
for (const s of posSym) {
  if (!hist[s] || (DF[s] && now - DF[s].at < WEEK && !adjusted.includes(s))) continue;
  if (tdCalls + 1 > TD_DAY_LIMIT) break;
  try {
    const raw = await twelve(s, Math.min(5000, hist[s].bars.length), '1day', '', 'splits');
    DF[s] = { at: Date.now(), fx: divGaps(raw, hist[s].bars), late: divLate(raw, hist[s].bars) };
    if (DF[s].fx.length) log(`Dividende(s) estimé(s) ${s} : ${DF[s].fx.map(x => `${x[0]} (${x[2]} $)`).join(', ')}`);
    if (DF[s].late) log(`Dividende à vérifier ${s} : dernier connu le ${DF[s].late[0]}, suivant attendu vers le ${DF[s].late[1]}`);
  } catch (e) { if (/quota|limite/.test(e.message)) break; }
}
for (const s in DF) if (!posSym.includes(s) || !hist[s]) delete DF[s];
const view = {};   // historique utilisé pour les SMA (signaux, stops, feu)
for (const s in hist) view[s] = DF[s] && DF[s].fx.length ? Object.assign({}, hist[s], { bars: fixBars(hist[s].bars, DF[s].fx) }) : hist[s];

// ----- Labo SMA : tickers demandés dans l'app (S.settings.labQueue), radar compris ; le robot n'écrit jamais dans le radar -----
// 3 à 6 requêtes Twelve Data par action (J jusqu'à 20 000 séances en quatre fois, S et M depuis le début de l'actif), refaites tous les 30 jours.
// En plus des 15 SMA × J / S / M : test combiné J + S + M (filtre par la meilleure SMA hebdo et mensuelle).
const labQ = [...new Set((S.settings.labQueue || []).map(t => String(t).toUpperCase()))];
// Refait une fois : résultats sans test combiné (C) ou sans date de début des données (avant le journalier sur 80 ans).
const labDue = t => { const x = L.res[t]; return !x || x.adj !== ADJ || (!x.err && (!('C' in x) || (x.D && !('first' in x.D)))) || days(new Date(x.at).toISOString().slice(0, 10), ls) > (x.err ? 7 : LAB_REDO_DAYS); };
const labTodo = labQ.filter(labDue).sort((a, b) => (L.res[a] ? 1 : 0) - (L.res[b] ? 1 : 0));
let labDone = 0; const labNew = [];
for (const t of labTodo.slice(0, LAB_PER_RUN)) {
  if (tdCalls + 6 > TD_DAY_LIMIT || Date.now() - T0 > 65 * 60000) break;   // quota du jour et durée maximale du robot
  try {
    const one = {}, bars = {}, units = {};
    for (const [tf, iv] of [['D', '1day'], ['W', '1week'], ['M', '1month']]) {
      bars[tf] = doneBars(tf === 'D' ? await twelveLong(t) : await twelve(t, 5000, iv), tf, ls);
      units[tf] = labUnit(bars[tf], tf); one[tf] = packUnit(units[tf]);
    }
    one.C = packUnit(labCombo(bars, units));
    log(`Labo ${t} : données depuis ${['D', 'W', 'M'].map(tf => `${tf} ${bars[tf].length ? bars[tf][0][0] : '-'}`).join(', ')}`);
    L.res[t] = { at: Date.now(), ls, adj: ADJ, ...one };
    labDone++; labNew.push(t);
  } catch (e) {
    if (/quota|limite/.test(e.message)) break;
    if (/not found|invalid|symbol/i.test(e.message)) L.res[t] = { at: Date.now(), ls, adj: ADJ, err: e.message };   // ticker introuvable : réessayé dans 7 jours
    else log(`Labo ${t} : ${e.message} (réessayé au prochain passage)`);
  }
}
for (const t in L.res) if (!labQ.includes(t)) delete L.res[t];   // retirés de la liste dans l'app
const labLeft = labQ.filter(labDue).length;
L = { v: 1, at: Date.now(), ls, res: L.res };

// ----- Notifications -----
const subs = (S.push && S.push.subs) || [], pub = S.push && S.push.vapid;
const first = !R.ls || adjChanged;   // premier passage ou réglage changé : on mémorise les croisements sans notifier (pas d'avalanche)
const sig = signals(S, view, ls, R.notified, { near: !!S.settings.pushNear });
let sent = 0, dead = [];
const payloads = [];
if (sig.length && !first) payloads.push({ ...message(sig, ls), badge: sig.filter(x => x.kind !== 'near').length });
if (labDone && !labLeft) payloads.push({ title: 'Labo SMA terminé', body: `${labQ.filter(t => L.res[t] && !L.res[t].err).length} action(s) testée(s) sur 15 SMA × J / S / M et en combiné J + S + M. Résultats dans l’app.`, tag: 'lab-' + ls, url: './#lab' });

// ----- Aides : stops à remonter, résultats au prochain jour de bourse, bilan du vendredi -----
const usd = x => x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
const TFL = { D: 'J', W: 'S', M: 'M' };
const remOf = l => l.qty - (l.events || []).filter(e => e.type === 'sell').reduce((a, e) => a + e.qty, 0);
const openLots = (S.lots || []).filter(l => !l.demo && remOf(l) > 1e-9);
const openT = [...new Set(openLots.map(l => l.ticker))];
const extra = [];   // clés à mémoriser après envoi
// SMA faibles : une action du radar vient d'être testée et l'une de vos SMA y est jugée faible (frais IC Markets, assez de trades).
// Information seulement : le radar n'est jamais modifié.
if (S.settings.pushWeak !== false && labNew.length) {
  const sc = x => x[1] > 0 ? x[0] / x[1] : x[0] > 0 ? 99 : 0, lines = [], keys = [];
  for (const t of labNew) for (const w of S.watch.filter(x => x.ticker === t && !x.idx)) {
    const u = L.res[t][w.tf], i = LAB_PERIODS.indexOf(w.period), x = u && i >= 0 ? u.ic.sma[i] : null;
    if (!x || x[0] == null || x[1] == null || x[3] < LAB_MIN_TRADES[w.tf]) continue;
    if (x[2] >= 1.5 && x[0] >= 5 && sc(x) >= 0.2) continue;   // « À étudier » ou mieux
    const key = `weak|${t}|${w.tf}|${w.period}`; if (R.notified[key]) continue;
    const ok = u.ic.sma.map((y, k) => [y, k]).filter(([y]) => y && y[0] != null && y[1] != null && y[3] >= LAB_MIN_TRADES[w.tf]);
    const b = ok.length ? ok.reduce((p, q) => sc(q[0]) > sc(p[0]) ? q : p) : null;
    lines.push(`${t} : votre ${TFL[w.tf]} ${w.period} est faible (CAGR ${x[0].toFixed(1).replace('.', ',')} %, DD ${Math.round(x[1])} %)${b && b[1] !== i ? ` · meilleure ${TFL[w.tf]} ${LAB_PERIODS[b[1]]}` : ''}`);
    keys.push(key);
  }
  if (lines.length) { payloads.push({ title: `Labo · ${lines.length} SMA faible(s) au radar`, body: lines.slice(0, 6).join('\n') + '\nVos SMA ne sont pas changées : à vous de voir.', tag: 'weak-' + ls, url: './#lab' }); extra.push(...keys); }
}

// Stops : une SMA de l'action est passée entre le stop actuel et la dernière clôture (une notification par stop et par SMA).
if (S.settings.pushStops !== false) {
  const lines = [];
  for (const t of openT) {
    const l = openLots.find(x => x.ticker === t), st = l.stopCurrent > 0 ? l.stopCurrent : 0;
    const mine = [...new Set(openLots.filter(x => x.ticker === t).flatMap(x => x.smas || []))];   // SMA d'entrée choisies dans l'app (vide : toutes)
    const got = [];   // SMA proposées pour cette action, rangées ensuite de la plus haute à la plus basse (comme dans l'app)
    for (const w of S.watch.filter(x => x.ticker === t && !x.idx && (!mine.length || mine.includes(x.tf + '|' + x.period)))) {
      const h = view[symOf(w)]; if (!h) continue;
      const a = analyze(w, h.bars, ls, S.settings.nearPct); if (!a || a.short) continue;
      const key = `stop|${l.id}|${w.id}|${st}`;
      const late = DF[symOf(w)] && DF[symOf(w)].late;   // dividende peut-être manquant : SMA à vérifier sur TradingView
      if (a.sma > st * 1.005 && a.sma < a.lastClose && !R.notified[key]) { got.push([a.sma, `${t} : SMA ${w.period} ${TFL[w.tf]} à ${usd(a.sma)} (stop ${st ? usd(st) : 'aucun'})${late ? ' · dividende à vérifier' : ''}`]); extra.push(key); }
    }
    lines.push(...got.sort((x, y) => y[0] - x[0]).map(x => x[1]));
  }
  if (lines.length && !first) payloads.push({ title: `Stops · ${lines.length} à remonter`, body: lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n+ ${lines.length - 6} autre(s) dans l’app` : ''), tag: 'stops-' + ls, url: './#dash', badge: lines.length });
}
// Résultats : positions ouvertes qui publient d'ici le prochain jour de bourse (week-end compris le vendredi).
if (S.settings.pushEarn !== false && FINNHUB_KEY && openT.length) {
  try {
    const to = nextWeekday(ls), r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${addDays(ls, 1)}&to=${to}&token=${encodeURIComponent(FINNHUB_KEY)}`);
    const rows = r.ok ? ((await r.json()) || {}).earningsCalendar || [] : [];
    const H = { bmo: 'avant l’ouverture', amc: 'après la clôture', dmh: 'pendant la séance' };
    const hit = rows.filter(x => openT.includes(String(x.symbol || '').toUpperCase()) && !R.notified[`earn|${x.symbol}|${x.date}`]);
    if (hit.length) {
      payloads.push({ title: `Résultats · ${hit.map(x => x.symbol).join(', ')}`, body: hit.map(x => `${x.symbol} publie le ${x.date.split('-').reverse().join('/')}${H[x.hour] ? ' ' + H[x.hour] : ''}`).join('\n') + '\nGarder, alléger ou resserrer le stop : à vous de voir.', tag: 'earn-' + ls, url: './#pos' });
      for (const x of hit) extra.push(`earn|${x.symbol}|${x.date}`);
    }
  } catch (e) { log('Calendrier des résultats indisponible : ' + e.message); }
}
// Bilan du vendredi : trades clôturés, R, stops remontés, positions ouvertes, feu du marché.
if (S.settings.pushWeekly !== false && new Date(ls + 'T12:00:00Z').getUTCDay() === 5 && !R.notified['week|' + ls]) {
  const from = weekKey(ls), inW = d => d >= from && d <= ls, rp = S.settings.riskPct || 1;
  let n = 0, net = 0, sumR = 0, nR = 0, raised = 0;
  for (const l of (S.lots || []).filter(x => !x.demo)) {
    const sells = (l.events || []).filter(e => e.type === 'sell');
    const ev = l.events || [];
    raised += ev.filter(e => e.type === 'stop' && inW(e.date) && e.to > (e.from || 0)).length;
    const last = sells.map(e => e.date).sort().pop();
    if (remOf(l) > 1e-9 || !last || !inW(last)) continue;
    const g = sells.reduce((a, e) => a + e.qty * (e.price - l.price) - (e.fee || 0), 0) - (l.entryFee || 0)
      + ev.filter(e => e.type === 'dividend' || e.type === 'adjust').reduce((a, e) => a + (e.amount || 0), 0) - ev.filter(e => e.type === 'funding').reduce((a, e) => a + (e.amount || 0), 0);
    const u = l.riskPlan > 0 ? l.riskPlan : l.refCapital > 0 ? l.refCapital * rp / 100 : 0;
    n++; net += g; if (u > 0) { sumR += g / u; nR++; }
  }
  let up = 0, k = 0;
  for (const w of S.watch.filter(x => x.idx)) { const h = view[symOf(w)]; if (!h) continue; const a = analyze(w, h.bars, ls, 2); if (!a || a.short) continue; k++; if (a.above) up++; }
  const feu = k ? (up / k >= 0.7 ? 'vert' : up / k <= 0.3 ? 'rouge' : 'orange') : null;
  const lines = [n ? `${n} trade(s) clôturé(s) : ${net >= 0 ? '+' : ''}${usd(net)}${nR ? ` · ${sumR >= 0 ? '+' : ''}${sumR.toFixed(2).replace('.', ',')} R` : ''} (swap estimé non compris)` : 'Aucun trade clôturé cette semaine',
    `${openT.length} position(s) ouverte(s) · ${raised} stop(s) remonté(s)`, feu ? `Feu ${feu} : ${up}/${k} de vos SMA d’indices au-dessus` : ''].filter(Boolean);
  payloads.push({ title: 'Bilan de la semaine', body: lines.join('\n'), tag: 'week-' + ls, url: './#dash' });
  extra.push('week|' + ls);
}
// Limites de risque : une notification quand une limite est franchie, sur la clôture (même calcul que le panneau Risque de l'app).
let riskState = R.risk || null;
try {
  const cx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../src/carnet/core.js', import.meta.url), 'utf8') + '\nglobalThis.Core = Core;', cx);
  // Action en saisie manuelle (autre marché que le radar, ex. EL) : on garde le cours saisi dans l'app.
  const closeOf = t => { if (manual.has(String(t).toUpperCase())) return null; const w = S.watch.find(x => x.ticker === t && !x.idx), h = w && hist[symOf(w)], b = h && h.bars[h.bars.length - 1]; return b && days(b[0], ls) <= 7 ? { date: b[0], price: b[1] } : null; };
  const rc = riskCheck(S, cx.Core, closeOf, ls, R.risk);
  riskState = rc.state; if (rc.payload) payloads.push(rc.payload);
  const f = x => x == null ? '—' : x.toFixed(1);
  log(`Risque : perte au stop ${f(rc.state.heatPct)} % · niveau de marge ${f(rc.state.level)} % · ${rc.state.pos} position(s)${rc.state.over.length ? ' · dépassé : ' + rc.state.over.join(', ') : ''}${rc.payload ? ' · notifié' : ''}${rc.state.noPx.length ? ' · sans cours : ' + rc.state.noPx.join(', ') : ''}`);
} catch (e) { log('Contrôle du risque impossible : ' + e.message); }
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
for (const k of extra) R.notified[k] = ls;
for (const k in R.notified) if (days(R.notified[k], ls) > 60) delete R.notified[k];

// ----- Enregistrement -----
const packed = {};
for (const s in hist) if (need[s]) packed[s] = pack(hist[s]);   // les actions retirées du radar sont oubliées
R = { v: 1, ls, adj: ADJ, at: Date.now(), hist: packed, divfix: DF, notified: R.notified, risk: riskState, deadSubs: dead, errors,
  log: [{ at: Date.now(), ls, full: full.length, daily: daily.length, resync: Math.min(resync.length, RESYNC_PER_RUN), signals: sig.length, sent, td: tdCalls, errors: Object.keys(errors).length }].concat(R.log || []).slice(0, 30) };
const body = JSON.stringify(R);
const labBody = JSON.stringify(L);
if (ids.radar) await gh('/gists/' + ids.radar, { method: 'PATCH', body: JSON.stringify({ files: { [RADAR_FILE]: { content: body }, [LAB_FILE]: { content: labBody } } }) });
else await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Carnet de positions : historique du radar SMA (gist secret, ne pas rendre public)', public: false, files: { [RADAR_FILE]: { content: body }, [LAB_FILE]: { content: labBody } } }) });
if (labQ.length) log(`Labo SMA : ${labDone} action(s) testée(s) · ${labLeft} en attente · ${(labBody.length / 1024).toFixed(0)} Ko`);
log(`Historique : ${full.length} complet(s), ${daily.length} clôture(s) du jour, ${Math.min(resync.length, RESYNC_PER_RUN)} vérification(s) · ${tdCalls} requête(s) Twelve Data · ${(body.length / 1024).toFixed(0)} Ko`);
log(`Signaux : ${sig.length}${first ? ' (premier passage, mémorisés sans notifier)' : ''} · notifications envoyées : ${sent}`);
if (adjusted.length) log('Historique réajusté (dividende ou division) : ' + adjusted.join(', '));
if (Object.keys(errors).length) log('Erreurs : ' + Object.entries(errors).slice(0, 20).map(([s, m]) => s + ' (' + m + ')').join(', '));
