// ---------- Utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { usd, pct, qty, num, numOr, isNum } = Core;
const LS_KEY = 'carnet-positions:v1';
const todayISO = () => new Date().toLocaleDateString('sv-SE');
// Les conversions de dates sont lentes et répétées des milliers de fois par le radar : résultats gardés en mémoire.
const memo = fn => { const m = new Map(); return k => { let v = m.get(k); if (v === undefined) { v = fn(k); m.set(k, v); } return v; }; };
const addDaysM = memo(k => { const [d, n] = k.split('|'), t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + +n); return t.toLocaleDateString('sv-SE'); });
const addDays = (d, n) => addDaysM(d + '|' + n);
const fmtDateL = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateM = memo(d => fmtDateL.format(new Date(d + 'T12:00:00')));
const fmtDate = d => d ? fmtDateM(d) : '—';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const cls = x => !isNum(x) || Math.abs(x) < 0.005 ? '' : (x > 0 ? 'pos' : 'neg');
const fmtNum = (x, d = 2) => isNum(x) ? new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(x).replace('-', '−') : '';
const MOTIFS_OLD = { cassure: 'Cassure', pullback: 'Pullback', continuation: 'Continuation', autre: 'Autre' };
let MOTIFS = Object.assign({}, MOTIFS_OLD);   // libellés : vos motifs (Réglages › Mes motifs) et ceux encore utilisés par d'anciennes positions
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2800); }
function withTimeout(p, ms) { return Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]); }

// ---------- État ----------
function defaultState() {
  return {
    app: 'carnet-positions', version: 1, updatedAt: 0,
    settings: { initialCapital: 1000, startDate: todayISO(), riskPct: 1, cap: 100, leverage: 5,
      fees: { inFixed: 0, inPct: 0, outFixed: 0, outPct: 0, perShare: 0, minComm: 0 }, swap: { pct: 0, triple: 5 }, fractional: true, decimals: 4, staleDays: 4, refSource: 'auto', manualTickers: [], nearPct: 2, marginMin: 150, adjDiv: true, overshoot: 3 },
    flows: [], lots: [], prices: {}, snapshots: [], watch: [], seen: {}, push: { vapid: '', subs: [] }
  };
}
function normalize(st) {
  const d = defaultState();
  st = st && typeof st === 'object' ? st : {};
  const out = Object.assign({}, d, st);
  out.settings = Object.assign({}, d.settings, st.settings || {});
  out.settings.fees = Object.assign({}, d.settings.fees, (st.settings && st.settings.fees) || {});
  for (const k of ['flows', 'lots', 'snapshots', 'watch']) out[k] = Array.isArray(st[k]) ? st[k] : [];
  out.prices = st.prices && typeof st.prices === 'object' ? st.prices : {};
  out.seen = st.seen && typeof st.seen === 'object' && !Array.isArray(st.seen) ? st.seen : {};
  out.push = { vapid: (st.push && st.push.vapid) || '', subs: st.push && Array.isArray(st.push.subs) ? st.push.subs : [] };
  for (const l of out.lots) l.events = Array.isArray(l.events) ? l.events : [];
  return out;
}
// Captures d'une position : celle de l'achat puis celles des ventes.
const lotImgIds = l => [l.imgId, ...(l.events || []).map(e => e.imgId)].filter(Boolean);
let S = defaultState();
let tab = 'dash';
const openLots = new Set();
let journalFilter = 'closed', perfRange = 'itd', tradeYear = 'all', tradeMonth = 'all';  // période des positions clôturées (date de clôture)
const PERIODS = [['day', 'Jour', 'dernière séance'], ['week', 'Semaine', 'semaine en cours'], ['month', 'Mois', 'mois en cours'], ['year', 'Année', 'année en cours'], ['itd', 'Max', 'depuis le début']];
let calcDraft = null;

// ---------- Stockage : copie locale + espace privé claude.ai si disponible ----------
const Store = { ref: null, db: null, uid: null, mode: 'local', dirty: false, busy: false, timer: null, caps: {} };
function readLocal() { try { const t = localStorage.getItem(LS_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
function writeLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); return true; } catch (e) { return false; } }
function setSync(s, extra) {
  const el = $('#sync'); el.dataset.s = s;
  const txt = {
    local: 'Données conservées uniquement sur cet appareil',
    synced: 'Sauvegardé · espace privé claude.ai + cet appareil',
    saving: 'Enregistrement…',
    error: 'Échec de la sauvegarde distante' + (extra ? ' (' + extra + ')' : '') + ' · copie locale conservée'
  }[s];
  $('#syncText').textContent = txt;
}
function save(msg) {
  S.updatedAt = Date.now();
  const okLocal = writeLocal();
  if (Store.ref) scheduleRemote(); else setSync('local');
  if (!okLocal && !Store.ref) toast('Attention : le navigateur refuse la sauvegarde locale. Exportez vos données.');
  render();
  if (msg) toast(msg);
}
function scheduleRemote() { Store.dirty = true; setSync('saving'); clearTimeout(Store.timer); Store.timer = setTimeout(flushRemote, 700); }
async function flushRemote() {
  if (Store.busy) { Store.timer = setTimeout(flushRemote, 500); return; }
  if (!Store.dirty) return;
  Store.busy = true; Store.dirty = false;
  try {
    const body = JSON.parse(JSON.stringify(S));
    if (JSON.stringify(body).length > 240000) toast('Le journal approche la limite de 256 Ko par document : pensez à exporter.');
    await Store.ref.set(body); setSync('synced');
  } catch (e) {
    setSync('error', e && e.code);
    if (e && e.code === 'unavailable') { Store.dirty = true; setTimeout(flushRemote, 1500 + Math.random() * 1500); }
  } finally { Store.busy = false; }
}
async function initRemote() {
  const c = window.claude;
  if (!c || !c.use) return false;
  Store.caps.downloads = c.use('downloads');
  try {
    const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
    if (!db || !user) return false;
    const id = await user.id();
    if (!id) return false;
    Store.db = db; Store.uid = id; Store.ref = db.doc('data/users/' + id + '/state');
    return true;
  } catch (e) { return false; }
}
function subscribeRemote() {
  Store.ref.onSnapshot(snap => {
    if (!snap.exists || snap.metadata.hasPendingWrites) return;
    const data = snap.data();
    if (data && data.updatedAt > S.updatedAt) { S = normalize(JSON.parse(JSON.stringify(data))); writeLocal(); render(); toast('Données mises à jour depuis un autre appareil'); }
  }, () => setSync('error'));
}
// Captures : un document par image, compressée en JPEG.
async function putImage(id, dataUrl) {
  try { localStorage.setItem('carnet-img:' + id, dataUrl); } catch (e) { /* quota local dépassé : copie distante seulement */ }
  if (Store.db) await Store.db.doc('data/users/' + Store.uid + '/img-' + id).set({ data: dataUrl });
}
async function getImage(id) {
  try { const v = localStorage.getItem('carnet-img:' + id); if (v) return v; } catch (e) {}
  if (Store.db) { try { const s = await Store.db.doc('data/users/' + Store.uid + '/img-' + id).get(); if (s.exists) return s.data().data; } catch (e) {} }
  return null;
}
async function delImage(id) {
  try { localStorage.removeItem('carnet-img:' + id); } catch (e) {}
  if (Store.db) { try { await Store.db.doc('data/users/' + Store.uid + '/img-' + id).delete(); } catch (e) {} }
}
function readImageFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('Lecture impossible'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('Image illisible'));
      img.onload = () => {
        let max = 1400, q = 0.78, out;
        for (let i = 0; i < 6; i++) {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          out = cv.toDataURL('image/jpeg', q);
          if (out.length < 230000) break;
          max *= 0.8; q -= 0.08;
        }
        res(out);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// ---------- Données dérivées ----------
// 1 R = le risque prévu par le plan : « risque par position » (%) du capital de référence au moment de l'achat.
// Ainsi un R vaut la même chose pour tous les trades, et un risque réel trop grand ou trop petit se voit à part.
const planR = lot => lot.riskPlan > 0 ? lot.riskPlan : lot.refCapital > 0 ? lot.refCapital * (S.settings.riskPct || 1) / 100 : null;
const lotR = (lot, ls) => { const u = planR(lot); return ls.closed && u > 0 ? ls.netRealized / u : null; };
const fmtR = r => (r > 0 ? '+' : '') + fmtNum(r, 2) + ' R';
const fees = () => Core.normFees(S.settings.fees);
function latestBroker() { return [...S.snapshots].sort((a, b) => a.date < b.date ? 1 : -1)[0] || null; }
function lastEventDate() {
  let m = null;
  const up = d => { if (d && (!m || d > m)) m = d; };
  for (const l of S.lots) { up(l.date); for (const e of l.events) up(e.date); }
  for (const f of S.flows) up(f.date);
  return m;
}
function referenceCapital() {
  const today = todayISO();
  const acc = Core.accountState(S, null, 'last');
  const appDate = acc.openCount ? acc.minPriceDate : (lastEventDate() && lastEventDate() > today ? lastEventDate() : today);
  const app = { value: acc.equity, date: appDate, source: 'app', label: 'Calcul de l’application' };
  const lb = latestBroker();
  const br = lb ? { value: lb.netValue, date: lb.date, source: 'courtier', label: 'Valeur saisie depuis le courtier' } : null;
  const led = lastEventDate();
  let ref = app; const notes = [];
  const src = S.settings.refSource;
  if (src === 'broker' && br) { ref = br; if (led && led > br.date) notes.push('Des opérations ont été saisies après cette valeur courtier.'); }
  else if (src === 'auto' && br && br.date > appDate && (!led || br.date >= led)) ref = br;
  if (src === 'broker' && !br) notes.push('Aucune valeur courtier saisie : calcul de l’application utilisé.');
  if (ref.source === 'app' && acc.fallback.length) notes.push('Cours manquant pour ' + [...new Set(acc.fallback)].join(', ') + ' : valorisé au prix d’entrée.');
  const age = Core.days(ref.date, today);
  const stale = age > S.settings.staleDays;
  return Object.assign({}, ref, { age, stale, notes, acc });
}
function hasDemo() { return S.lots.some(l => l.demo) || S.flows.some(f => f.demo) || S.snapshots.some(s => s.demo); }
// Courbe : un cours manquant un jour (action en saisie manuelle, cours non récupéré) est remplacé par le dernier cours connu
// de moins de « staleDays » jours, pour que chaque séance compte. Les points concernés sont marqués estimés.
function perfPrices() {
  const all = new Set(), lim = S.settings.staleDays || 4, out = {}, carry = new Set();
  for (const t in S.prices) for (const x of S.prices[t]) all.add(x.date);
  const days = [...all].sort();
  for (const t in S.prices) {
    const own = [...S.prices[t]].sort((a, b) => a.date < b.date ? -1 : 1), have = new Set(own.map(x => x.date)), add = [];
    let j = -1;
    for (const d of days) {
      while (j + 1 < own.length && own[j + 1].date < d) j++;
      if (have.has(d) || j < 0 || Core.days(own[j].date, d) > lim) continue;
      add.push({ date: d, price: own[j].price, carry: true }); carry.add(d + '|' + t);
    }
    out[t] = add.length ? own.concat(add).sort((a, b) => a.date < b.date ? -1 : 1) : own;
  }
  // Position saisie après coup (ou cours jamais enregistrés) : les jours sans cours sont complétés par la clôture
  // de l'historique du radar si l'action y est. Points marqués estimés (cours ajustés des dividendes en mode ADJ).
  for (const l of S.lots) {
    const t = l.ticker, w = S.watch.find(x => x.ticker === t && !x.idx), h = w && histFixed(symOf(w), Radar.hist[symOf(w)]);
    if (!h || !h.bars || !h.bars.length) continue;
    const ls = Core.lotState(l), end = ls.closed ? ls.closeDate : todayISO(), bars = new Map(h.bars.map(b => [b[0], b[1]]));
    const have = new Set((out[t] || []).map(x => x.date)), add = [];
    for (const d of days) {
      if (d < l.date || d > end || have.has(d) || !bars.has(d)) continue;
      add.push({ date: d, price: bars.get(d), carry: true }); carry.add(d + '|' + t); have.add(d);
    }
    if (add.length) out[t] = (out[t] || []).concat(add).sort((a, b) => a.date < b.date ? -1 : 1);
  }
  return { prices: out, carry };
}
// Libellé d'une case : la période elle-même (lundi → vendredi, mois, année civile), ou « depuis le … » si le carnet commence pendant la période.
const fmtWd = d => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
function perfSub(k, p) {
  if (k === 'itd') return 'depuis le ' + fmtDate(p.from).replace(/ \d{4}$/, '');
  if (k === 'day') return fmtWd(p.to) + ' vs ' + fmtWd(p.from);
  if (p.from >= p.start) return 'depuis le ' + fmtDate(p.from).replace(/ \d{4}$/, '');   // début du carnet dans la période
  if (k === 'week') { const fri = addDays(p.start, 4); return `du ${fmtWd(p.start).replace(/ \S+$/, '')} au ${fmtWd(fri)}`; }
  if (k === 'month') return new Date(p.start + 'T12:00:00').toLocaleDateString('fr-FR', { month: 'long' }) + ', depuis le 1er';
  return p.start.slice(0, 4) + ', depuis le 1er janv.';
}
function perf() {
  const today = todayISO(), pp = perfPrices();
  const obs = Core.observations(Object.assign({}, S, { prices: pp.prices }), today);
  // Un point n'est estimé que si une position ouverte ce jour-là a utilisé un cours reporté.
  const openOn = d => S.lots.filter(l => l.date <= d && !Core.lotState(l).closed || l.date <= d && l.events.some(e => e.type === 'sell' && e.date > d)).map(l => l.ticker);
  const estD = new Set(obs.filter(o => o.source === 'app' && openOn(o.date).some(t => pp.carry.has(o.date + '|' + t))).map(o => o.date));
  const t = Core.twr(obs, S.flows);
  const pts = t.points.map(p => estD.has(p.date) ? Object.assign({}, p, { est: true }) : p);
  // Jour / semaine / mois / année : séances seulement (samedi et dimanche n'ont pas de cotation). Référence : la dernière clôture
  // avant le début de la période (vendredi pour la semaine, dernier jour de bourse du mois ou de l'année d'avant).
  const tp = pts.filter(p => wdOf(p.date) >= 1 && wdOf(p.date) <= 5);
  const y = today.slice(0, 4), m = today.slice(0, 7), lastD = tp.length ? tp[tp.length - 1].date : today;
  const per = (from, k) => { const r = Core.periodReturn(tp, from, today); return r && Object.assign(r, { k, start: from }); };
  return {
    obs, pts, broken: t.broken, brokenAt: t.brokenAt,
    day: per(lastD, 'day'),
    week: per(weekKey(lastD), 'week'),
    month: per(lastD.slice(0, 7) + '-01', 'month'),
    year: per(lastD.slice(0, 4) + '-01-01', 'year'),
    itd: pts.length > 1 ? { r: (pts[pts.length - 1].index - 1) * 100, from: pts[0].date, to: pts[pts.length - 1].date, est: pts.some(p => p.est) } : null,
    dd: Core.maxDrawdown(pts), freq: Core.frequency(pts), estCount: pts.filter(p => p.est).length
  };
}

// ---------- Cours automatiques (Finnhub) : en direct pendant la séance, clôture enregistrée une fois le marché fermé ----------
// Les cours en direct restent en mémoire (affichage) ; seule la clôture de chaque séance est enregistrée et synchronisée.
const QUOTE_KEY = 'carnet-positions:finnhub';
const Live = { prices: {}, at: 0, busy: false, err: '', miss: [] };
const QUICK_MAX = 30;  // cours demandés toutes les 2 minutes entre deux mises à jour complètes
const manualSet = () => new Set((S.settings.manualTickers || []).map(t => String(t).toUpperCase()));
function setManual(list, msg) {
  S.settings.manualTickers = [...new Set(list.map(t => t.toUpperCase()))].sort();
  // Retire les cours récupérés automatiquement pour ces actions (ils pouvaient venir d'une autre société).
  let removed = 0;
  for (const t of S.settings.manualTickers) {
    delete Live.prices[t];
    if (S.prices[t]) { const n = S.prices[t].length; S.prices[t] = S.prices[t].filter(x => x.src !== 'auto'); removed += n - S.prices[t].length; }
  }
  save(msg + (removed ? ` · ${removed} cours automatique(s) retiré(s)` : ''));
}
const quoteKey = () => { try { return localStorage.getItem(QUOTE_KEY) || ''; } catch (e) { return ''; } };
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const NY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyParts(ms) {
  const p = {};
  for (const x of NY_FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
// Séance régulière NYSE / Nasdaq : 9 h 30 – 16 h à New York, du lundi au vendredi (jours fériés non gérés).
function marketOpen(ms) {
  const n = nyParts(ms), wd = new Date(n.date + 'T12:00:00').getDay();
  return wd >= 1 && wd <= 5 && n.min >= 570 && n.min < 960;
}
async function fetchQuote(sym, key) {
  // Depuis un navigateur, Finnhub n'accepte la clé que dans l'adresse (l'en-tête est bloqué par CORS).
  const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + encodeURIComponent(key), { cache: 'no-store' });
  if (r.status === 401) throw Object.assign(new Error('clé Finnhub refusée'), { stop: true });
  if (r.status === 403) return { c: 0, t: 0 };
  if (r.status === 429) throw Object.assign(new Error('limite gratuite atteinte, réessayez dans une minute'), { stop: true });
  if (!r.ok) throw new Error('erreur Finnhub ' + r.status);
  return r.json();
}
// ----- Résultats trimestriels (calendrier Finnhub) : information seulement, gardés sur cet appareil -----
// Earn.map : { TICKER: [[date, heure, BPA attendu, BPA publié, CA attendu, CA publié, trimestre, exercice], …] } ; heure « bmo » avant l'ouverture, « amc » après la clôture.
// Earn.hist : { TICKER: { at, q: [[période, BPA publié, BPA attendu, trimestre, exercice], …] } } (4 derniers trimestres, Finnhub /stock/earnings).
const EARN_KEY = 'carnet-positions:earnings', EARN_SOON = 14;
const Earn = (() => { try { return JSON.parse(localStorage.getItem(EARN_KEY)) || {}; } catch (e) { return {}; } })();
Earn.map = Earn.map || {}; Earn.hist = Earn.hist || {};
async function refreshEarnings() {
  const key = quoteKey(), today = todayISO();
  // Une fois par jour ; plus souvent (toutes les 3 h) tant qu'une publication récente attend ses chiffres.
  const waiting = Object.values(Earn.map).some(l => l.some(e => e[0] >= addDays(today, -3) && e[0] <= today && e[3] == null));
  if (!key || Earn.busy || (Earn.day === today && !(waiting && Date.now() - (Earn.at || 0) > 3 * 3600e3))) return;
  Earn.busy = true;
  const want = new Set([...S.lots.map(l => l.ticker), ...S.watch.map(w => w.ticker)]);
  // La première fois, on remonte jusqu'aux sorties sous le stop (statistique) ; ensuite 10 jours suffisent.
  let from = addDays(today, -15);
  if (!Earn.day) for (const l of S.lots) for (const e of l.events) if (e.type === 'sell' && e.date < from) from = e.date;
  if (!Earn.day) from = addDays(from, -7);
  const end = addDays(today, 100);
  let ok = 0;
  try {
    for (let a = from; a <= end; a = addDays(a, 31)) {
      const b = addDays(a, 30) < end ? addDays(a, 30) : end;
      const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${a}&to=${b}&token=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (r.status === 401 || r.status === 429) break;
      if (!r.ok) continue;
      const rows = ((await r.json()) || {}).earningsCalendar || [];
      // Les dates annoncées bougent : on remplace celles de la fenêtre par les nouvelles.
      for (const t of want) if (Earn.map[t]) Earn.map[t] = Earn.map[t].filter(([d]) => d < a || d > b);
      for (const x of rows) {
        const t = String(x.symbol || '').toUpperCase();
        if (!want.has(t) || !/^\d{4}-\d{2}-\d{2}$/.test(x.date || '')) continue;
        const list = Earn.map[t] = Earn.map[t] || [];
        const nb = v => isNum(v) ? v : null;
        if (!list.some(([d]) => d === x.date)) list.push([x.date, x.hour || '', nb(x.epsEstimate), nb(x.epsActual), nb(x.revenueEstimate), nb(x.revenueActual), x.quarter || 0, x.year || 0]);
      }
      ok++;
    }
    if (ok) {
      for (const t in Earn.map) { Earn.map[t].sort((x, y) => x[0] < y[0] ? -1 : 1); if (!Earn.map[t].length) delete Earn.map[t]; }
      Earn.day = today; Earn.at = Date.now();
      // Historique des surprises : actions qui publient dans les 14 jours (ou viennent de publier), au plus 8 appels.
      let calls = 0;
      for (const t of want) {
        if (calls >= 8) break;
        const l = Earn.map[t] || [], soon = l.some(([d]) => d >= addDays(today, -14) && d <= addDays(today, 14)), h = Earn.hist[t];
        const last = l.filter(([d]) => d < today).map(([d]) => d).pop();
        if (!soon || (h && Core.days(h.at, today) < 20 && !(last && h.at <= last))) continue;
        calls++;
        try {
          const r = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(t)}&limit=4&token=${encodeURIComponent(key)}`, { cache: 'no-store' });
          if (r.status === 401 || r.status === 429) break;
          const j = r.ok ? await r.json() : null;
          if (Array.isArray(j)) Earn.hist[t] = { at: today, q: j.filter(x => isNum(x.actual)).slice(0, 4).map(x => [x.period, x.actual, isNum(x.estimate) ? x.estimate : null, x.quarter || 0, x.year || 0]) };
        } catch (e) { break; }
      }
      try { localStorage.setItem(EARN_KEY, JSON.stringify({ day: Earn.day, at: Earn.at, map: Earn.map, hist: Earn.hist })); } catch (e) {}
      if (tab !== 'calc' && tab !== 'set') render();
    }
  } catch (e) { /* hors ligne : on réessaiera */ } finally { Earn.busy = false; }
}
const nextEarn = t => (Earn.map[t] || []).find(([d]) => d >= todayISO()) || null;
const EARN_H = { bmo: 'avant l’ouverture', amc: 'après la clôture', dmh: 'pendant la séance' };
function earnPill(t) {
  const e = nextEarn(t); if (!e) return '';
  const n = Core.days(todayISO(), e[0]); if (n > EARN_SOON) return '';
  const when = n === 0 ? 'aujourd’hui' : n === 1 ? 'demain' : `dans ${n} j`;
  return ` <span class="pill earn" title="Résultats le ${fmtDate(e[0])}${EARN_H[e[1]] ? ' ' + EARN_H[e[1]] : ''} (date annoncée, peut bouger)">Résultats ${when}</span>`;
}
// ----- Calendrier des résultats : positions ouvertes et actions du radar (dates Finnhub, peuvent bouger) -----
const EARN_F_KEY = 'carnet-positions:earn-f';
let earnF = (() => { try { return localStorage.getItem(EARN_F_KEY) || 'all'; } catch (e) { return 'all'; } })();
const fmtEarnD = memo(d => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }));
const EARN_HS = { bmo: 'avant ouv.', amc: 'après clôt.', dmh: 'en séance' };
function earnRows(maxDays) {
  const today = todayISO(), openL = S.lots.filter(l => !Core.lotState(l).closed), openT = new Set(openL.map(l => l.ticker));
  const radT = new Set(S.watch.filter(w => !w.idx).map(w => w.ticker)), out = [];
  for (const t of new Set([...openT, ...radT])) {
    const e = nextEarn(t); if (!e) continue;
    const n = Core.days(today, e[0]); if (maxDays != null && n > maxDays) continue;
    const x = { t, d: e[0], h: e[1], e, n, pos: openT.has(t), rad: radT.has(t), near: false, sec: sectorOf(t) || '' };
    if (x.pos) {
      const v = lotView(openL.find(l => l.ticker === t)), st = v.lot.stopCurrent, p = v.last ? v.last.price : null;
      if (isNum(st) && st > 0 && p > 0) x.stopPct = (st - p) / p * 100;
    } else {
      let best = null;
      for (const w of S.watch.filter(w => w.ticker === t && !w.idx)) { const a = analyzeWatch(w); if (a && !a.short && radarRank(a) <= 2 && (!best || Math.abs(a.dist) < Math.abs(best.a.dist))) best = { w, a }; }
      if (best) { x.near = true; x.sma = best; }
    }
    out.push(x);
  }
  return out.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (b.pos - a.pos) || (b.near - a.near) || (a.t < b.t ? -1 : 1));
}
const EARN_IC = { bmo: ['ti-sun', 'avant l’ouverture'], amc: ['ti-moon', 'après la clôture'], dmh: ['ti-clock', 'pendant la séance'] };
const earnWhen = n => n === 0 ? '<span class="ecd hot">aujourd’hui</span>' : n === 1 ? '<span class="ecd hot">demain</span>' : `<span class="ecd">J-${n}</span>`;
// Ligne compacte (carte du tableau de bord)
function earnRow(x) {
  const tag = x.pos ? ' <span class="pill open">Position</span>' : x.near ? ' <span class="pill warn">Proche SMA</span>' : '';
  return `<div class="erow"><span><strong>${esc(x.t)}</strong>${tag}</span><span class="muted">${fmtEarnD(x.d)}${EARN_HS[x.h] ? ' · ' + EARN_HS[x.h] : ''} ${earnWhen(x.n)}</span></div>`;
}
// Fiche du calendrier : tuile de date, moment, secteur, distance au stop ou à la SMA
const fmt2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eps$ = v => isNum(v) ? fmt2.format(v).replace('-', '−') + ' $' : '—';
const rev$ = v => !isNum(v) ? '—' : Math.abs(v) >= 1e9 ? fmtNum(v / 1e9, 1) + ' Md$' : fmtNum(v / 1e6, 0) + ' M$';
const surp = (a, e) => isNum(a) && isNum(e) && e !== 0 ? (a - e) / Math.abs(e) * 100 : null;
const surpTxt = v => v == null ? '' : `<span class="${v >= 0 ? 'gain' : 'loss'}">${v >= 0 ? '+' : '−'}${fmtNum(Math.abs(v), 1)} %</span>`;
// Avant publication : attentes du consensus, BPA d'il y a un an, 4 derniers trimestres (au-dessus / en dessous)
function earnEst(x) {
  const [, , ee, , re, , q, y] = x.e, h = Earn.hist[x.t];
  const ago = h && q && y ? h.q.find(r => r[3] === q && r[4] === y - 1) : null;
  const rows = [isNum(ee) ? `<span class="k">BPA attendu</span><span>${eps$(ee)}</span><span class="muted">${ago ? 'il y a 1 an ' + eps$(ago[1]) : ''}</span>` : '',
    isNum(re) ? `<span class="k">CA attendu</span><span>${rev$(re)}</span><span></span>` : ''].join('');
  const past = h ? h.q.filter(r => isNum(r[2])) : [];
  const beats = past.filter(r => r[1] >= r[2]).length;
  const dots = past.length ? `<p class="emeta">${past.length} derniers : ${past.slice().reverse().map(r => `<i class="edot ${r[1] >= r[2] ? 'up' : 'dn'}" title="${esc(r[0])} : ${eps$(r[1])} publié, ${eps$(r[2])} attendu"></i>`).join('')} ${beats} au-dessus des attentes</p>` : '';
  return (q && y ? `<p class="emeta">Trimestre T${q} ${y} (exercice de la société)</p>` : '') + (rows ? `<div class="egrid">${rows}</div>` : '') + dots;
}
// Après publication : chiffres contre attentes, réaction du cours (historique du radar), croisement de SMA depuis
function earnReact(t, d, h) {
  const w = S.watch.find(w => w.ticker === t && !w.idx); if (!w) return null;
  const hh = histFixed(symOf(w), Radar.hist[symOf(w)]); if (!hh || !hh.bars.length) return null;
  const b = hh.bars, after = h === 'amc';
  let i = -1; for (let k = b.length - 1; k >= 0; k--) if (after ? b[k][0] <= d : b[k][0] < d) { i = k; break; }
  if (i < 0) return null;
  const nx = b[i + 1];
  return nx ? { pct: (nx[1] / b[i][1] - 1) * 100, date: nx[0] } : { wait: true };
}
function earnDone(t, e, pos) {
  const [d, h, ee, ea, re, ra] = e, se = surp(ea, ee), sr = surp(ra, re);
  const dt = new Date(d + 'T12:00:00');
  const tag = pos ? ' <span class="pill open">Position</span>' : '';
  const verdict = !isNum(ea) ? '<span class="ecd">chiffres à venir</span>' : se == null ? '<span class="ecd">publié</span>' : se >= 0 ? '<span class="pill win">Au-dessus</span>' : '<span class="pill loss">En dessous</span>';
  let body = '';
  if (isNum(ea) || isNum(ra)) body = `<div class="egrid">${isNum(ea) ? `<span class="k">BPA</span><span>${eps$(ea)} <span class="muted">/ ${eps$(ee)}</span></span>${surpTxt(se) || '<span></span>'}` : ''}${isNum(ra) ? `<span class="k">CA</span><span>${rev$(ra)} <span class="muted">/ ${rev$(re)}</span></span>${surpTxt(sr) || '<span></span>'}` : ''}</div>`;
  else body = '<p class="emeta">Publié, chiffres pas encore reçus (souvent le lendemain).</p>';
  const r = earnReact(t, d, h), cr = [];
  for (const w of S.watch.filter(w => w.ticker === t && !w.idx)) { const a = analyzeWatch(w); if (a && !a.short && a.lastCross && a.lastCross.date >= d) cr.push(`${a.lastCross.dir === 'down' ? 'passé sous' : 'passé au-dessus de'} sa SMA ${w.period} ${TF_SHORT[w.tf]}`); }
  const rl = r && !r.wait ? `Réaction du cours : ${surpTxt(r.pct)} à la clôture du ${fmtDate(r.date).replace(/ \d{4}$/, '')}` : r && r.wait ? 'Réaction du cours : à la prochaine clôture' : '';
  return `<div class="eitem${pos ? ' pos' : ''}"><div class="etile"><span>${dt.toLocaleDateString('fr-FR', { weekday: 'short' })}</span><b>${dt.getDate()}</b><span>${dt.toLocaleDateString('fr-FR', { month: 'short' })}</span></div>
    <div class="ebody"><div class="ehead"><span><strong>${esc(t)}</strong>${tag}</span>${verdict}</div>${body}${rl || cr.length ? `<p class="emeta">${[rl, ...cr].filter(Boolean).join(' · ')}</p>` : ''}</div></div>`;
}
function earnRecent(f) {
  const today = todayISO(), openT = new Set(S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker)), out = [];
  for (const t of new Set([...openT, ...S.watch.filter(w => !w.idx).map(w => w.ticker)])) {
    if (f === 'pos' && !openT.has(t)) continue; if (f === 'radar' && openT.has(t)) continue;
    for (const e of Earn.map[t] || []) if (e[0] >= addDays(today, -14) && (e[0] < today || (e[0] === today && isNum(e[3])))) out.push({ t, e, pos: openT.has(t) });
  }
  return out.sort((a, b) => a.e[0] > b.e[0] ? -1 : 1);
}
function earnItem(x) {
  const dt = new Date(x.d + 'T12:00:00'), ic = EARN_IC[x.h];
  const wd = dt.toLocaleDateString('fr-FR', { weekday: 'short' }), mo = dt.toLocaleDateString('fr-FR', { month: 'short' });
  const tag = x.pos ? ' <span class="pill open">Position</span>' : x.near ? ' <span class="pill warn">Proche SMA</span>' : '';
  const meta = [ic ? `<i class="eic ${x.h}">${x.h === 'bmo' ? '☀' : x.h === 'amc' ? '☾' : '◷'}</i> ${ic[1]}` : 'heure non annoncée', x.sec ? esc(x.sec) : ''].filter(Boolean).join(' · ');
  let extra = '';
  extra += earnEst(x);
  if (x.pos && x.stopPct != null) extra += `<p class="${x.n <= 7 ? 'ewarn' : 'emeta'}">Stop à ${fmtNum(x.stopPct, 1)} % du cours${x.n <= 7 ? ' · risque de trou à l’ouverture' : ''}</p>`;
  else if (x.pos) extra += '<p class="ewarn">Aucun stop enregistré</p>';
  else if (x.near) extra += `<p class="emeta">à ${fmtNum(Math.abs(x.sma.a.dist), 1)} % de sa SMA ${x.sma.w.period} ${TF_SHORT[x.sma.w.tf]}${x.sma.a.dist >= 0 ? ' (au-dessus)' : ' (en dessous)'}</p>`;
  return `<div class="eitem${x.pos ? ' pos' : ''}"><div class="etile"><span>${wd}</span><b>${dt.getDate()}</b><span>${mo}</span></div>
    <div class="ebody"><div class="ehead"><span><strong>${esc(x.t)}</strong>${tag}</span>${earnWhen(x.n)}</div><p class="emeta">${meta}</p>${extra}</div></div>`;
}
function earnCard() {
  const xs = earnRows(7); if (!xs.length) return '';
  const pos = xs.filter(x => x.pos).map(x => esc(x.t));
  return `<section class="card"><div class="sec-head"><h2>Résultats <small>· 7 prochains jours</small></h2><button class="btn sm" data-tab="earn">Calendrier</button></div>
    <div class="elist">${xs.slice(0, 6).map(earnRow).join('')}</div>${xs.length > 6 ? `<p class="hint">+ ${xs.length - 6} autre(s) dans le calendrier.</p>` : ''}
    ${pos.length ? `<p class="hint warn-t">${pos.join(', ')} : risque d’écart à l’ouverture (le stop ne protège pas d’un trou de cours). Garder, alléger ou resserrer : à vous de voir.</p>` : ''}</section>`;
}
// Bandeau : jours de bourse de la semaine en cours et de la suivante, un point par publication
function earnStrip(all, today) {
  const mon = addDays(today, -((wdOf(today) + 6) % 7)), days = [];
  for (let k = 0; k < 14; k++) { const d = addDays(mon, k); if (wdOf(d) >= 1 && wdOf(d) <= 5) days.push(d); }
  const cell = d => {
    const xs = all.filter(x => x.d === d), dt = new Date(d + 'T12:00:00');
    const dots = xs.slice(0, 4).map(x => `<i class="${x.pos ? 'p' : x.near ? 'n' : 'r'}"></i>`).join('') + (xs.length > 4 ? '<em>+</em>' : '');
    return `<div class="eday${d === today ? ' today' : ''}${d < today ? ' past' : ''}" title="${xs.map(x => x.t).join(', ')}"><span>${dt.toLocaleDateString('fr-FR', { weekday: 'narrow' })}</span><b>${dt.getDate()}</b><div class="edots">${dots}</div></div>`;
  };
  return `<div class="estrip">${days.slice(0, 5).map(cell).join('')}</div><div class="estrip">${days.slice(5).map(cell).join('')}</div>
    <p class="elegend"><i class="p"></i> position · <i class="n"></i> proche SMA · <i class="r"></i> radar</p>`;
}
function viewEarn() {
  if (!Radar.loaded && S.watch.length) loadRadarCache().then(() => { if (tab === 'earn') render(); });
  const all = earnRows(null), today = todayISO();
  const xs = all.filter(x => earnF === 'pos' ? x.pos : earnF === 'radar' ? !x.pos : true);
  const sun = addDays(today, (7 - wdOf(today)) % 7), sun2 = addDays(sun, 7);
  const wk = xs.filter(x => x.d <= sun), nx = xs.filter(x => x.d > sun && x.d <= sun2), later = xs.filter(x => x.d > sun2);
  const nPos = all.filter(x => x.pos).length, wkAll = all.filter(x => x.d <= sun), wkPos = wkAll.filter(x => x.pos).length;
  const fB = (k, l, n) => `<button class="btn sm" data-act="earn-f" data-f="${k}" aria-pressed="${earnF === k}">${l} ${n}</button>`;
  const known = new Set(all.map(x => x.t)), every = new Set([...S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker), ...S.watch.filter(w => !w.idx).map(w => w.ticker)]);
  const none = [...every].filter(t => !known.has(t)).sort();
  const chip = x => `<span class="echip${x.pos ? ' pos' : ''}"><strong>${esc(x.t)}</strong> · ${fmtDate(x.d).replace(/ \d{4}$/, '')}</span>`;
  const sec = (h, g, fn) => g.length ? `<h3 class="ewk">${h}</h3>${fn(g)}` : '';
  const body = !quoteKey() ? '<p class="lead">Ajoutez la clé Finnhub (Réglages › Cours automatiques) pour charger le calendrier des résultats.</p>'
    : !Earn.day ? '<p class="lead">Calendrier en cours de chargement…</p>'
    : `${earnStrip(all, today)}<div class="row">${fB('all', 'Tout', all.length)}${fB('pos', 'Positions', nPos)}${fB('radar', 'Radar', all.length - nPos)}</div>
      ${xs.length ? sec('Cette semaine', wk, g => g.map(earnItem).join('')) + sec('Semaine prochaine', nx, g => g.map(earnItem).join('')) : ''}
      ${sec('Publiés récemment · 14 jours', earnRecent(earnF), g => g.map(x => earnDone(x.t, x.e, x.pos)).join(''))}
      ${xs.length ? sec('Plus tard', later, g => `<div class="echips">${g.map(chip).join('')}</div>`) : '<p class="lead">Aucune date de résultats à venir pour ce filtre dans les 100 prochains jours.</p>'}
      <p class="hint">BPA = bénéfice par action, CA = chiffre d’affaires. Attentes : consensus des analystes (Finnhub), parfois absent pour les petites valeurs.</p>`;
  return `<section class="card">
    <div class="sec-head"><h2>Résultats</h2><button class="btn sm" data-tab="radar">← Radar</button></div>
    <p class="lead">${Earn.day && quoteKey() ? `${wkAll.length ? `${wkAll.length} cette semaine${wkPos ? ` · dont ${wkPos} position${wkPos > 1 ? 's' : ''}` : ''}` : 'Rien cette semaine'}. ` : ''}Positions et radar sur 100 jours · dates Finnhub, elles peuvent bouger.</p>
    ${body}
    ${none.length && Earn.day ? `<p class="hint">Sans prochaine date connue : ${none.map(esc).join(', ')}.</p>` : ''}
  </section>`;
}
// Pastille sur l'icône (écran d'accueil) : stops à remonter + nouveaux croisements de SMA non vus.
// Le service worker y ajoute les éléments des notifications reçues app fermée ; l'app remet le vrai compte à chaque affichage.
let badgeT = 0, badgeN = -1;
function badgeSoon() { clearTimeout(badgeT); badgeT = setTimeout(updateBadge, 800); }
function updateBadge() {
  if (!('setAppBadge' in navigator) || document.visibilityState !== 'visible') return;
  let n = 0;
  try { if (S.watch.length && Radar.loaded) n = stopRaises().length + radarAlerts().filter(x => !x.seen && x.lvl !== 'near').length; else return; } catch (e) { return; }
  if (n === badgeN) return;
  badgeN = n;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  if (window.caches) caches.open('carnet-badge').then(c => c.put('./badge-n', new Response(String(n)))).catch(() => {});
}
// Sortie « autour des résultats » : vente entre le jour de publication et 4 jours après (publication après la clôture, week-end).
const nearEarn = (t, d) => (Earn.map[t] || []).some(([e]) => e <= d && d <= addDays(e, 4));
// hotOnly : pendant la séance, entre deux mises à jour complètes, seulement les positions ouvertes
// et les actions du radar proches de leur SMA (limite gratuite Finnhub : 60 requêtes par minute).
async function refreshQuotes(manual, hotOnly) {
  const key = quoteKey();
  if (!key || Live.busy) return;
  refreshEarnings(); refreshSectors();
  const skip = manualSet();
  const openT = new Set(S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker));
  // Ordre : indices, positions ouvertes, puis actions du radar de la plus proche à la plus éloignée de sa SMA.
  const hot = [...hotTickers()];
  let tickers = [...new Set([...IDX.map(x => x[0]).filter(t => S.watch.some(w => w.ticker === t)), ...[...openT].sort(), ...hot, ...S.watch.filter(w => !w.sym).map(w => w.ticker).sort()])].filter(t => !skip.has(t));
  // Avec le robot, les clôtures du radar viennent de lui : cours en direct seulement pour les positions et les actions proches de leur SMA.
  if (hotOnly || Radar.shared) { const h = new Set(hot); tickers = tickers.filter(t => openT.has(t) || h.has(t)); }
  // Entre deux mises à jour complètes, budget réduit : la clé gratuite (60 requêtes par minute) sert aussi à l'autre appareil.
  if (hotOnly) tickers = tickers.slice(0, Math.max(QUICK_MAX, openT.size + IDX.length));
  if (!tickers.length) return;
  Live.busy = true;
  if (manual) toast('Récupération des cours…');
  // D'abord récupérer les changements de l'autre appareil, pour ne pas créer de conflit en enregistrant une clôture.
  if (typeof syncNow === 'function' && Store.cfg) {
    const idle = async () => { while (Store.busy) await new Promise(r => setTimeout(r, 200)); };
    await idle(); await syncNow(); await idle();
  }
  if (S.watch.length) await loadRadarCache();
  const ny = nyParts(Date.now()), got = {}, miss = [], pace = tickers.length > 20 ? 1100 : 0;
  let saved = 0, appended = 0, err = '', shown = Date.now();
  // Les cours s'affichent au fur et à mesure, sans attendre la fin de la liste.
  Live.prices = Object.assign({}, Live.prices);
  const show = () => { Live.at = Date.now(); shown = Live.at; if (tab === 'dash' || tab === 'radar') render(); };
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    if (pace && i) await new Promise(r => setTimeout(r, pace));
    try {
      const q = await fetchQuote(t, key).catch(async e => {
        if (!/limite/.test(e.message)) throw e;
        Live.err = 'limite gratuite atteinte : reprise dans une minute'; if (tab === 'dash') render();
        await new Promise(r => setTimeout(r, 61000)); return fetchQuote(t, key);
      });
      if (!(q && q.c > 0 && q.t > 0)) { miss.push(t); continue; }
      const d = nyParts(q.t * 1000).date;
      got[t] = Live.prices[t] = { date: d, price: q.c, live: true, at: q.t * 1000, dp: q.dp };
      if (i === IDX.length - 1 || Date.now() - shown > 8000) show();
      // Séance terminée (16 h 05 à New York passé, ou jour suivant) : le dernier cours est la clôture.
      if (ny.date > d || ny.min >= 965) {
        if (openT.has(t)) {
          const ex = (S.prices[t] || []).find(x => x.date === d);
          if (!ex || (ex.src === 'auto' && ex.price !== q.c)) { addPrice(t, d, q.c, false, 'auto'); saved++; }
        }
        if (await appendClose(t, d, q.c)) appended++;
      }
    } catch (e) { err = e.message; if (e.stop) break; }
  }
  // Mise à jour complète : on oublie les actions qui ne sont plus suivies.
  if (!hotOnly) for (const t in Live.prices) if (!got[t] && !tickers.includes(t)) delete Live.prices[t];
  Object.assign(Live, { at: Date.now(), err, busy: false });
  if (!hotOnly) { Live.miss = miss; Live.fullAt = Date.now(); }
  if (saved) save(manual ? `Cours mis à jour · ${saved} clôture(s) enregistrée(s)` : '');
  else { if (tab !== 'calc') render(); if (manual) toast(err ? 'Cours : ' + err : 'Cours mis à jour'); }
}
// Affichage : les cours en direct remplacent le dernier cours enregistré, sans être sauvegardés.
function withLive(prices) {
  const out = Object.assign({}, prices);
  for (const t in Live.prices) {
    const L = Live.prices[t];
    out[t] = (prices[t] || []).filter(x => x.date !== L.date).concat([L]).sort((a, b) => a.date < b.date ? -1 : 1);
  }
  return out;
}
function liveBar() {
  if (!quoteKey()) return '';
  const n = Object.keys(Live.prices).length, open = marketOpen(Date.now());
  const txt = !Live.at ? 'Récupération des cours…'
    : `${open ? '<strong>Marché ouvert</strong> · cours en direct' : '<strong>Marché fermé</strong> · cours de clôture'} de ${n} action(s), mis à jour à ${hhmm(Live.at)}`;
  const man = [...manualSet()].filter(t => S.lots.some(l => l.ticker === t && !Core.lotState(l).closed));
  return `<div class="alert live ${open ? 'on' : ''}"><span>${txt}${man.length ? `<br><small>Saisie manuelle : ${man.map(esc).join(', ')}</small>` : ''}${Live.miss.length ? `<br><small>Non trouvé(s) sur Finnhub, à saisir à la main : ${Live.miss.map(esc).join(', ')}</small>` : ''}${Live.err ? `<br><small>${esc(Live.err)}</small>` : ''}</span><button class="btn sm" data-act="quotes-now" ${Live.busy ? 'disabled' : ''}>Actualiser</button></div>`;
}
function quotesPanel() {
  const k = quoteKey();
  return `<section class="card">
    <div class="sec-head"><h2>Cours automatiques</h2>${k ? '<span class="pill win">Actif sur cet appareil</span>' : ''}</div>
    <p class="lead">Avec une clé gratuite Finnhub, l’app affiche les cours en direct à l’ouverture pendant la séance de Wall Street, et enregistre la clôture de chaque action une fois le marché fermé. Ce sont les cours de la bourse : ceux de votre CFD peuvent différer légèrement, et c’est MT5 qui déclenche les stops.</p>
    ${k ? `<div class="row"><button class="btn primary sm" data-act="quotes-now">Actualiser maintenant</button><button class="btn sm danger" data-act="quotes-off">Retirer la clé</button></div>${Live.err ? `<div class="banner err">Dernière tentative : ${esc(Live.err)}</div>` : ''}`
      : `<ol class="lead" style="padding-left:18px;margin:0;display:grid;gap:6px">
        <li>Créez un compte gratuit sur <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io</a>.</li>
        <li>Sur votre tableau de bord Finnhub, copiez la clé API (« API Key »).</li>
        <li>Collez-la ci-dessous, puis touchez Enregistrer. À faire sur chaque appareil.</li></ol>
      <div class="fields"><div class="fld wide"><label for="q-key">Clé API Finnhub</label><input id="q-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div></div>
      <div class="row"><button class="btn primary sm" data-act="quotes-on">Enregistrer et tester</button></div>`}
    <div class="fields"><div class="fld wide"><label for="q-manual">Actions à saisir à la main (non US, ou symbole d’une autre société sur Finnhub)</label>
      <input id="q-manual" value="${esc((S.settings.manualTickers || []).join(', '))}" autocapitalize="characters" autocomplete="off" placeholder="ex. NEM, WKL"></div></div>
    <div class="row"><button class="btn sm" data-act="quotes-manual">Enregistrer la liste</button></div>
    <p class="hint">Ces actions ne sont jamais cherchées sur Finnhub : leurs cours restent ceux que vous saisissez. La liste est synchronisée entre vos appareils. La clé, elle, reste sur cet appareil : elle n’est ni synchronisée ni exportée.</p>
  </section>`;
}

// ---------- Radar SMA : historique Twelve Data, SMA journalière / hebdo / mensuelle, alertes de clôture ----------
// La liste suivie (S.watch) est synchronisée ; l'historique reste sur l'appareil (IndexedDB), une requête par action et par jour.
const TD_KEY = 'carnet-positions:twelvedata', SEEN_KEY = 'carnet-positions:radar-vu';
const TF_SHORT = { D: 'J', W: 'S', M: 'M' }, TF_LONG = { D: 'journalière', W: 'hebdo', M: 'mensuelle' };
const Radar = { hist: {}, busy: false, done: 0, todo: 0, err: '', errs: {}, loaded: false, shared: false, robot: null };  // shared : historique tenu à jour par le robot GitHub
let radarQuery = '', radarFilter = 'all', radarSector = '';
const tdKey = () => { try { return localStorage.getItem(TD_KEY) || ''; } catch (e) { return ''; } };
const symOf = w => (w.sym || w.ticker).toUpperCase();
// Cours ajustés des dividendes (« all », comme le bouton ADJ de TradingView) ou des seules divisions d'actions (« splits »).
const adjMode = () => S.settings.adjDiv === false ? 'splits' : 'all';
const histOk = h => (h.adj || 'splits') === adjMode();
const HDB = {
  p: null,
  open() {
    if (!this.p) this.p = new Promise((res, rej) => {
      const r = indexedDB.open('carnet-historique', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('h');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.p;
  },
  async run(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise(res => { const tx = db.transaction('h', mode); const q = fn(tx.objectStore('h')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => res(null); });
    } catch (e) { return null; }
  },
  get(k) { return this.run('readonly', s => s.get(k)); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); }
};
const wdOf = memo(d => new Date(d + 'T12:00:00').getDay());
function nextWeekday(d) { do { d = addDays(d, 1); } while (wdOf(d) === 0 || wdOf(d) === 6); return d; }
function prevWeekday(d) { do { d = addDays(d, -1); } while (wdOf(d) === 0 || wdOf(d) === 6); return d; }
// Action du radar dont Finnhub fournit la clôture du jour (symbole US, cours automatique).
const finnhubCovers = sym => !!quoteKey() && !manualSet().has(sym) && S.watch.some(w => !w.sym && w.ticker === sym);
// Ajoute la clôture du jour (Finnhub) à l'historique gardé sur l'appareil, si elle suit directement la dernière clôture connue.
async function appendClose(sym, d, c) {
  const h = Radar.hist[sym];
  if (!h || !h.bars.length || !histOk(h) || !finnhubCovers(sym)) return false;
  const last = h.bars[h.bars.length - 1];
  if (d < last[0]) return false;
  if (d === last[0]) { if (last[1] === c) return false; last[1] = c; }
  else { if (last[0] < prevWeekday(d)) return false; h.bars.push([d, c]); h.last = d; }
  await HDB.set(sym, h);
  return true;
}
// Actions du radar à suivre en direct pendant la séance : proches de leur SMA ou en train de la croiser.
// Triées de la plus proche à la plus éloignée de sa SMA (indices et actions sans analyse en tête).
function hotTickers() {
  const best = new Map(), lim = 2 * (S.settings.nearPct || 2);
  for (const w of S.watch) {
    if (w.sym) continue;
    const a = w.idx ? null : analyzeWatch(w), d = w.idx ? -1 : !a || a.short || a.pending ? 0 : Math.abs(a.dist);
    if (d <= lim && !(best.get(w.ticker) <= d)) best.set(w.ticker, d);
  }
  return new Set([...best].sort((x, y) => x[1] - y[1]).map(x => x[0]));
}
// Dernière séance terminée à New York (jours fériés non gérés : la séance manquante est simplement absente des données).
const lsMemo = { min: -1, d: '' };
function lastSession(ms) {
  const m = Math.floor(ms / 60000);
  if (m === lsMemo.min) return lsMemo.d;
  const n = nyParts(ms); let d = n.date;
  if (!(wdOf(d) >= 1 && wdOf(d) <= 5 && n.min >= 965)) { do { d = addDays(d, -1); } while (wdOf(d) === 0 || wdOf(d) === 6); }
  lsMemo.min = m; lsMemo.d = d;
  return d;
}
const weekKey = memo(d => addDays(d, -((wdOf(d) + 6) % 7)));
const periodKey = (tf, d) => tf === 'M' ? d.slice(0, 7) : tf === 'W' ? weekKey(d) : d;
// Nombre de clôtures journalières nécessaires pour une SMA, avec une marge pour retrouver le dernier croisement.
function barsNeeded(w) { const n = w.period + 25; return Math.min(5000, w.tf === 'M' ? n * 22 : w.tf === 'W' ? n * 5 : n); }
// Twelve Data livre au plus 5000 séances : jusqu'à J 4975, S 975, M 202.
const maxPeriod = tf => tf === 'M' ? 202 : tf === 'W' ? 975 : 4975;
const periodOk = (tf, n) => Number.isInteger(n) && n >= 2 && n <= maxPeriod(tf);
async function tdSeries(sym, n, key) {
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=${n}&adjust=${adjMode()}&apikey=${encodeURIComponent(key)}`, { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (j.status === 'error' || !Array.isArray(j.values)) throw Object.assign(new Error(j.message || 'erreur ' + r.status), { code: j.code || r.status });
  return j.values.map(v => [String(v.datetime).slice(0, 10), +v.close]).filter(v => v[1] > 0).sort((a, b) => a[0] < b[0] ? -1 : 1);
}
async function loadRadarCache() {
  const miss = [...new Set(S.watch.map(symOf))].filter(s => !Radar.hist[s]);
  if (miss.length) {
    const got = await HDB.run('readonly', st => { const out = {}; for (const s of miss) { const r = st.get(s); r.onsuccess = () => { if (r.result) out[s] = r.result; }; } return { result: out }; });
    Object.assign(Radar.hist, got || {});
  }
  Radar.loaded = true;
}
// Met à jour l'historique des actions suivies : 8 requêtes par minute au plus (offre gratuite).
async function refreshRadar(manual) {
  const key = tdKey();
  if (!key || Radar.busy || !S.watch.length) return;
  Radar.busy = true; Radar.err = '';
  await loadRadarCache();
  const ls = lastSession(Date.now()), need = {};
  for (const w of S.watch) { const s = symOf(w); need[s] = Math.max(need[s] || 0, barsNeeded(w)); }
  // Twelve Data : premier chargement, historique trop court, ou trou que Finnhub ne peut pas combler (app non ouverte plusieurs jours).
  // Sinon, une vérification complète par semaine et par action (division d'actions, jour manqué), 15 actions au plus par ouverture.
  const prev = prevWeekday(ls), WEEK = 7 * 864e5, must = [], resync = [];
  for (const s of Object.keys(need)) {
    const h = Radar.hist[s];
    // le robot ajoute la clôture et vérifie l'historique ; après un changement de réglage, il retélécharge tout à son prochain passage
    if (Radar.shared && h && (histOk(h) || (Radar.robot.adj || 'splits') !== adjMode()) && h.n >= need[s] && h.last >= prev) continue;
    if (!h || h.n < need[s] || !histOk(h)) must.push(s);
    else if (h.last < ls && h.ls !== ls && !(finnhubCovers(s) && h.last >= prev)) must.push(s);
    else if (Date.now() - (h.full || 0) > WEEK) resync.push(s);
  }
  resync.sort((a, b) => (Radar.hist[a].full || 0) - (Radar.hist[b].full || 0));
  const todo = must.concat(resync.slice(0, 15));
  Radar.done = 0; Radar.todo = todo.length;
  if (manual) toast(todo.length ? `Historique : ${todo.length} action(s) à mettre à jour` : 'Radar à jour');
  if (tab === 'radar') render();
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    if (i) await new Promise(r => setTimeout(r, 8000));
    try {
      let bars = await tdSeries(s, need[s], key).catch(async e => {
        if (e.code === 429) { await new Promise(r => setTimeout(r, 61000)); return tdSeries(s, need[s], key); }
        throw e;
      });
      bars = bars.filter(b => b[0] <= ls);
      const h = { bars, n: need[s], last: bars.length ? bars[bars.length - 1][0] : '', ls, at: Date.now(), full: Date.now(), adj: adjMode() };
      Radar.hist[s] = h; await HDB.set(s, h); delete Radar.errs[s];
    } catch (e) {
      if (e.code === 401 || e.code === 403 && /key/i.test(e.message)) { Radar.err = 'clé Twelve Data refusée'; break; }
      Radar.errs[s] = e.message;
    }
    Radar.done = i + 1;
    if (tab === 'radar' || tab === 'dash') render();
  }
  Radar.busy = false;
  if (tab !== 'calc') render();
}
const groupMemo = new WeakMap();
function groupBars(daily, tf) {
  const L = daily[daily.length - 1], sig = tf + daily.length + L[0] + L[1];
  let g = groupMemo.get(daily); if (!g) groupMemo.set(daily, g = {});
  if (g[tf] && g[tf].sig === sig) return g[tf].out;
  const out = [];
  if (tf === 'D') { for (const [d, c] of daily) out.push({ k: d, d, c }); g[tf] = { sig, out }; return out; }
  for (const [d, c] of daily) {
    const k = periodKey(tf, d), last = out[out.length - 1];
    if (last && last.k === k) { last.c = c; last.d = d; } else out.push({ k, d, c });
  }
  g[tf] = { sig, out };
  return out;
}
const anaMemo = new Map();
// Dividendes que Twelve Data a oubliés, estimés par le robot (actions en position, cours ajustés) : [[ex-date, facteur, montant]].
const divEst = s => { const d = adjMode() === 'all' && Radar.robot && Radar.robot.divfix && Radar.robot.divfix[s]; return d && d.fx && d.fx.length ? d.fx : null; };
const fixMemo = new WeakMap();
function histFixed(s, h) {
  const fx = h && divEst(s); if (!fx) return h;
  const sig = JSON.stringify(fx), m = fixMemo.get(h);
  if (m && m.sig === sig) return m.out;
  const out = Object.assign({}, h, { bars: h.bars.map(b => { let k = 1; for (const x of fx) if (b[0] < x[0]) k *= x[1]; return [b[0], ...b.slice(1).map(v => v * k)]; }) });
  fixMemo.set(h, { sig, out });
  return out;
}
const divLate = s => { const d = adjMode() === 'all' && Radar.robot && Radar.robot.divfix && Radar.robot.divfix[s]; return d && d.late || null; };
function divNote(t) {
  const ss = [...new Set(S.watch.filter(w => w.ticker === t).map(symOf))];
  const fx = ss.map(divEst).find(Boolean), late = ss.map(divLate).find(Boolean), m = d => fmtDate(d).replace(/^\d+ /, '');
  return (fx ? `<p class="hint divest">Dividende(s) absent(s) des données Twelve Data, estimé(s) pour les SMA : ${fx.map(x => `${m(x[0])} (${usd(x[2])})`).join(', ')}.</p>` : '')
    + (late ? `<p class="banner warn divlate"><span><strong>Dividende à vérifier</strong> : dernier versement connu le ${fmtDate(late[0])}, le suivant (attendu vers ${m(late[1])}) manque peut-être dans les données. S'il a été versé, la SMA de l'app est un peu trop haute : comparez avec TradingView (ADJ) et montez le stop à la main si besoin.</span></p>` : '');
}
function analyzeWatch(w) {
  const h = histFixed(symOf(w), Radar.hist[symOf(w)]);
  if (!h || !h.bars.length) return null;
  const B = h.bars[h.bars.length - 1], live = Live.prices[w.ticker];
  const sig = [w.tf, w.period, h.bars.length, B[0], B[1], live ? live.price + '@' + live.at : '', lastSession(Date.now()), S.settings.nearPct].join('|');
  const m = anaMemo.get(w.id);
  if (m && m.h === h && m.sig === sig) return m.a;
  const a = analyzeRaw(w, h);
  anaMemo.set(w.id, { h, sig, a });
  return a;
}
function analyzeRaw(w, h) {
  const all = groupBars(h.bars, w.tf), ls = lastSession(Date.now());
  // Bougie hebdo ou mensuelle pas encore terminée : elle sert de cours actuel, pas de clôture.
  let done = all, forming = null;
  const L = all[all.length - 1];
  if (w.tf !== 'D' && L.k === periodKey(w.tf, ls) && periodKey(w.tf, nextWeekday(ls)) === L.k) { done = all.slice(0, -1); forming = L; }
  const n = w.period, c = done.map(b => b.c);
  if (c.length < n + 1) return { short: true, have: c.length };
  const pre = [0]; for (const x of c) pre.push(pre[pre.length - 1] + x);
  const sma = i => (pre[i + 1] - pre[i + 1 - n]) / n;
  const i = c.length - 1, s1 = sma(i), above = c[i] > s1, wasAbove = c[i - 1] > sma(i - 1);
  const cross = above !== wasAbove ? (above ? 'up' : 'down') : null;
  const crosses = [];
  for (let k = i; k >= n && crosses.length < 5; k--) { const sk = sma(k), a = c[k] > sk, b = c[k - 1] > sma(k - 1); if (a !== b) crosses.push({ dir: a ? 'up' : 'down', date: done[k].d, close: c[k], sma: sk }); }
  const lastCross = crosses[0] || null;
  const live = Live.prices[w.ticker];
  let p = c[i], src = 'clôture du ' + fmtDate(done[i].d).replace(/ \d{4}$/, ''), cur = false;
  if (live && live.date > done[i].d) { p = live.price; src = 'direct ' + hhmm(live.at); cur = true; }
  else if (forming) { p = forming.c; src = 'séance du ' + fmtDate(forming.d).replace(/ \d{4}$/, ''); cur = true; }
  const smaNow = cur ? (pre[i + 1] - pre[i + 2 - n] + p) / n : s1;
  const dist = (p - smaNow) / smaNow * 100;
  const pending = cur && (p > smaNow) !== above ? (p > smaNow ? 'up' : 'down') : null;
  const near = Math.abs(dist) <= (S.settings.nearPct || 2);
  return { lastClose: c[i], lastDate: done[i].d, sma: s1, smaNow, p, src, dist, above, cross, pending, near, lastCross, crosses };
}
// Alertes : chaque croisement (clôture au-dessus ou en dessous) reste affiché 15 jours après sa bougie ; « proche » tant que le cours est proche.
// « Vu » est retrouvé par action, SMA, sens et bougie (semaine ou mois entier pour S et M) : une bougie complétée plus tard,
// ou un historique un peu différent sur l'autre appareil, ne fait pas revenir une alerte déjà vue.
// Tolérance : une clôture corrigée plus tard (Finnhub le soir, Twelve Data à la vérification) peut décaler un croisement d'un ou deux jours.
const SEEN_TOL = { D: 4, W: 10, M: 35 };
const seenIdx = { ref: null, n: -1, m: null };
function seenIndex() {
  const s = S.seen, n = Object.keys(s).length;
  if (seenIdx.ref !== s || seenIdx.n !== n) {
    const m = new Map();
    for (const k in s) { const i = k.lastIndexOf('|'), p = k.slice(0, i); if (!m.has(p)) m.set(p, []); m.get(p).push(k.slice(i + 1)); }
    Object.assign(seenIdx, { ref: s, n, m });
  }
  return seenIdx.m;
}
function radarAlerts() {
  const out = [], idx = seenIndex(), lim = addDays(todayISO(), -ALERT_DAYS);
  for (const w of S.watch) {
    const a = analyzeWatch(w); if (!a || a.short) continue;
    const lab = `${esc(w.ticker)} · SMA ${w.period} ${TF_SHORT[w.tf]}`, id = `${w.id}|${w.tf}${w.period}`;
    for (const x of a.crosses) {
      if (x.date < lim) break;
      const pre = `${id}|${x.dir}`, pk = periodKey(w.tf, x.date);
      const hit = d => periodKey(w.tf, d) === pk || Math.abs(Core.days(d, x.date)) <= SEEN_TOL[w.tf];
      if ((idx.get('x:' + pre) || []).some(hit)) continue;   // supprimée à la main
      out.push({ key: `${pre}|${x.date}`, w, a, date: x.date, lvl: x.dir, seen: (idx.get(pre) || []).some(d => periodKey(w.tf, d) === pk || Math.abs(Core.days(d, x.date)) <= SEEN_TOL[w.tf]),
        txt: `<strong>${lab}</strong> : ${x.dir === 'up' ? 'clôture au-dessus' : 'clôture en dessous'} de la SMA (${usd(x.close)} contre ${usd(x.sma)}, bougie du ${fmtDate(x.date)})` });
    }
    // « Proche » vue : reste vue jusqu'au prochain croisement, et au plus 15 jours.
    // Supprimée à la main : ne revient qu'après un nouveau croisement de cette SMA.
    if (a.near && !(idx.get(`x:${id}|near`) || []).some(d => !a.lastCross || d >= a.lastCross.date)) {
      const pre = `${id}|near`, since = a.lastCross && a.lastCross.date > lim ? a.lastCross.date : lim;
      out.push({ key: `${pre}|${a.lastDate}`, w, a, date: a.lastDate, lvl: 'near', seen: (idx.get(pre) || []).some(d => d >= since),
        txt: `<strong>${lab}</strong> : proche de la SMA, ${pct(a.dist, true)} (${usd(a.p)} contre ${usd(a.smaNow)})` });
    }
  }
  return out;
}
const ALERT_DAYS = 15;
// Alertes vues : { clé: date où elle a été vue }, synchronisées entre appareils, oubliées au bout de 60 jours.
// Ancienne version : gardées sur l'appareil (liste de clés, puis objet), reprises une fois.
// Une seule fois : commission et swap IC Markets (CFD actions US) activés, et commission ajoutée aux achats et ventes
// déjà saisis sans frais. Le swap, lui, est estimé depuis la date d'achat de chaque position (Core.setSwap).
function migrateFees() {
  const s = S.settings;
  if (s.feesV >= 1) return;
  s.fees = Object.assign({}, s.fees);
  if (!s.fees.perShare && !s.fees.minComm) { s.fees.perShare = 0.02; s.fees.minComm = 0.02; }
  if (!s.swap || !s.swap.pct) s.swap = { pct: 5.93, triple: 5 };
  const f = Core.normFees(s.fees);
  for (const l of S.lots) {
    if (l.demo) continue;
    if (!(l.entryFee > 0)) l.entryFee = Core.roundTo(Core.commission(l.qty, f), 4);
    for (const e of l.events) if (e.type === 'sell' && !(e.fee > 0)) e.fee = Core.roundTo(Core.commission(e.qty, f), 4);
  }
  s.feesV = 1;
  save();
}
function migrateSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
    if (!v) return;
    const t = todayISO(), o = Array.isArray(v) ? Object.fromEntries(v.map(k => [k, t])) : v;
    for (const k in o) if (!S.seen[k]) S.seen[k] = o[k];
    localStorage.removeItem(SEEN_KEY); save();
  } catch (e) {}
}
const readSeen = () => S.seen;
function markSeen(keys) {
  const s = readSeen(), t = todayISO(), lim = addDays(t, -60);
  keys.forEach(k => s[k] = t);
  for (const k in s) if (s[k] < lim) delete s[k];
  seenIdx.n = -1; save();
}
function radarStatus(a) {
  if (!a) return ['', 'Historique en attente'];
  if (a.short) return ['', `Historique insuffisant (${a.have} bougies)`];
  if (a.cross === 'up') return ['win', 'Clôture au-dessus'];
  if (a.cross === 'down') return ['loss', 'Clôture en dessous'];
  if (a.pending === 'up') return ['open', 'Passe au-dessus (en cours)'];
  if (a.pending === 'down') return ['warn', 'Passe en dessous (en cours)'];
  if (a.near) return ['warn', 'Proche de la SMA'];
  return a.above ? ['', 'Au-dessus'] : ['', 'En dessous'];
}
function radarRank(a) { if (!a || a.short) return 9; if (a.cross) return 0; if (a.pending) return 1; if (a.near) return 2; return a.above ? 3 : 4; }
function viewRadar() {
  const key = tdKey();
  if (!Radar.loaded && S.watch.length) loadRadarCache().then(() => { if (tab === 'radar') render(); });
  const setup = `<section class="card">
    <div class="sec-head"><h2>Radar SMA</h2></div>
    <p class="lead">Le radar calcule la SMA de chaque action que vous suivez (journalière, hebdo ou mensuelle) et vous alerte quand le cours s’en approche, clôture au-dessus, ou clôture en dessous. Il faut une clé gratuite Twelve Data pour l’historique des cours.</p>
    <ol class="lead" style="padding-left:18px;margin:0;display:grid;gap:6px">
      <li>Créez un compte gratuit sur <a href="https://twelvedata.com/register" target="_blank" rel="noopener">twelvedata.com</a>.</li>
      <li>Dans votre espace Twelve Data, copiez la clé API (« API Keys »).</li>
      <li>Collez-la ci-dessous et touchez Enregistrer. À faire sur chaque appareil.</li></ol>
    <div class="fields"><div class="fld wide"><label for="td-key">Clé API Twelve Data</label><input id="td-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"></div></div>
    <div class="row"><button class="btn primary sm" data-act="td-on">Enregistrer et tester</button></div>
    <p class="hint">La clé reste sur cet appareil : elle n’est ni synchronisée ni exportée.</p>
  </section>`;
  // Une carte par action, avec ses SMA (J, S, M) en lignes ; la carte prend le statut le plus urgent de ses SMA.
  const tfOrder = { D: 0, W: 1, M: 2 }, groups = {}, recent = addDays(todayISO(), -ALERT_DAYS);
  for (const w of S.watch) if (!w.idx) (groups[w.ticker] = groups[w.ticker] || []).push({ w, a: analyzeWatch(w) });
  const cards = Object.keys(groups).map(t => {
    const lines = groups[t].sort((x, y) => tfOrder[x.w.tf] - tfOrder[y.w.tf] || y.w.period - x.w.period);  // J, puis S, puis M ; période décroissante
    const ok = lines.filter(l => l.a && !l.a.short);
    const rank = Math.min(...lines.map(l => radarRank(l.a)));
    const dist = ok.length ? Math.min(...ok.map(l => Math.abs(l.a.dist))) : 1e9;
    // Croisements : clôture de l'autre côté de la SMA depuis moins de ALERT_DAYS jours, ou en train de passer. Proches : sans croisement récent.
    const signal = ok.some(l => l.a.pending || (l.a.lastCross && l.a.lastCross.date >= recent));
    return { t, lines, ok, rank: signal ? Math.min(rank, 0) : rank, dist, signal, near: !signal && ok.some(l => l.a.near), up: ok.length ? ok[0].a.p > ok[0].a.smaNow : null };
  }).sort((x, y) => x.rank - y.rank || x.dist - y.dist || (x.t < y.t ? -1 : 1));
  const secCount = {}; for (const c of cards) { const x = sectorOf(c.t) || 'Non classé'; secCount[x] = (secCount[x] || 0) + 1; }
  const shown = cards.filter(c => (radarFilter === 'signal' ? c.signal : radarFilter === 'near' ? c.near : true) && (!radarSector || (sectorOf(c.t) || 'Non classé') === radarSector));
  const al = radarAlerts(), crossAl = al.filter(x => x.lvl !== 'near'), nearAl = al.filter(x => x.lvl === 'near');
  const fresh = crossAl.filter(x => !x.seen), seenAl = crossAl.filter(x => x.seen), nearNew = nearAl.filter(x => !x.seen).length;
  // Rangées par unité (J, S, M), puis période décroissante (J 233 avant J 200), puis clôture la plus récente.
  const alertOrder = (x, y) => tfOrder[x.w.tf] - tfOrder[y.w.tf] || y.w.period - x.w.period || (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || (x.w.ticker < y.w.ticker ? -1 : 1);
  const AL_TF = { D: 'SMA journalières', W: 'SMA hebdo', M: 'SMA mensuelles' };
  const alertList = list => list.sort(alertOrder).map((x, i) => (i === 0 || x.w.tf !== list[i - 1].w.tf ? `<p class="al-tf">${AL_TF[x.w.tf]}</p>` : '') + alertRow(x)).join('');
  // Croisement à la hausse : rappel des positions déjà ouvertes dans le même secteur (information seulement).
  let SB = null; const sb = () => SB || (SB = sectorBook());
  const secNote = x => {
    const s = x.lvl === 'up' && !x.seen && sectorOf(x.w.ticker); if (!s) return '';
    const B = sb(), g = B.groups.find(y => y.s === s); if (!g) return '';
    const share = B.tot > 0 ? g.expo / B.tot * 100 : 0, warn = B.n >= 3 && share > sectSet().expo;
    return `<small class="al-sec${warn ? ' warn' : ''}">${esc(s)} : déjà ${g.list.length} position(s), ${fmtNum(share, 0)} % de l’exposition${g.list.some(k => k.t === x.w.ticker) ? ` (dont ${esc(x.w.ticker)})` : ''}</small>`;
  };
  const alertRow = x => `<div class="alert ${x.lvl === 'up' ? 'ok up' : x.lvl === 'down' ? 'err' : 'warn'} ${x.seen ? 'seen' : ''}"><span>${x.seen ? '' : '<b class="new">Nouveau</b> '}${x.txt}${x.seen ? '' : earnPill(x.w.ticker)}${secNote(x)}</span>${x.seen ? `<button class="btn sm icon" data-act="radar-gone" data-k="${esc(x.key)}" aria-label="Supprimer cette alerte" title="Supprimer">✕</button>` : `<button class="btn sm" data-act="radar-seen" data-k="${esc(x.key)}">Vu</button>`}</div>`;
  const nSym = new Set(S.watch.map(symOf)), nHave = [...nSym].filter(x => Radar.hist[x]).length;
  const prog = Radar.busy ? `<div class="alert live on"><span>Historique : ${Radar.done} / ${Radar.todo} action(s)… (8 par minute, offre gratuite). Gardez l’app ouverte : le chargement s’arrête quand elle passe en arrière-plan.</span></div>`
    : key && Radar.loaded && nHave < nSym.size ? `<div class="alert warn"><span>Historique présent sur cet appareil pour ${nHave} action(s) sur ${nSym.size}. Il se télécharge sur chaque appareil, app ouverte.</span><button class="btn sm" data-act="radar-refresh">Continuer</button></div>` : '';
  const errs = Object.keys(Radar.errs);
  const dd = d => fmtDate(d).replace(/ \d{4}$/, '');
  const line = ({ w, a }, lot, gap) => {
    const [pc, st] = radarStatus(a), ok = a && !a.short;
    const calc = (!lot && ok && a.cross !== 'down' && (a.above || a.pending === 'up') ? `<button class="btn sm primary" data-act="radar-calc" data-id="${w.id}">Taille</button>` : '') + (ok ? `<button class="btn sm" data-act="chart" data-t="${esc(w.ticker)}" data-w="${w.id}" aria-label="Graphique ${esc(w.ticker)}">Graphique</button>` : '');
    const stop = lot && ok && Math.abs((lot.stopCurrent || 0) - a.sma) >= 0.005 ? `<button class="btn sm" data-act="radar-stop" data-id="${w.id}" title="Mettre le stop sur la SMA">Stop ${usd(a.sma)}</button>` : '';
    return `<div class="rline ${pc}${gap ? ' tfgap' : ''}">
      <span class="tf">${TF_SHORT[w.tf]} ${w.period}</span>
      <span class="pill ${pc}">${st}</span>
      <b class="num ${ok ? cls(a.dist) : ''}">${ok ? pct(a.dist, true) : ''}</b>
      <div class="rbot"><span class="meta">${ok ? `SMA ${usd(a.smaNow)}${a.lastCross ? ` · ${a.lastCross.dir === 'up' ? '↑' : '↓'} ${dd(a.lastCross.date)}` : ''}` : Radar.errs[symOf(w)] ? `<span class="neg">${esc(Radar.errs[symOf(w)])}</span>` : ''}</span>
      <span class="acts">${calc}${stop}<button class="btn sm icon" data-act="radar-edit" data-id="${w.id}" aria-label="Modifier la SMA ${w.period} ${TF_LONG[w.tf]}">✎</button><button class="btn sm icon" data-act="radar-del" data-id="${w.id}" aria-label="Retirer la SMA ${w.period} ${TF_LONG[w.tf]}">✕</button></span></div>
    </div>`;
  };
  const card = c => {
    const lot = S.lots.find(l => l.ticker === c.t && !Core.lotState(l).closed);
    const a0 = c.ok[0] && c.ok[0].a, [pc] = radarStatus(c.lines.slice().sort((x, y) => radarRank(x.a) - radarRank(y.a))[0].a);
    const notes = [...new Set(c.lines.map(l => l.w.note).filter(Boolean))];
    const hist = c.ok.filter(l => l.a.crosses.length).map(l => `<div class="hline"><span class="tf">${TF_SHORT[l.w.tf]} ${l.w.period}</span><span>${l.a.crosses.map(x =>
      `<span class="${x.dir === 'up' ? 'pos' : 'neg'}">${x.dir === 'up' ? '↑' : '↓'} ${fmtDate(x.date)}</span> <small class="muted">(${usd(x.close)} / SMA ${usd(x.sma)})</small>`).join('<br>')}</span></div>`).join('');
    return `<article class="rrow ${pc}" data-q="${esc((c.t + ' ' + notes.join(' ')).toLowerCase())}">
      <header><div><span class="tk">${esc(c.t)}</span>${sectorOf(c.t) ? ` <span class="pill sec"><i style="background:${SECT_COL[sectorOf(c.t)] || SECT_COL.Autre}"></i>${esc(sectorOf(c.t))}</span>` : ''}${earnPill(c.t)}${lot ? ` <span class="pill open">Position${isNum(lot.stopCurrent) ? ' · stop ' + usd(lot.stopCurrent) : ''}</span>` : ''}</div>
        ${a0 ? `<div class="pl">${usd(a0.p)}<small>${a0.src}</small></div>` : ''}</header>
      <div class="rlines">${c.lines.map((l, i) => line(l, lot, i > 0 && l.w.tf !== c.lines[i - 1].w.tf)).join('')}</div>
      ${notes.length ? `<p class="hint">${notes.map(esc).join(' · ')}</p>` : ''}${divNote(c.t)}
      <div class="rfoot">${hist ? `<details class="more"><summary>Historique des croisements</summary><div class="hist">${hist}</div></details>` : '<span></span>'}
        <button class="btn sm" data-act="radar-add-sma" data-t="${esc(c.t)}">+ SMA</button></div>
    </article>`;
  };
  const fBtn = (k, l, n) => `<button class="btn sm" data-act="radar-filter" data-f="${k}" aria-pressed="${radarFilter === k}">${l} (${n})</button>`;
  return `${key ? '' : setup}
  <section class="card">
    <div class="sec-head"><h2>Radar SMA <small title="${adjMode() === 'all' ? 'Cours ajustés des dividendes, comme le bouton ADJ de TradingView' : 'Cours non ajustés des dividendes'}">· ${adjMode() === 'all' ? 'ADJ' : 'brut'}</small></h2><div class="row"><button class="btn sm" data-act="radar-refresh" ${key && S.watch.length ? '' : 'disabled'}>Actualiser</button><button class="btn sm" data-tab="lab">Labo SMA</button><button class="btn sm" data-tab="earn">Résultats</button><button class="btn sm primary" data-act="radar-add">+ Ajouter</button></div></div>
    <p class="lead">${cards.length} action(s), ${S.watch.filter(w => !w.idx).length} SMA. Alerte « proche » à ${fmtNum(S.settings.nearPct || 2)} % de la SMA. ${adjMode() === 'all' ? 'Cours ajustés des dividendes (ADJ de TradingView). ' : 'Cours non ajustés des dividendes. '}${quoteKey() ? 'Historique Twelve Data (une fois, puis vérifié chaque semaine) complété chaque soir par la clôture Finnhub.' : 'Sans clé Finnhub sur cet appareil, l’historique est retéléchargé chaque jour sur Twelve Data (plus lent).'}</p>
    ${prog}${Radar.err ? `<div class="banner err">${esc(Radar.err)}</div>` : ''}
    ${errs.length ? `<p class="hint">Sans historique : ${errs.map(esc).join(', ')}.</p>` : ''}
    <div class="row"><button class="btn sm" data-act="radar-import">Importer une liste</button><button class="btn sm" data-act="radar-settings">Réglages du radar</button></div>
  </section>
  ${al.length ? `<section class="card">
    <div class="sec-head"><h2>Alertes${fresh.length ? ` <span class="pill warn">${fresh.length} nouvelle(s)</span>` : ''}</h2>${fresh.length > 1 ? `<button class="btn sm" data-act="radar-seen-all">Tout marquer comme vu</button>` : ''}</div>
    ${fresh.length ? `<div class="alerts">${alertList(fresh)}</div>` : '<p class="hint">Aucun nouveau croisement.</p>'}
    ${seenAl.length ? `<details class="more" style="margin-top:10px"><summary>Déjà vues (${seenAl.length})</summary><div class="alerts">${alertList(seenAl)}</div><div class="row" style="margin-top:8px"><button class="btn sm" data-act="radar-gone-all">Supprimer toutes les déjà vues</button></div></details>` : ''}
    ${nearAl.length ? `<div class="near-al"><p class="near-h">Proches de leur SMA (${nearAl.length})${nearNew ? ` · ${nearNew} nouvelle(s)` : ''}</p>${['D', 'W', 'M'].map(tf => {
      const g = nearAl.filter(x => x.w.tf === tf); if (!g.length) return '';
      const nw = g.filter(x => !x.seen), nOpen = nearGroupOpen(tf);
      return `<details class="ngrp" id="near-${tf}" ${nOpen ? 'open' : ''}><summary><span class="ng-t">${AL_TF[tf]}</span>${nw.length ? `<span class="ng-new">${nw.length} nouvelle(s)</span>` : ''}<span class="ng-n">${g.length}</span></summary><div class="alerts">${[...nw.sort(alertOrder), ...g.filter(x => x.seen).sort(alertOrder)].map(alertRow).join('')}</div></details>`;
    }).join('')}</div>` : ''}
    <p class="hint">Une alerte disparaît ${ALERT_DAYS} jours après la clôture qui l’a déclenchée.</p>
  </section>` : ''}
  ${radarSectCard(cards)}
  <section class="card">
    ${cards.length ? `<div class="search"><input type="search" id="radar-q" value="${esc(radarQuery)}" placeholder="Rechercher une action" autocomplete="off" autocapitalize="characters" aria-label="Rechercher une action"></div>
      <div class="filters">${fBtn('all', 'Toutes', cards.length)}${fBtn('signal', 'Croisements', cards.filter(c => c.signal).length)}${fBtn('near', 'Proches', cards.filter(c => c.near).length)}${radarSector && secCount[radarSector] ? `<button class="btn sm" data-act="radar-sect" data-s="${esc(radarSector)}" aria-pressed="true" aria-label="Retirer le filtre ${esc(radarSector)}"><i class="sdot" style="background:${SECT_COL[radarSector] || SECT_COL.Autre}"></i>${esc(radarSector)} (${secCount[radarSector]}) ✕</button>` : ''}</div>
      <div class="rlist">${shown.length ? shown.map(card).join('') : '<p class="lead">Aucune action pour ce filtre.</p>'}</div>`
      : '<p class="lead">Aucune action suivie. Touchez « + Ajouter » pour saisir une action et sa SMA, ou « Importer une liste » pour en coller plusieurs d’un coup.</p>'}
  </section>`;
}
// Secteurs du radar : répartition des actions suivies, force (part au-dessus de leur SMA principale) et croisements récents.
// Replié par défaut (choix gardé sur l'appareil) ; toucher un secteur filtre la liste.
const RSECT_KEY = 'carnet-positions:radar-sect';
let rsectOpen = (() => { try { return localStorage.getItem(RSECT_KEY) === '1'; } catch (e) { return false; } })();
function radarSectCard(cards) {
  if (cards.length < 2) return '';
  const by = {};
  for (const c of cards) { const s = sectorOf(c.t) || 'Non classé', g = by[s] = by[s] || { s, n: 0, up: 0, k: 0, sig: 0 }; g.n++; if (c.up != null) { g.k++; if (c.up) g.up++; } if (c.signal) g.sig++; }
  const rank = s => s === 'Non classé' ? 2 : s === 'Autre' ? 1 : 0;
  const G = Object.values(by).sort((a, b) => rank(a.s) - rank(b.s) || b.n - a.n || (a.s < b.s ? -1 : 1));
  const col = s => s === 'Non classé' ? 'var(--line)' : SECT_COL[s] || SECT_COL.Autre, f = g => g.k ? g.up / g.k * 100 : null;
  const real = G.filter(g => SECTORS.includes(g.s) && g.k >= 2 && g.n >= 2).sort((a, b) => f(b) - f(a));
  const sum = real.length >= 2 ? `Plus fort : ${esc(real[0].s)} ${fmtNum(f(real[0]), 0)} % · plus faible : ${esc(real[real.length - 1].s)} ${fmtNum(f(real[real.length - 1]), 0)} %` : `${G.filter(g => g.s !== 'Non classé').length} secteur(s)`;
  const rows = G.map(g => `<button type="button" class="srow rs${radarSector === g.s ? ' on' : ''}" data-act="radar-sect" data-s="${esc(g.s)}">
      <span class="sn"><i style="background:${col(g.s)}"></i>${esc(g.s)} <small>${g.n}</small></span>
      <span class="sbar force"><i style="width:${f(g) == null ? 0 : f(g).toFixed(0)}%"></i></span>
      <span class="sv num">${f(g) == null ? '–' : fmtNum(f(g), 0) + ' %'}${g.sig ? ` · ${g.sig} crois.` : ''}</span></button>`).join('');
  const nc = by['Non classé'];
  return `<section class="card rsect">
    <button type="button" class="rs-head" data-act="radar-sect-tog" aria-expanded="${rsectOpen}"><span><b>Secteurs du radar</b> <small>· ${cards.length} actions</small></span><span class="chev">${rsectOpen ? '▴' : '▾'}</span></button>
    <div class="sseg">${G.map(g => `<i style="flex:${g.n};background:${col(g.s)}" title="${esc(g.s)} : ${g.n}"></i>`).join('')}</div>
    <p class="hint rs-sum">${sum}</p>
    ${rsectOpen ? `<div class="srows">${rows}</div>
    <p class="hint">Force : part des actions du secteur au-dessus de leur SMA principale (la J la plus longue, sinon S ou M). Crois. : croisements des ${ALERT_DAYS} derniers jours. Touchez un secteur pour filtrer la liste, encore une fois pour tout revoir.${nc ? ` Secteur en attente pour ${nc.n} action(s)${quoteKey() ? ' (récupéré automatiquement)' : ' : clé Finnhub nécessaire'}.` : ''}</p>` : ''}
  </section>`;
}
// Groupes « proches » : journalière ouverte, hebdo ouverte du vendredi au dimanche, mensuelle fermée.
// Un groupe ouvert ou fermé à la main garde ce choix jusqu'au lendemain (sur cet appareil).
const NEAR_KEY = 'carnet-positions:near-groups';
const nearAuto = tf => tf === 'D' || (tf === 'W' && [5, 6, 0].includes(wdOf(todayISO())));
function nearGroupOpen(tf) {
  let m = {}; try { m = JSON.parse(localStorage.getItem(NEAR_KEY)) || {}; } catch (e) {}
  return m.day === todayISO() && typeof m[tf] === 'boolean' ? m[tf] : nearAuto(tf);
}
document.addEventListener('toggle', e => {
  const tf = (/^near-([DWM])$/.exec(e.target.id || '') || [])[1]; if (!tf || e.target.open === nearGroupOpen(tf)) return;
  let m = {}; try { m = JSON.parse(localStorage.getItem(NEAR_KEY)) || {}; } catch (e) {}
  if (m.day !== todayISO()) m = { day: todayISO() };
  m[tf] = e.target.open;
  try { localStorage.setItem(NEAR_KEY, JSON.stringify(m)); } catch (e) {}
}, true);
function applyRadarQuery() {
  const q = radarQuery.trim().toLowerCase();
  for (const el of document.querySelectorAll('.rrow[data-q]')) el.hidden = !!q && !el.dataset.q.includes(q);
}
function sheetWatch(w, preset) {
  const isNew = !w; w = w || { ticker: preset || '', period: '', tf: 'D', sym: '', note: '' };
  openSheet({
    title: isNew ? 'Suivre une action' : 'Modifier ' + w.ticker, ok: 'Enregistrer',
    body: `<div class="fields">
      ${inp('ticker', 'Ticker', w.ticker, 'autocapitalize="characters" required')}
      ${inp('period', 'Période de la SMA', w.period, 'inputmode="numeric" placeholder="ex. 89"')}
      <div class="fld"><label for="f-tf">Unité</label><select id="f-tf" name="tf">${Object.keys(TF_LONG).map(k => `<option value="${k}" ${w.tf === k ? 'selected' : ''}>${TF_SHORT[k]} · ${TF_LONG[k]}</option>`).join('')}</select></div>
      ${inp('sym', 'Symbole Twelve Data (si différent)', w.sym || '', 'autocapitalize="characters" placeholder="facultatif"', 'Pour une action hors USA ou un symbole différent chez Twelve Data.')}
      <div class="fld wide"><label for="f-note">Note</label><input id="f-note" name="note" value="${esc(w.note || '')}" placeholder="facultatif"></div></div>`,
    onSubmit: form => {
      const t = F(form, 'ticker').trim().toUpperCase(), n = num(F(form, 'period')), tf = F(form, 'tf'), sym = F(form, 'sym').trim().toUpperCase();
      need(/^[A-Z0-9.\-]{1,12}$/.test(t), 'Ticker invalide.');
      need(periodOk(tf, n), `Période entre 2 et ${maxPeriod(tf)} pour cette unité.`);
      need(!sym || /^[A-Z0-9.:\-\/]{1,20}$/.test(sym), 'Symbole invalide.');
      need(!S.watch.some(x => x !== w && x.ticker === t && x.tf === tf && x.period === n), 'Cette action est déjà suivie avec cette SMA.');
      Object.assign(w, { ticker: t, period: n, tf, sym: sym && sym !== t ? sym : '', note: F(form, 'note').trim() });
      if (isNew) { w.id = uid(); S.watch.push(w); }
      save(isNew ? t + ' ajoutée au radar' : 'Radar mis à jour');
      refreshRadar();
    }
  });
}
// Une action par ligne : ticker puis paires « unité période » (ou « période unité » ; une période seule est journalière).
function parseSmaList(text) {
  const map = { J: 'D', D: 'D', S: 'W', W: 'W', M: 'M' }, rows = [], bad = [];
  for (const line of String(text).split(/\n/)) {
    const l = line.trim(); if (!l) continue;
    const [t, ...rest] = l.split(/[;,\t ]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
    const pairs = []; let ok = /^[A-Z0-9.\-]{1,12}$/.test(t || '') && rest.length > 0;
    for (let i = 0; ok && i < rest.length; i++) {
      const a = rest[i], b = rest[i + 1];
      if (map[a] && /^\d+$/.test(b || '')) { pairs.push([map[a], +b]); i++; }
      else if (/^\d+$/.test(a) && map[b]) { pairs.push([map[b], +a]); i++; }
      else if (/^\d+$/.test(a)) pairs.push(['D', +a]);
      else ok = false;
    }
    if (!ok) { bad.push(l); continue; }
    const good = [];
    for (const [tf, n] of pairs) {
      if (!periodOk(tf, n)) bad.push(`${t} ${TF_SHORT[tf]} ${n}`);
      else if (!good.some(([a, b]) => a === tf && b === n)) good.push([tf, n]);
    }
    if (good.length) rows.push({ t, pairs: good });
  }
  return { rows, bad };
}
function sheetWatchImport() {
  openSheet({
    title: 'Importer une liste', ok: 'Importer',
    body: `<p class="lead">Une action par ligne : le ticker, puis une ou plusieurs SMA (unité J, S ou M et période). Exemples :</p>
      <pre class="hint" style="margin:0">AAPL J 233 S 55 M 13\nABBV J 8\nACN;89;S</pre>
      <p class="hint">Une SMA déjà au radar est ignorée (pas de doublon) ; une nouvelle SMA d'une action déjà suivie s'ajoute à sa carte.</p>
      <div class="fields"><div class="fld wide"><label for="f-list">Liste</label><textarea id="f-list" name="list" rows="8" autocapitalize="characters"></textarea></div></div>`,
    onSubmit: form => {
      let add = 0, dup = 0; const { rows, bad } = parseSmaList(F(form, 'list'));
      for (const { t, pairs } of rows) for (const [tf, n] of pairs) {
        if (S.watch.some(x => x.ticker === t && x.tf === tf && x.period === n)) { dup++; continue; }   // déjà au radar : pas de doublon
        S.watch.push({ id: uid(), ticker: t, period: n, tf, sym: '', note: '' }); add++;
      }
      need(add || dup || !bad.length, 'Lignes non reconnues : ' + bad.slice(0, 3).join(' | '));
      save(`${add} SMA ajoutée(s)${dup ? ` · ${dup} déjà au radar` : ''}${bad.length ? ` · ignoré : ${bad.slice(0, 4).join(' | ')}${bad.length > 4 ? '…' : ''}` : ''}`);
      refreshRadar();
    }
  });
}
function sheetRadarSettings() {
  openSheet({
    title: 'Réglages du radar', ok: 'Enregistrer',
    body: `<div class="fields">${dec('nearPct', 'Alerte « proche » à (% de la SMA)', S.settings.nearPct || 2)}</div>
      <label class="check"><input type="checkbox" name="adjDiv" ${S.settings.adjDiv === false ? '' : 'checked'}> Cours ajustés des dividendes, comme le bouton ADJ de TradingView</label>
      <p class="hint">Les SMA longues (377 semaines, 100 mois) changent beaucoup selon ce réglage : gardez le même que sur votre graphique TradingView. Un changement retélécharge tout l’historique.</p>
      ${tdKey() ? '<div class="row"><button type="button" class="btn sm danger" data-act="td-off">Retirer la clé Twelve Data</button></div>' : ''}`,
    onSubmit: form => { const v = num(F(form, 'nearPct')); need(v > 0 && v <= 20, 'Entre 0 et 20 %.'); S.settings.nearPct = v;
      const adj = !!form.elements.adjDiv.checked, chg = adj !== (S.settings.adjDiv !== false);
      S.settings.adjDiv = adj; save(chg ? 'Réglage enregistré : historique du radar retéléchargé' : 'Réglages du radar enregistrés');
      if (chg) refreshRadar(); }
  });
}

// ---------- Rendu ----------
// Swap des CFD estimé chaque nuit (Réglages › Compte) : voir Core.setSwap.
function syncSwap() { const w = S.settings.swap || {}; Core.setSwap({ pct: w.pct || 0, triple: w.triple == null ? 5 : w.triple, prices: S.prices, today: todayISO() }); }
function render() {
  motifsSync();
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === (tab === 'lab' || tab === 'earn' ? 'radar' : tab) ? 'true' : 'false'));
  const v = $('#view'), saved = S.prices;
  if (Object.keys(Live.prices).length) S.prices = withLive(saved);
  syncSwap();
  try {
    if (tab === 'dash') v.innerHTML = viewDash();
    else if (tab === 'calc') { v.innerHTML = viewCalc(); updateCalc(); }
    else if (tab === 'pos') { v.innerHTML = viewPos(); applyPosQuery(); loadThumbs(); }
    else if (tab === 'radar') { v.innerHTML = viewRadar(); applyRadarQuery(); }
    else if (tab === 'lab') v.innerHTML = viewLab();
    else if (tab === 'earn') v.innerHTML = viewEarn();
    else v.innerHTML = viewSettings();
  } finally { S.prices = saved; }
  badgeSoon();
}
const kv = (label, value, extra, c) => `<div><dt>${label}</dt><dd class="${c || ''}">${value}${extra ? `<small>${extra}</small>` : ''}</dd></div>`;
function demoBanner() {
  return hasDemo() ? `<div class="banner warn"><span><strong>Données de démonstration affichées.</strong> Elles se mélangent aux calculs : effacez-les avant de saisir vos vraies positions.</span><button class="btn sm" data-act="clear-demo">Effacer la démo</button></div>` : '';
}

// ----- Alertes : ce qui demande une action, affiché en haut du tableau de bord et des positions -----
function alertsList() {
  const today = todayISO(), out = [];
  const open = S.lots.map(lotView).filter(v => !v.ls.closed);
  // Résultats d'ici le prochain jour de bourse, et swap qui a mangé une bonne part du gain latent (une ligne par action).
  for (const tk of [...new Set(open.map(v => v.lot.ticker))]) {
    const e = nextEarn(tk), n = e ? Core.days(today, e[0]) : 99;
    if (e && n <= (wdOf(today) === 5 ? 3 : 1)) out.push({ lvl: 'warn', txt: `<strong>${esc(tk)}</strong> : résultats ${n === 0 ? 'aujourd’hui' : n === 1 ? 'demain' : 'lundi'}${EARN_H[e[1]] ? ' ' + EARN_H[e[1]] : ''}. Gardez, allégez ou resserrez le stop : à vous de voir.`, lot: open.find(v => v.lot.ticker === tk).lot.id });
    const vs = open.filter(v => v.lot.ticker === tk), sw = vs.reduce((a, v) => a + v.ls.funding, 0), un = vs.reduce((a, v) => a + v.unreal, 0);
    if (un > 0.5 && sw / un * 100 >= swapWarnPct()) out.push({ lvl: 'warn', txt: `<strong>${esc(tk)}</strong> : le swap (${usd(sw)}) a déjà mangé ${fmtNum(sw / un * 100, 0)} % du gain latent.`, lot: vs[0].lot.id });
  }
  for (const v of open) {
    const t = esc(v.lot.ticker), st = v.lot.stopCurrent, p = v.last ? v.last.price : null;
    if (v.sa.missing) out.push({ lvl: 'err', txt: `<strong>${t}</strong> : aucun stop, risque non borné.`, lot: v.lot.id });
    else if (p != null && p <= st) { const tf = stopTf(v.lot.ticker); if (stopWindow(tf, v.last.date)) out.push({ lvl: 'err', hit: 1, txt: `<strong>${t}</strong> : cours ${usd(p)} sur ou sous le stop ${usd(st)}${tf === 'D' ? '' : ` · ${stopDueLbl(tf, v.last.date)}`}. Vérifiez dans MT5 si la position a été stoppée.`, lot: v.lot.id }); }
    else if (p != null && (p - st) / p < 0.01 && stopWindow(stopTf(v.lot.ticker), v.last.date)) out.push({ lvl: 'warn', txt: `<strong>${t}</strong> : à ${pct((p - st) / p * 100)} du stop.`, lot: v.lot.id });
  }
  const stale = [...new Set(open.filter(v => !v.last || Core.days(v.last.date, today) > S.settings.staleDays).map(v => v.lot.ticker))].sort();
  if (stale.length) out.push({ lvl: 'warn', txt: `Cours anciens ou manquants : <strong>${stale.map(esc).join(', ')}</strong>.`, act: 'prices', btn: 'Mettre à jour' });
  const acc = Core.accountState(S, null, 'last');
  if (acc.margin > 0 && acc.equity > 0) {
    const lvl = acc.equity / acc.margin * 100;
    const min = S.settings.marginMin || 150;
    if (lvl < min) out.push({ lvl: lvl < min * 0.8 ? 'err' : 'warn', txt: `Niveau de marge estimé <strong>${fmtNum(lvl, 0)} %</strong>, sous votre seuil de ${fmtNum(min, 0)} % (valeur nette ÷ marge). Le courtier ferme des positions vers 50 % : comparez avec MT5.` });
  }
  return out;
}
function alertsStrip(tonight) {   // tonight : stops et radar déjà dans la carte « Ce soir »
  const a = alertsList().filter(x => !(tonight && x.hit));
  const ra = S.watch.length && !tonight ? radarAlerts().filter(x => !x.seen) : [];
  const sr = S.watch.length && !tonight ? stopRaises() : [];
  if (sr.length) a.unshift({ lvl: 'warn', txt: `<strong>Stops</strong> : ${sr.length} stop(s) peuvent être remontés sur une de vos SMA · ${sr.slice(0, 4).map(x => esc(x.v.lot.ticker)).join(', ')}${sr.length > 4 ? '…' : ''}`, act: 'stop-raises', btn: 'Voir' });
  if (ra.length) a.unshift({ lvl: ra.some(x => x.lvl !== 'near') ? 'err' : 'warn', txt: `<strong>Radar SMA</strong> : ${ra.length} nouvelle(s) alerte(s) · ${ra.slice(0, 3).map(x => esc(x.w.ticker) + (x.lvl === 'up' ? ' ↑' : x.lvl === 'down' ? ' ↓' : ' ≈')).join(', ')}${ra.length > 3 ? '…' : ''}`, act: 'go-radar', btn: 'Voir' });
  if (!a.length) return S.lots.some(l => !Core.lotState(l).closed) ? '<div class="alerts"><div class="alert ok"><span>Aucune alerte : stops en place, cours à jour, marge correcte.</span></div></div>' : '';
  const row = x => `<div class="alert ${x.lvl}"><span>${x.txt}</span>${x.act ? `<button class="btn sm" data-act="${x.act}">${x.btn}</button>` : x.lot ? `<button class="btn sm" data-act="open-lot" data-lot="${x.lot}">Voir</button>` : ''}</div>`;
  a.sort((p, q) => (p.lvl === 'err' ? 0 : 1) - (q.lvl === 'err' ? 0 : 1));
  return `<div class="alerts" role="status">${a.slice(0, 4).map(row).join('')}${a.length > 4 ? `<details><summary>${a.length - 4} autre(s) alerte(s)</summary>${a.slice(4).map(row).join('')}</details>` : ''}</div>`;
}

// ----- Discipline : écarts aux règles de taille et de stop -----
// Sortie à la clôture sous le stop : écart entre le stop en vigueur le jour de la vente et le prix de vente.
// Seules les ventes sous le stop comptent (les autres sont des sorties volontaires).
function stopAt(lot, d) {
  let st = lot.stopInitial;
  for (const e of lot.events.filter(x => x.type === 'stop').sort((a, b) => a.date < b.date ? -1 : 1)) if (e.date <= d) st = e.to;
  return isNum(st) && st > 0 ? st : null;
}
function overshootStats() {
  const xs = [];
  for (const l of S.lots) for (const e of l.events) {
    if (e.type !== 'sell') continue;
    const st = stopAt(l, e.date);
    if (st && e.price < st - 1e-9) xs.push({ t: l.ticker, pct: (st - e.price) / st * 100, earn: nearEarn(l.ticker, e.date) });
  }
  if (!xs.length) return null;
  const worst = xs.reduce((a, x) => x.pct > a.pct ? x : a), avg = a => a.length ? a.reduce((s, x) => s + x.pct, 0) / a.length : null;
  const ea = xs.filter(x => x.earn), ot = xs.filter(x => !x.earn);
  return { n: xs.length, avg: avg(xs), worst, earn: { n: ea.length, avg: avg(ea) }, other: { n: ot.length, avg: avg(ot) }, known: xs.some(x => Earn.map[x.t]) };
}
// Dépassement retenu pour l'information du calculateur : la moyenne mesurée dès 3 sorties, sinon le réglage.
function overshootUsed() { const o = overshootStats(); return o && o.n >= 3 ? { pct: o.avg, src: `moyenne de vos ${o.n} sorties` } : { pct: isNum(S.settings.overshoot) ? S.settings.overshoot : 3, src: 'valeur des réglages' }; }
function disciplineCard(T) {
  const s = S.settings, lots = S.lots;
  if (!lots.length) return '';
  const open = lots.filter(l => !Core.lotState(l).closed);
  const overCap = lots.filter(l => l.qty * l.price > s.cap + 0.005);
  const overRisk = lots.filter(l => isNum(l.riskInitialPct) && l.riskInitialPct > s.riskPct + 0.005);
  const lowered = open.filter(l => isNum(l.stopCurrent) && isNum(l.stopInitial) && l.stopCurrent < l.stopInitial - 1e-9);
  const safe = open.filter(l => isNum(l.stopCurrent) && l.stopCurrent >= l.price);
  const names = a => a.length ? [...new Set(a.map(l => esc(l.ticker)))].join(', ') : 'aucune';
  const box = (c, n, label, sub) => `<div class="${c}"><b>${n}</b><span>${label}</span><small class="muted">${sub}</small></div>`;
  return `<section class="card">
    <div class="sec-head"><h2>Discipline</h2><small>vos règles : ${fmtNum(s.riskPct)} % de risque, ${usd(s.cap)} d’exposition par position</small></div>
    <div class="disc">
      ${box(T.planRate == null ? '' : T.planRate >= 80 ? 'good' : T.planRate >= 50 ? 'meh' : 'bad', T.planRate == null ? '—' : pct(T.planRate), 'Plan respecté', T.planCount ? T.planCount + ' position(s) évaluée(s)' : 'évaluez vos positions clôturées')}
      ${box(overCap.length ? 'bad' : 'good', overCap.length + ' / ' + lots.length, 'Au-dessus du plafond à l’achat', names(overCap))}
      ${box(overRisk.length ? 'bad' : 'good', overRisk.length + ' / ' + lots.length, 'Risque initial au-dessus de ' + fmtNum(s.riskPct) + ' %', names(overRisk))}
      ${box(lowered.length ? 'meh' : 'good', lowered.length + ' / ' + open.length, 'Stops descendus', lowered.length ? names(lowered) + ' : stop actuel sous le stop initial' : 'aucun stop abaissé')}
      ${(o => box(!o ? '' : o.avg <= 2 ? 'good' : o.avg <= 4 ? 'meh' : 'bad', o ? pct(o.avg) : '—', 'Dépassement moyen du stop', o ? `${o.n} sortie(s) sous le stop · pire ${pct(o.worst.pct)} (${esc(o.worst.t)})${o.known ? `<br>autour des résultats : ${o.earn.n ? `${o.earn.n} · moy. ${pct(o.earn.avg)}` : 'aucune'} · autres : ${o.other.n ? `${o.other.n} · moy. ${pct(o.other.avg)}` : 'aucune'}` : ''}` : 'aucune sortie sous le stop pour l’instant'))(overshootStats())}
      ${box('good', safe.length + ' / ' + open.length, 'Positions sans risque', safe.length ? names(safe) + ' : stop au niveau de l’entrée ou au-dessus' : 'aucun stop au-dessus de l’entrée')}
    </div>
  </section>`;
}

// ----- Tableau de bord -----
// ----- Labo SMA : backtest de 15 SMA × J / S / M fait par le robot (robot/labsma.mjs), résultats affichés ici -----
// La liste à tester (S.settings.labQueue) est synchronisée ; les actions du radar peuvent y être, mais rien n'est jamais ajouté ni changé au radar sans un geste.
const LAB_P = [5, 8, 13, 21, 34, 50, 55, 89, 100, 144, 200, 233, 377, 610, 987], LAB_MIN = { D: 20, W: 12, M: 8, C: 20 };
// « C » : test combiné J + S + M fait par le robot (SMA journalière filtrée par la meilleure SMA hebdo et mensuelle).
const LT = tf => tf === 'C' ? 'J+S+M' : TF_SHORT[tf], LL = tf => tf === 'C' ? 'combinée' : TF_LONG[tf];
const LAB_KEY = 'carnet-positions:lab', LAB_FEE_KEY = 'carnet-positions:lab-fee';
const Lab = (() => { try { return JSON.parse(localStorage.getItem(LAB_KEY)) || { ver: null, res: {} }; } catch (e) { return { ver: null, res: {} }; } })();
function setLab(L, ver) {
  Lab.ver = ver; Lab.res = (L && L.res) || {}; Lab.at = L && L.at;
  try { const t = JSON.stringify(Lab); if (t.length < 2.5e6) localStorage.setItem(LAB_KEY, t); } catch (e) {}
}
let labFee = (() => { try { return localStorage.getItem(LAB_FEE_KEY) || 'ic'; } catch (e) { return 'ic'; } })(), labSel = {}, labOpen = new Set(), labPick = {}, labChk = {};
const labQueue = () => [...new Set((S.settings.labQueue || []).map(t => String(t).toUpperCase()))];
const labRadarT = () => new Set(S.watch.map(w => String(w.ticker).toUpperCase()));
// Une case : [cagr, dd, pf, trades, %gagnants, temps investi, trade moyen %, ouvert, cagr récent, dd récent, cagr 70 %, dd 70 %].
const labScore = (c, dd) => c == null || dd == null ? null : dd > 0 ? c / dd : c > 0 ? 99 : 0;
const labCol = s => s == null ? '' : s >= 0.5 ? 'l4' : s >= 0.35 ? 'l3' : s >= 0.2 ? 'l2' : s >= 0 ? 'l1' : 'l0';
function labVerdict(x, tf) {
  if (!x) return ['Historique insuffisant', 'na'];
  const [cagr, dd, pf, tr] = x, s = labScore(cagr, dd);
  if (tr < LAB_MIN[tf]) return ['Trop peu de trades', 'v3'];
  if (pf >= 2 && cagr >= 8 && s >= 0.4) return ['Très intéressant', 'v1'];
  if (pf >= 1.5 && cagr >= 5 && s >= 0.2) return ['À étudier', 'v2'];
  return ['Faible / à écarter', 'v3'];
}
// Meilleure SMA d'une unité : meilleur CAGR ÷ drawdown parmi celles qui ont assez de trades (sinon parmi toutes).
function labBest(rows, tf, ins) {
  const sc = x => ins ? labScore(x[10], x[11]) : labScore(x[0], x[1]);
  const idx = rows.map((x, i) => [x, i]).filter(([x]) => x && (x[3] > 0 || x[7]) && sc(x) != null);   // au moins un trade
  const pool = idx.filter(([x]) => x[3] >= LAB_MIN[tf]).length ? idx.filter(([x]) => x[3] >= LAB_MIN[tf]) : idx;
  return pool.length ? pool.reduce((a, b) => sc(b[0]) > sc(a[0]) ? b : a)[1] : -1;
}
// Choix par unité pour l'ajout groupé : la case touchée dans la ligne, sinon la meilleure. Cochée d'office si le verdict est bon
// et que l'action n'a pas déjà une SMA dans cette unité au radar (vos SMA existantes ne sont jamais changées).
function labAddPlan(t, r, U, best) {
  return U.map(tf => {
    const i = labPick[t] && labPick[t][tf] != null ? labPick[t][tf] : best[tf], x = i >= 0 ? r[tf][labFee].sma[i] : null;
    const v = labVerdict(x, tf), mine = S.watch.filter(w => w.ticker === t && w.tf === tf && !w.idx), dup = x && mine.some(w => w.period === LAB_P[i]);
    const can = !!x && !dup, def = can && !mine.length && v[1] !== 'v3', c = labChk[t] && labChk[t][tf] != null ? labChk[t][tf] && can : def;
    return { tf, i, x, v, mine, dup, can, on: c };
  });
}
function labAddBox(t, plan) {
  const on = plan.filter(p => p.on);
  return `<div class="ladd"><h3>Ajouter au radar</h3><div class="laddl">${plan.map(p => `<label class="${p.can ? '' : 'off'}"><input type="checkbox" data-act="lab-chk" data-t="${esc(t)}" data-tf="${p.tf}" ${p.on ? 'checked' : ''} ${p.can ? '' : 'disabled'}>
      <b>${TF_SHORT[p.tf]} ${p.i >= 0 ? LAB_P[p.i] : '—'}</b><span class="lv ${p.v[1]}">${p.v[0]}</span>
      <small>${p.dup ? 'déjà au radar' : p.mine.length ? 'vous avez déjà ' + p.mine.map(w => TF_SHORT[w.tf] + ' ' + w.period).join(', ') + ' : gardée, celle-ci s’ajouterait à côté' : p.x ? `CAGR ${fmtNum(p.x[0], 1)} % · DD ${fmtNum(p.x[1], 0)} %` : ''}</small></label>`).join('')}</div>
    <p class="hint">Touchez une case de la grille pour choisir une autre SMA dans sa ligne.</p>
    <button class="btn primary" data-act="lab-add3" data-t="${esc(t)}" ${on.length ? '' : 'disabled'}>${on.length ? `Ajouter ${on.map(p => TF_SHORT[p.tf] + ' ' + LAB_P[p.i]).join(' · ')} au radar` : 'Rien de coché'}</button></div>`;
}
// Une de vos SMA du radar jugée faible par le Labo (assez de trades, verdict « Faible / à écarter »).
function labWeak(r, w) {
  const u = r[w.tf], i = LAB_P.indexOf(w.period), x = u && i >= 0 ? u[labFee].sma[i] : null;
  return !!x && x[3] >= LAB_MIN[w.tf] && labVerdict(x, w.tf)[1] === 'v3';
}
function labCard(t) {
  const r = Lab.res[t];
  if (!r || r.err) return '';
  const U = ['D', 'W', 'M'].filter(tf => r[tf]);
  const best = Object.fromEntries(U.map(tf => [tf, labBest(r[tf][labFee].sma, tf)]));
  if (r.C) best.C = labBest(r.C[labFee].sma, 'C');
  const sel = labSel[t] || (() => { const tf = U.slice().sort((a, b) => { const sa = best[a] >= 0 ? labScore(...r[a][labFee].sma[best[a]].slice(0, 2)) : -9, sb = best[b] >= 0 ? labScore(...r[b][labFee].sma[best[b]].slice(0, 2)) : -9; return sb - sa; })[0]; return [tf, best[tf]]; })();
  const open = labOpen.has(t), mineL = S.watch.filter(w => w.ticker === t && !w.idx), inR = mineL.length > 0;
  const summary = U.map(tf => { const i = best[tf], x = i >= 0 ? r[tf][labFee].sma[i] : null, v = labVerdict(x, tf);
    return `<span class="lb ${v[1]}"><b>${TF_SHORT[tf]} ${i >= 0 ? LAB_P[i] : '—'}</b>${x ? `${fmtNum(x[0], 1)} % · DD ${fmtNum(x[1], 0)} %` : ''}</span>`; }).join('');
  let body = '';
  if (open) {
    const grid = `<div class="lgrid"><span></span>${LAB_P.map(p => `<span>${p}</span>`).join('')}${['D', 'W', 'M'].concat(r.C ? ['C'] : []).map(tf => `<span${tf === 'C' ? ' class="lc" title="Combiné J + S + M"' : ''}>${tf === 'C' ? 'JSM' : TF_SHORT[tf]}</span>${LAB_P.map((p, i) => {
      const x = r[tf] && r[tf][labFee].sma[i]; if (!x) return '<i class="na" title="Historique insuffisant">·</i>';
      const s = labScore(x[0], x[1]), mine = S.watch.some(w => w.ticker === t && w.tf === tf && w.period === p && !w.idx);
      return `<button type="button" class="${labCol(s)}${x[3] < LAB_MIN[tf] ? ' few' : ''}${best[tf] === i ? ' best' : ''}${mine ? ' mine' : ''}${sel[0] === tf && sel[1] === i ? ' sel' : ''}" data-act="lab-cell" data-t="${esc(t)}" data-tf="${tf}" data-i="${i}" aria-label="${LT(tf)} ${p} : CAGR ${fmtNum(x[0], 1)} %, drawdown ${fmtNum(x[1], 0)} %"></button>`; }).join('')}`).join('')}</div>`;
    const [tf, i] = sel, u = r[tf], x = u && i >= 0 ? u[labFee].sma[i] : null;
    let det = '<p class="hint">Touchez une case de la grille.</p>';
    if (x) {
      const v = labVerdict(x, tf), bh = u[labFee].bh, nb = [i - 1, i + 1].map(k => u[labFee].sma[k]).filter(Boolean), s = labScore(x[0], x[1]);
      const stable = nb.length && s > 0 ? nb.reduce((a, y) => a + (labScore(y[0], y[1]) || 0), 0) / nb.length >= 0.6 * s : null;
      const si = labScore(x[10], x[11]), so = labScore(x[8], x[9]), holds = si != null && so != null ? (x[8] > 0 && so >= 0.5 * si) : null;
      const bi = labBest(u[labFee].sma, tf, true), bx = bi >= 0 ? u[labFee].sma[bi] : null;
      const has = S.watch.some(w => w.ticker === t && w.tf === tf && w.period === LAB_P[i]);
      const k = (l, val, c) => `<div><small>${l}</small><b class="${c || ''}">${val}</b></div>`;
      det = `<div class="lsel"><h3>${LT(tf)} ${LAB_P[i]} <small>${LL(tf)}</small></h3><span class="lv ${v[1]}">${v[0]}</span></div>
        <div class="lkpi">${k('CAGR', fmtNum(x[0], 1) + ' %', cls(x[0]))}${k('Drawdown max', fmtNum(x[1], 1) + ' %')}${k('CAGR / DD', s == null ? '—' : fmtNum(s, 2))}${k('Profit factor', x[2] == null ? '—' : x[2] >= 999 ? '∞' : fmtNum(x[2], 2))}
          ${k('Trades / gagnants', `${x[3]}${x[7] ? ' (+1 en cours)' : ''} / ${x[4] == null ? '—' : fmtNum(x[4], 0) + ' %'}`)}${k('Trade moyen', x[6] == null ? '—' : pct(x[6], true), cls(x[6]))}${k('Temps investi', fmtNum(x[5], 0) + ' %')}${k('Acheter et garder', `${fmtNum(bh[0], 1)} % · DD ${fmtNum(bh[1], 0)} %`)}</div>
        <p class="hint">${u.first ? `Données Twelve Data depuis le ${fmtDate(u.first)} (${fmtNum(u.bars, 0)} bougies). ` : ''}Période testée : ${fmtDate(u.from)} → ${fmtDate(u.to)} (même période pour toutes les SMA ${LL(tf)}s${u.first && u.from > u.first ? ` : elle commence après le calcul de la plus longue SMA testable` : ''}).${u.first ? '' : ' Date de début des données : au prochain test.'}${tf === 'C' ? ` Achat quand la clôture passe au-dessus de la SMA ${LAB_P[i]} journalière et qu’elle est au-dessus de S ${u[labFee].w} et M ${u[labFee].m} (meilleures SMA hebdo et mensuelle, semaine et mois terminés) ; sortie sous la SMA journalière.` : ''} ${x[3] < LAB_MIN[tf] ? `Moins de ${LAB_MIN[tf]} trades : résultat peu fiable. ` : ''}</p>
        <div class="lchk"><span class="${holds === true ? 'ok' : holds === false ? 'bad' : ''}"><b>Période récente</b> (${fmtDate(u.split).replace(/ \d{4}$/, '') + ' ' + u.split.slice(0, 4)} → ${u.to.slice(0, 4)}) : CAGR ${x[8] == null ? '—' : fmtNum(x[8], 1) + ' %'}, DD ${x[9] == null ? '—' : fmtNum(x[9], 0) + ' %'} · ${holds == null ? 'non mesurable' : holds ? 'tient toujours' : 'moins bon récemment'} <small>(acheter et garder : ${fmtNum(bh[2], 1)} %)</small></span>
          <span class="${stable === true ? 'ok' : stable === false ? 'bad' : ''}"><b>SMA voisines</b> : ${stable == null ? '—' : stable ? 'zone stable, pas un coup de chance' : 'zone fragile, pic isolé'}</span>
          ${bx ? `<span><b>Choisie sur les 70 % anciens</b> : ${LT(tf)} ${LAB_P[bi]} → sur la période récente CAGR ${x && bx[8] != null ? fmtNum(bx[8], 1) + ' %' : '—'}, DD ${bx[9] == null ? '—' : fmtNum(bx[9], 0) + ' %'}</span>` : ''}</div>
        <div class="row" style="margin-top:10px">${tf === 'C' ? (d => `<span class="hint" style="margin:0">Comparez avec J ${LAB_P[i]} seule : ${d ? `CAGR ${fmtNum(d[0], 1)} % · DD ${fmtNum(d[1], 0)} %` : '—'}.</span><button class="btn sm primary" data-act="lab-combo" data-t="${esc(t)}" data-i="${i}" data-w="${u[labFee].w}" data-m="${u[labFee].m}">Choisir J ${LAB_P[i]} · S ${u[labFee].w} · M ${u[labFee].m}</button>`)(r.D && r.D[labFee].sma[i]) : has ? `<span class="pill win">${TF_SHORT[tf]} ${LAB_P[i]} déjà au radar</span>` : `<button class="btn sm primary" data-act="lab-add" data-t="${esc(t)}" data-tf="${tf}" data-i="${i}">Ajouter ${TF_SHORT[tf]} ${LAB_P[i]} au radar</button>`}</div>`;
    }
    body = `${grid}${labAddBox(t, labAddPlan(t, r, U, best))}<p class="hint lleg"><i class="l4"></i>CAGR ÷ DD ≥ 0,5 <i class="l3"></i>≥ 0,35 <i class="l2"></i>≥ 0,2 <i class="l1"></i>faible <i class="l0"></i>perte · ★ meilleure de la ligne · <b class="lmine">○</b> votre SMA actuelle au radar · hachuré : trop peu de trades</p>${det}`;
  }
  return `<article class="lcard${open ? ' open' : ''}"><button type="button" class="lhead" data-act="lab-open" data-t="${esc(t)}"><span class="tk">${esc(t)}</span>${inR ? `<span class="pill open">Au radar : ${mineL.map(w => TF_SHORT[w.tf] + ' ' + w.period + (labWeak(r, w) ? ' <b class="lweak" title="Jugée faible par le Labo">faible</b>' : '')).join(' · ')}</span>` : ''}<span class="lbs">${summary}</span></button>${body}</article>`;
}
function viewLab() {
  const q = labQueue(), inR = labRadarT(), res = Lab.res || {};
  const todo = q;
  const done = todo.filter(t => res[t] && !res[t].err), errs = todo.filter(t => res[t] && res[t].err), wait = todo.filter(t => !res[t]);
  const repo = repoInfo();
  const chips = q.map(t => { const x = res[t], st = x && !x.err ? 'ok' : x && x.err ? 'err' : 'wait';
    return `<span class="lq ${st}" title="${st === 'err' ? esc(x.err) : inR.has(t) ? 'Au radar' : ''}">${esc(t)}<button type="button" data-act="lab-del" data-t="${esc(t)}" aria-label="Retirer ${esc(t)}">×</button></span>`; }).join('');
  const shown = done;
  return `<section class="card">
    <div class="sec-head"><h2>Labo SMA <small>· achat long seulement</small></h2><button class="btn sm" data-tab="radar">← Radar</button></div>
    <p class="lead">Le robot teste ${LAB_P.length} SMA (${LAB_P.join(', ')}) en journalier, hebdo et mensuel, comme votre script TradingView : achat à la clôture au-dessus, sortie à la clôture en dessous, 100 % du capital sans levier. Vous pouvez y mettre aussi des actions du radar : le Labo n’ajoute ni ne change jamais rien au radar, seul le bouton « Ajouter au radar » le fait.</p>
    <div class="fields"><div class="fld wide"><label for="lab-in">Tickers à tester</label><textarea id="lab-in" rows="2" autocapitalize="characters" placeholder="AAPL, PLTR, AMD…"></textarea></div></div>
    <div class="row"><button class="btn primary" data-act="lab-go">Lancer</button>${q.length ? `<button class="btn sm" data-act="lab-clear">Tout retirer</button>` : ''}</div>
    ${q.length ? `<div class="lprog"><i style="width:${todo.length ? (done.length + errs.length) / todo.length * 100 : 100}%"></i></div>
      <p class="hint">${done.length} / ${todo.length} testée(s)${errs.length ? ` · ${errs.length} introuvable(s)` : ''}${wait.length ? ` · ${wait.length} en attente : environ 40 par passage du robot (après la clôture), ou lancez-le tout de suite dans <a href="${repo}/actions/workflows/radar.yml" target="_blank" rel="noopener">GitHub › Actions › Run workflow</a>` : ' · terminé'}.</p>
      <div class="lqs">${chips}</div>` : ''}
  </section>
  ${shown.length ? `<section class="card">
    <div class="sec-head"><h2>Résultats</h2><div class="seg" role="group" aria-label="Frais"><button type="button" data-act="lab-fee" data-f="tv" aria-pressed="${labFee === 'tv'}">Comme TradingView</button><button type="button" data-act="lab-fee" data-f="ic" aria-pressed="${labFee === 'ic'}">IC Markets réel</button></div></div>
    <p class="hint">${labFee === 'ic' ? 'Frais IC Markets : 0,02 $ par action et swap acheteur de 5,93 % par an chaque nuit en position.' : 'Frais du script : 0,10 % par ordre et 1 tick de glissement, sans swap.'} Meilleure SMA = meilleur CAGR ÷ drawdown avec assez de trades (${LAB_MIN.D} en J, ${LAB_MIN.W} en S, ${LAB_MIN.M} en M). Touchez une action pour la grille complète.</p>
    <div class="lcards">${shown.sort().map(labCard).join('')}</div>
    <p class="fine">Résultats passés, calculés sur les cours ${adjMode() === 'all' ? 'ajustés des dividendes' : 'non ajustés'} de Twelve Data (journalier : 20 ans au plus). Choisir la meilleure de 45 combinaisons surestime l’avenir : regardez la période récente et les SMA voisines.</p>
  </section>` : ''}`;
}
function labGo() {
  const el = $('#lab-in'), raw = (el && el.value || '').toUpperCase().match(/[A-Z][A-Z0-9.\-]{0,9}/g) || [];
  const inR = labRadarT(), q = labQueue(), add = [...new Set(raw)].filter(t => !q.includes(t));
  if (!add.length) { toast('Aucun nouveau ticker'); return; }
  const r = add.filter(t => inR.has(t)).length;
  S.settings.labQueue = q.concat(add);
  save(`${add.length} action(s) ajoutée(s) au Labo${r ? ` (dont ${r} du radar : vos SMA ne changent pas)` : ''}`);
}
// ----- Aides au trading : information seulement, rien n'est bloqué et le calculateur garde votre stop -----
// Feu du marché : part de vos SMA de SPY, QQQ et DIA sous le cours (vert ≥ 70 %, rouge ≤ 30 %).
function marketLight() {
  let up = 0, n = 0; const per = [];
  for (const [t, name] of IDX) {
    let u = 0, k = 0;
    for (const w of idxWatch(t)) { const s = idxSide(analyzeWatch(w)); if (!s) continue; k++; if (s === 'up') u++; }
    if (k) per.push({ t, name, u, k });
    up += u; n += k;
  }
  if (!n) return null;
  const r = up / n, lvl = r >= 0.7 ? 'go' : r <= 0.3 ? 'stop' : 'mid';
  return { up, n, per, lvl, label: { go: 'Feu vert', mid: 'Feu orange', stop: 'Feu rouge' }[lvl],
    txt: { go: 'marché au-dessus de la plupart de vos SMA : contexte favorable aux achats long', mid: 'marché partagé : soyez sélectif', stop: 'marché sous la plupart de vos SMA : les achats long réussissent moins souvent' }[lvl] };
}
const feuLine = L => L ? `<div class="feu ${L.lvl}"><i aria-hidden="true"></i><span><strong>${L.label}</strong> · ${L.up}/${L.n} de vos SMA au-dessus (${L.per.map(p => `${p.t} ${p.u}/${p.k}`).join(', ')}) : ${L.txt}.</span></div>` : '';
// Feu du marché à une date passée, avec l'historique de SPY, QQQ et DIA (bougie en cours comprise pour S et M).
const lightMemo = new Map();
function lightAt(d) {
  if (lightMemo.has(d)) return lightMemo.get(d);
  let up = 0, n = 0;
  for (const [t] of IDX) {
    const h = Radar.hist[t]; if (!h || !h.bars.length) continue;
    const bars = h.bars.filter(b => b[0] <= d); if (!bars.length) continue;
    for (const w of idxWatch(t)) {
      const c = []; let k0 = null;   // clôtures par bougie (sans le cache de groupBars : une série par date)
      for (const [dd, x] of bars) { const k = periodKey(w.tf, dd); if (k === k0) c[c.length - 1] = x; else { c.push(x); k0 = k; } }
      if (c.length < w.period) continue;
      const s = c.slice(-w.period).reduce((a, x) => a + x, 0) / w.period;
      n++; if (c[c.length - 1] > s) up++;
    }
  }
  const r = n ? (up / n >= 0.7 ? 'Feu vert' : up / n <= 0.3 ? 'Feu rouge' : 'Feu orange') : null;
  lightMemo.set(d, r); return r;
}

// Stops à remonter : une de vos SMA de l'action est passée entre le stop actuel et le cours.
const SKIP_KEY = 'carnet-positions:stop-skip';
const stopSkip = () => { try { return JSON.parse(localStorage.getItem(SKIP_KEY)) || {}; } catch (e) { return {}; } };
// SMA d'entrée d'une position (lot.smas : ['D|200', 'W|13'…]), choisies à l'achat ou plus tard. Vide : toutes les SMA de l'action.
const smaKey = w => w.tf + '|' + w.period, smaLbl = k => { const [tf, p] = k.split('|'); return TF_SHORT[tf] + ' ' + p; };
const posSmas = t => [...new Set(S.lots.filter(l => l.ticker === t && !Core.lotState(l).closed).flatMap(l => l.smas || []))];
// Stop atteint : on juge à la clôture de l'unité d'entrée (la plus longue des SMA de la position : M, sinon S, sinon J).
// J ou aucune SMA : chaque soir. S : clôtures du jeudi et du vendredi. M : clôtures des 7 derniers jours du mois.
function stopTf(t) { const u = posSmas(t).map(k => k.split('|')[0]); return u.includes('M') ? 'M' : u.includes('W') ? 'W' : 'D'; }
const monthEnd = d => { const x = new Date(d.slice(0, 7) + '-01T12:00:00'); x.setMonth(x.getMonth() + 1); x.setDate(0); return x.toLocaleDateString('sv-SE'); };
function stopDue(tf, d) {   // date de la clôture qui compte (dernier jour ouvré de la semaine ou du mois)
  if (tf === 'W') return addDays(d, Math.max(0, 5 - wdOf(d)));
  if (tf === 'M') { let e = monthEnd(d); while (wdOf(e) === 0 || wdOf(e) === 6) e = addDays(e, -1); return e; }
  return d;
}
function stopWindow(tf, d) {   // d : date de la dernière clôture connue
  if (tf === 'W') return wdOf(d) >= 4 || wdOf(d) === 0;
  if (tf === 'M') return +d.slice(8) >= +monthEnd(d).slice(8) - 6;
  return true;
}
const WD_S = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const stopDueLbl = (tf, d) => { const e = stopDue(tf, d); return `clôture ${tf === 'W' ? 'hebdo' : 'mensuelle'} ${WD_S[wdOf(e)]} ${e.slice(8)}/${e.slice(5, 7)}`; };
const stopWaitLbl = (tf, d) => tf === 'W' ? 'clôture hebdo' : 'fin ' + new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { month: 'short' });
// Positions dont le cours est sur ou sous le stop : à juger ce soir (dans la fenêtre) ou en attente de la clôture.
function stopHits() {
  const by = new Map();
  for (const l of S.lots) { if (Core.lotState(l).closed) continue; (by.get(l.ticker) || by.set(l.ticker, []).get(l.ticker)).push(l); }
  const out = [];
  for (const [t, ls] of by) {
    const last = Core.lastPrice(S.prices, t); if (!last) continue;
    const hit = ls.map(l => l.stopCurrent).filter(x => isNum(x) && x > 0 && last.price <= x);
    if (!hit.length) continue;
    const tf = stopTf(t);
    out.push({ t, tf, px: last.price, date: last.date, stop: Math.max(...hit), now: stopWindow(tf, last.date), lot: ls[0].id });
  }
  return out.sort((a, b) => a.t < b.t ? -1 : 1);
}
// Choix : les SMA de l'action au radar, plus toute autre SMA ajoutée à la main (unité + période).
const smaChip = (k, on) => `<label class="chip"><input type="checkbox" name="sma" value="${esc(k)}" ${on ? 'checked' : ''}> ${smaLbl(k)}</label>`;
function smaChoices(t, on) {
  const ks = [...new Set(S.watch.filter(w => w.ticker === t && !w.idx).map(smaKey).concat(on))];
  return `<div class="smabox"><div class="smach">${ks.map(k => smaChip(k, on.includes(k))).join('')}</div>
    ${ks.length ? '' : `<p class="hint smanone">Aucune SMA de ${esc(t || 'cette action')} dans votre radar : ajoutez la vôtre ci-dessous.</p>`}
    <div class="smaadd"><select name="smaTf" aria-label="Unité">${['D', 'W', 'M'].map(tf => `<option value="${tf}">${TF_SHORT[tf]} · ${TF_LONG[tf]}</option>`).join('')}</select>
      <input name="smaP" inputmode="numeric" placeholder="200" aria-label="Période de la SMA"><button type="button" class="btn sm" data-act="sma-add">Ajouter</button></div>
    <label class="check"><input type="checkbox" name="smaRadar" checked> Ajouter au radar celles qui n’y sont pas (nécessaire pour vous proposer leurs stops)</label></div>`;
}
const smaPicked = form => [...form.querySelectorAll('input[name=sma]:checked')].map(i => i.value);
// SMA cochées absentes du radar : ajoutées au radar si la case est cochée (geste de l'utilisateur, jamais automatique).
function smaToRadar(form, t, ks) {
  const box = form.elements.smaRadar; if (!box || !box.checked) return 0;
  const add = ks.filter(k => !S.watch.some(w => w.ticker === t && !w.idx && smaKey(w) === k));
  for (const k of add) { const [tf, p] = k.split('|'); S.watch.push({ id: uid(), ticker: t, period: +p, tf, sym: '', note: 'Position' }); }
  return add.length;
}
function sheetPosSma(t) {
  openSheet({ title: 'SMA de la position ' + t, ok: 'Enregistrer',
    body: `<p class="lead">Les SMA grâce auxquelles vous êtes entré. Seuls leurs stops vous seront proposés (app et notifications).</p>${smaChoices(t, posSmas(t))}<p class="hint">Rien de coché : toutes les SMA de l'action sont proposées, comme avant.</p>`,
    onSubmit: form => { const k = smaPicked(form); for (const l of S.lots.filter(l => l.ticker === t && !Core.lotState(l).closed)) l.smas = k;
      const n = smaToRadar(form, t, k); closeSheet(); save((k.length ? `${t} : ${k.map(smaLbl).join(' · ')}` : `${t} : toutes les SMA`) + (n ? ` · ${n} ajoutée(s) au radar` : '')); if (n) refreshRadar(); } });
}
function stopRaises() {
  const out = [], seen = new Set(), skip = stopSkip();
  for (const v of S.lots.map(lotView)) {
    if (v.ls.closed || seen.has(v.lot.ticker)) continue;
    seen.add(v.lot.ticker);
    const st = isNum(v.lot.stopCurrent) ? v.lot.stopCurrent : 0, px = v.last ? v.last.price : null, rem = S.lots.filter(l => l.ticker === v.lot.ticker).reduce((a, l) => a + Core.lotState(l).rem, 0);
    const opts = [], mine = posSmas(v.lot.ticker);
    for (const w of S.watch) {
      if (w.ticker !== v.lot.ticker || w.idx || (mine.length && !mine.includes(smaKey(w)))) continue;
      const a = analyzeWatch(w); if (!a || a.short) continue;
      if (a.sma > st * 1.005 && (px == null || a.sma < px) && !skip[`${v.lot.id}|${w.id}|${st}`]) opts.push({ w, sma: a.sma, prot: rem * (a.sma - st) });
    }
    if (opts.length) out.push({ v, st, px, opts: opts.sort((a, b) => b.sma - a.sma) });
  }
  return out;
}
// ----- « Ce soir » : la routine en une liste (stops à remonter, meilleurs croisements, résultats, santé, risque) -----
// Information et raccourcis seulement : « Fait » enregistre le stop dans l'app (à changer aussi dans MT5), rien n'est acheté.
const TN_KEY = 'carnet-ce-soir';
function tnDone() { try { const x = JSON.parse(localStorage.getItem(TN_KEY) || 'null'); return x && x.d === todayISO() ? x.k : []; } catch (e) { return []; } }
function tnMark(k) { const k0 = tnDone(); if (!k0.includes(k)) k0.push(k); try { localStorage.setItem(TN_KEY, JSON.stringify({ d: todayISO(), k: k0 })); } catch (e) {} }
// Note du Labo pour une SMA du radar : [libellé, rang] (rang 3 = très intéressant … 0 = faible), null si pas testée.
function labGrade(w) {
  const r = Lab.res && Lab.res[w.ticker], u = r && !r.err && r[w.tf], i = LAB_P.indexOf(w.period), x = u && i >= 0 ? u[labFee].sma[i] : null;
  if (!x) return null;
  const v = labVerdict(x, w.tf);
  return [v[0], v[1] === 'v1' ? 3 : v[1] === 'v2' ? 2 : x[3] < LAB_MIN[w.tf] ? 1 : 0];
}
// Part de l'exposition par secteur (positions ouvertes, au dernier cours).
function sectExpoShare() {
  const by = {}; let tot = 0;
  for (const v of S.lots.map(lotView)) { if (v.ls.closed) continue; const e = v.ls.rem * (v.last ? v.last.price : v.lot.price), k = sectorOf(v.lot.ticker) || 'Non classé'; by[k] = (by[k] || 0) + e; tot += e; }
  for (const k in by) by[k] = tot > 0 ? by[k] / tot * 100 : 0;
  return by;
}
// Croisements à la hausse non vus, sur des actions pas déjà en portefeuille, notés puis triés (une ligne par action).
function tonightPicks() {
  if (!S.watch.length) return { top: [], n: 0 };
  const held = new Set(S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker)), share = sectExpoShare(), lim = sectSet().expo, today = todayISO();
  const best = new Map();
  for (const x of radarAlerts()) {
    if (x.seen || x.lvl !== 'up' || x.w.idx || held.has(x.w.ticker)) continue;
    const g = labGrade(x.w), e = nextEarn(x.w.ticker), eDays = e ? Core.days(today, e[0]) : null, sec = sectorOf(x.w.ticker), sp = sec ? share[sec] || 0 : null;
    const score = (g ? g[1] : 1) * 10 + (eDays != null && eDays <= 7 ? -8 : 0) + (sp != null && sp >= lim ? -6 : 0) + (x.date >= addDays(today, -3) ? 2 : 0);
    const notes = [g ? 'Labo : ' + g[0].toLowerCase() : 'Labo : pas testée'];
    if (eDays != null && eDays <= 7) notes.push(`résultats dans ${eDays} j`); else if (e) notes.push('pas de résultats sous 7 j');
    if (sec && sp != null) notes.push(`${sec} ${fmtNum(sp, 0)} %${sp >= lim ? ' (au-dessus de votre seuil)' : ''}`);
    const cur = best.get(x.w.ticker);
    if (!cur || score > cur.score) best.set(x.w.ticker, { x, score, notes });
  }
  const all = [...best.values()].sort((a, b) => b.score - a.score || (a.x.date < b.x.date ? 1 : -1));
  return { top: all.slice(0, 5), n: all.length };
}
function tonightCard() {
  if (!S.lots.some(l => !l.demo) && !S.watch.length) return '';
  const done = tnDone(), sr = S.watch.length ? stopRaises() : [], P = tonightPicks(), today = todayISO();
  const open = S.lots.filter(l => !Core.lotState(l).closed), nextD = (() => { let d = addDays(today, 1); while (wdOf(d) === 0 || wdOf(d) === 6) d = addDays(d, 1); return d; })();
  const earnT = [...new Set(open.map(l => l.ticker))].filter(t => { const e = nextEarn(t); return e && e[0] <= nextD; });
  const H = healthChecks().filter(x => x.lvl !== 'stat'), R = portfolioRisk(), L = riskLim(), min = S.settings.marginMin || 150;
  const over = [];
  if (R.level != null && R.level < min) over.push(`niveau de marge ${fmtNum(R.level, 0)} % (sous ${fmtNum(min, 0)} %)`);
  if (L.heat != null && R.heatPct > L.heat) over.push(`perte au stop ${pct(R.heatPct)} (limite ${pct(L.heat)})`);
  if (L.margin != null && R.marginPct > L.margin) over.push(`marge ${fmtNum(R.marginPct, 0)} % (limite ${fmtNum(L.margin, 0)} %)`);
  if (L.pos != null && R.pos > L.pos) over.push(`${R.pos} positions (limite ${L.pos})`);
  const SH = stopHits(), hitNow = SH.filter(x => x.now && !done.includes('hit|' + x.t + '|' + x.date)), hitWait = SH.filter(x => !x.now);
  const hitRow = (x, now) => `<div class="tnr"><span><button class="lnk tk" data-act="chart" data-t="${esc(x.t)}">${esc(x.t)}</button> <span class="tf">${x.tf === 'D' ? 'J' : TF_SHORT[x.tf]}</span> <span class="num">${usd(x.px)} / stop ${usd(x.stop)}</span>${now && x.tf !== 'D' ? ` <small>${stopDueLbl(x.tf, x.date)}</small>` : ''}</span>${now ? `<button class="btn sm primary" data-act="tn-hit" data-k="${esc(x.t + '|' + x.date)}">Fait</button>` : `<small>${stopWaitLbl(x.tf, x.date)}</small>`}</div>`;
  const todo = hitNow.length + sr.length + P.top.length + (earnT.length ? 1 : 0) + (H.length ? 1 : 0), nd = done.length;
  const stops = sr.map(x => { const o = x.opts[0];
    return `<div class="tnr"><span><button class="lnk tk" data-act="chart" data-t="${esc(x.v.lot.ticker)}" data-w="${esc(o.w.id)}">${esc(x.v.lot.ticker)}</button> <span class="tf">${TF_SHORT[o.w.tf]}${o.w.period}</span> <span class="num">${x.st > 0 ? usd(x.st) : 'aucun'} → <b>${usd(o.sma)}</b></span>${x.opts.length > 1 ? ` <button class="lnk" data-act="stop-raises">${x.opts.length - 1} autre(s)</button>` : ''}</span><button class="btn sm primary" data-act="tn-stop" data-t="${esc(x.v.lot.ticker)}" data-v="${Core.roundTo(o.sma, 2)}" data-w="${esc(o.w.id)}">Fait</button></div>`; }).join('');
  const picks = P.top.map(p => `<div class="tnr"><span><button class="lnk tk" data-act="chart" data-t="${esc(p.x.w.ticker)}" data-w="${esc(p.x.w.id)}">${esc(p.x.w.ticker)}</button> <span class="tf up">${TF_SHORT[p.x.w.tf]}${p.x.w.period}</span> <small>${esc(p.notes.join(' · '))}</small></span><span class="row"><button class="btn sm" data-act="tn-calc" data-id="${esc(p.x.w.id)}" data-k="${esc(p.x.key)}">Calculer</button><button class="btn sm" data-act="tn-skip" data-k="${esc(p.x.key)}" aria-label="Écarter ${esc(p.x.w.ticker)}">✕</button></span></div>`).join('');
  const light = typeof marketLight === 'function' ? marketLight() : null;
  return `<section class="card tn" id="tonight">
    <div class="sec-head"><h2>Ce soir <small>· ${fmtDate(today)}</small></h2><span class="pill ${todo ? 'warn' : 'win'}">${todo ? `${nd} fait · ${todo} à faire` : 'Tout est fait'}</span></div>
    ${SH.length ? `<h3>Sous le stop <small>· ${hitNow.length} à juger ce soir</small></h3>
    ${hitNow.map(x => hitRow(x, true)).join('')}${hitNow.length ? '<p class="hint">Si la clôture qui compte reste sous le stop : vendre dans MT5. « Fait » une fois vendu ou gardé.</p>' : '<p class="hint">Rien à vendre ce soir.</p>'}
    ${hitWait.length ? `<details><summary class="hint">${hitWait.length} sous le stop · on attend la clôture</summary>${hitWait.map(x => hitRow(x, false)).join('')}</details>` : ''}` : ''}
    <h3>1. Stops à remonter dans MT5 <small>· ${sr.length}</small></h3>
    ${sr.length ? stops + '<p class="hint">« Fait » enregistre le nouveau stop dans l’app. Changez-le aussi dans MT5 : rien n’est envoyé au courtier.</p>' : '<p class="hint">Aucun stop à remonter ce soir.</p>'}
    <h3>2. Nouveaux croisements à étudier <small>· ${P.top.length} sur ${P.n}</small></h3>
    ${P.top.length ? picks + `<p class="hint">Croisements à la hausse non vus, hors positions déjà ouvertes, triés par note du Labo, résultats et secteur. ${P.n > P.top.length ? `Les ${P.n - P.top.length} autres et les alertes « proches » restent dans le radar. ` : ''}${light ? esc(light.label + ' : ' + light.txt) + '.' : ''}</p>` : '<p class="hint">Aucun nouveau croisement à la hausse.</p>'}
    <h3>3. Avant d’aller dormir</h3>
    <div class="tnr"><span>Résultats d’ici le ${fmtDate(nextD)} : ${earnT.length ? '<b>' + earnT.map(esc).join(', ') + '</b>' : 'aucun'}</span>${earnT.length ? '<button class="btn sm" data-act="go-tab" data-tab="earn">Voir</button>' : '<small>ok</small>'}</div>
    <div class="tnr"><span>Santé des données : ${H.length ? esc(H[0].title.replace(/<[^>]+>/g, '')) + (H.length > 1 ? ` <small>+ ${H.length - 1}</small>` : '') : 'tout est bon'}</span>${H.length ? '<button class="btn sm" data-act="go-health">Voir</button>' : '<small>ok</small>'}</div>
    ${S.lots.some(l => !l.demo) ? `<div class="tnr"><span>Historique MT5 : ${S.settings.mt5 && S.settings.mt5.upTo ? 'importé jusqu’au ' + fmtDate(S.settings.mt5.upTo) : 'jamais importé'}</span><button class="btn sm" data-act="mt5-import">Importer</button></div>` : ''}
    <div class="tnr"><span>Risque : ${over.length ? `<b class="neg">${esc(over.join(' · '))}</b>` : 'dans vos limites'}</span>${over.length ? '<button class="btn sm" data-act="risk-set">Limites</button>' : '<small>ok</small>'}</div>
  </section>`;
}
// ----- Graphique intégré : bougies (ouverture, haut, bas fournis par le robot) ou clôtures, vos SMA, entrées, ventes, stop -----
// Historique du radar (cours ajustés comme les SMA) : aucune autre source, fonctionne hors ligne.
let chartSt = null;
const CH_R = [['1 M', 22], ['3 M', 66], ['6 M', 130]];
// SMA d'une unité à chaque séance : J = moyenne des n dernières clôtures ; S et M = moyenne des n dernières bougies terminées (palier).
function smaDaily(bars, w) {
  const n = w.period, out = new Array(bars.length).fill(null);
  if (w.tf === 'D') { let s = 0; for (let i = 0; i < bars.length; i++) { s += bars[i][1]; if (i >= n) s -= bars[i - n][1]; if (i >= n - 1) out[i] = s / n; } return out; }
  const g = groupBars(bars, w.tf), idx = new Map(g.map((b, j) => [b.k, j])), pre = [0];
  for (const b of g) pre.push(pre[pre.length - 1] + b.c);
  for (let i = 0; i < bars.length; i++) { const j = idx.get(periodKey(w.tf, bars[i][0])); if (j != null && j >= n) out[i] = (pre[j] - pre[j - n]) / n; }
  return out;
}
function chartSvg() {
  const { t, n, wid } = chartSt, all = tickerBars(t);
  if (!all || !all.length) return '<p class="hint">Pas d’historique pour cette action : ajoutez-la au radar pour voir son graphique.</p>';
  const i0 = Math.max(0, all.length - n), D = all.slice(i0), W = 340, H = 210, L = 38, R = 6, T = 8, B = 20;
  const lots = S.lots.filter(l => l.ticker === t), mine = posSmas(t), wl = S.watch.filter(w => w.ticker === t && !w.idx && (w.id === wid || !mine.length || mine.includes(smaKey(w)))).slice(0, 3);
  const sm = wl.map(w => ({ w, v: smaDaily(all, w).slice(i0) }));
  const open = lots.find(l => !Core.lotState(l).closed) || lots.slice().sort((a, b) => a.date < b.date ? 1 : -1)[0];
  const stopOn = d => { if (!open || d < open.date) return null; let v = open.stopInitial; for (const e of open.events || []) if (e.type === 'stop' && e.date <= d) v = e.to; return v > 0 ? v : null; };
  const stops = D.map(b => stopOn(b[0]));
  const vals = D.flatMap(b => b.length >= 5 ? [b[3], b[4]] : [b[1]]).concat(...sm.map(s => s.v.filter(x => x != null)), stops.filter(x => x != null));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.06 || hi * 0.01, a = lo - pad, z = hi + pad;
  const X = i => L + (W - L - R) * (D.length === 1 ? 0.5 : i / (D.length - 1)), Y = v => T + (H - T - B) * (1 - (v - a) / (z - a)), bw = Math.max(1, (W - L - R) / D.length * 0.62);
  const grid = [0, 1, 2, 3].map(k => a + (z - a) * k / 3).map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${fmtNum(v, v < 100 ? 1 : 0)}</text>`).join('');
  // Bougies quand la plupart des séances ont ouverture / haut / bas ; sinon ligne des clôtures (séances isolées sans bougie : un tiret).
  const useC = D.filter(b => b.length >= 5).length >= D.length / 2;
  let candles = '', line = '';
  D.forEach((b, i) => {
    if (useC && b.length >= 5) { const up = b[1] >= b[2], y1 = Y(Math.max(b[1], b[2])), y2 = Y(Math.min(b[1], b[2]));
      candles += `<g class="${up ? 'cu' : 'cd'}"><line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(b[3]).toFixed(1)}" y2="${Y(b[4]).toFixed(1)}"/><rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}"/></g>`; }
    else if (useC) candles += `<line class="tick" x1="${(X(i) - bw / 2).toFixed(1)}" x2="${(X(i) + bw / 2).toFixed(1)}" y1="${Y(b[1]).toFixed(1)}" y2="${Y(b[1]).toFixed(1)}"/>`;
    else line += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(b[1]).toFixed(1);
  });
  const path = arr => { let p = '', on = false; arr.forEach((v, i) => { if (v == null) { on = false; return; } p += (on ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); on = true; }); return p; };
  const di = d => D.findIndex(b => b[0] >= d);
  let marks = '';
  for (const l of lots) {
    const ie = di(l.date); if (ie >= 0 && l.date >= D[0][0]) marks += `<circle class="m-in" cx="${X(ie).toFixed(1)}" cy="${Y(l.price).toFixed(1)}" r="4"><title>Achat ${fmtDate(l.date)} à ${usd(l.price)}</title></circle>`;
    for (const e of (l.events || []).filter(e => e.type === 'sell' && e.date >= D[0][0])) { const is = di(e.date); if (is >= 0) marks += `<circle class="m-out" cx="${X(is).toFixed(1)}" cy="${Y(e.price).toFixed(1)}" r="4"><title>Vente ${qty(e.qty)} le ${fmtDate(e.date)} à ${usd(e.price)}</title></circle>`; }
  }
  const wsel = wl.find(w => w.id === wid);
  if (wsel) { const an = analyzeWatch(wsel); for (const c of (an && an.crosses) || []) { const ic = di(c.date); if (ic >= 0 && c.date >= D[0][0]) marks += `<path class="${c.dir === 'up' ? 'm-up' : 'm-dn'}" d="M${X(ic).toFixed(1)} ${(Y(c.close) + (c.dir === 'up' ? 14 : -14)).toFixed(1)} l-5 ${c.dir === 'up' ? 8 : -8} h10z"/>`; } }
  const entry = open && open.date <= D[D.length - 1][0] ? `<line class="m-entry" x1="${X(Math.max(0, di(open.date))).toFixed(1)}" x2="${W - R}" y1="${Y(open.price).toFixed(1)}" y2="${Y(open.price).toFixed(1)}"/>` : '';
  chartSt.D = D; chartSt.sm = sm; chartSt.stops = stops; chartSt.geo = { L, R, W };
  const fx = d => fmtDate(d).replace(/ \d{4}$/, '');
  return `<svg class="chart cc" id="chSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graphique de ${esc(t)}">${grid}${entry}
    ${sm.map((s, k) => `<path class="sm s${k}" d="${path(s.v)}"/>`).join('')}${stops.some(x => x != null) ? `<path class="stp" d="${path(stops)}"/>` : ''}
    ${line ? `<path class="cl" d="${line}"/>` : ''}${candles}${marks}
    <text x="${L}" y="${H - 5}">${fx(D[0][0])}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">${fx(D[D.length - 1][0])}</text>
    <line id="chCur" class="cur" y1="${T}" y2="${H - B}" x1="0" x2="0" opacity="0"/></svg>
    <div class="chlg">${useC ? '<span><i class="lc"></i>Bougies</span>' : '<span><i class="ll"></i>Clôtures</span>'}${sm.map((s, k) => `<span><i class="ls s${k}"></i>SMA ${TF_SHORT[s.w.tf]}${s.w.period}</span>`).join('')}${stops.some(x => x != null) ? '<span><i class="lst"></i>Stop</span>' : ''}${entry ? `<span><i class="le"></i>Entrée ${usd(open.price)}</span>` : ''}</div>
    <p class="hint" id="chTip">Touchez le graphique pour lire une séance.</p>
    ${useC ? '' : '<p class="hint">Bougies disponibles après le prochain passage du robot (actions de vos trades). En attendant : clôtures.</p>'}`;
}
function chartBind() {
  const svg = $('#chSvg'); if (!svg || !chartSt) return;
  const { D, sm, stops, geo } = chartSt;
  svg.onpointermove = svg.onpointerdown = e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * geo.W;
    const i = Math.max(0, Math.min(D.length - 1, Math.round((px - geo.L) / (geo.W - geo.L - geo.R) * (D.length - 1)))), b = D[i], x = geo.L + (geo.W - geo.L - geo.R) * (D.length === 1 ? 0.5 : i / (D.length - 1));
    const c = $('#chCur'); c.setAttribute('x1', x); c.setAttribute('x2', x); c.setAttribute('opacity', 1);
    const st = stops[i];
    $('#chTip').textContent = `${fmtDate(b[0])} · ${b.length >= 5 ? `O ${fmtNum(b[2], 2)} H ${fmtNum(b[3], 2)} B ${fmtNum(b[4], 2)} ` : ''}C ${fmtNum(b[1], 2)}`
      + sm.map(s => s.v[i] != null ? ` · SMA ${TF_SHORT[s.w.tf]}${s.w.period} ${fmtNum(s.v[i], 2)}` : '').join('') + (st ? ` · stop ${fmtNum(st, 2)} (${fmtNum((b[1] / st - 1) * 100, 1)} % au-dessus)` : '');
  };
}
function sheetChart(t, wid) {
  chartSt = { t, n: (chartSt && chartSt.n) || 66, wid: wid || null };
  openSheet({ title: t + ' · graphique', noFocus: true,
    body: `<div class="row chr">${CH_R.map(([l, n]) => `<button type="button" class="btn sm${chartSt.n === n ? ' on' : ''}" data-act="ch-range" data-n="${n}">${l}</button>`).join('')}</div><div id="chWrap">${chartSvg()}</div>` });
  chartBind();
}
function sheetStopRaises() {
  const R = stopRaises();
  openSheet({ title: 'Stops à remonter', noFocus: true,
    body: R.length ? `<p class="lead">Une de vos SMA est passée au-dessus du stop actuel, sous le cours. Choisissez la SMA de votre méthode : le stop n'est changé qu'après validation.</p>
      ${R.map(x => `<div class="sraise"><p><b>${esc(x.v.lot.ticker)}</b> · stop ${x.st > 0 ? usd(x.st) : 'aucun'}${x.px != null ? ` · cours ${usd(x.px)}` : ''}</p>${divNote(x.v.lot.ticker)}
        ${x.opts.map(o => `<div class="row"><span><span class="tf">${TF_SHORT[o.w.tf]} ${o.w.period}</span> ${usd(o.sma)} <small class="muted">+${usd(o.prot)} protégés</small></span><span class="row"><button class="btn sm primary" data-act="radar-stop" data-id="${o.w.id}">Mettre</button><button class="btn sm" data-act="stop-skip" data-k="${esc(`${x.v.lot.id}|${o.w.id}|${x.st}`)}">Ignorer</button></span></div>`).join('')}</div>`).join('')}
      <p class="hint">« Ignorer » masque la suggestion tant que le stop ne change pas (sur cet appareil).</p>`
      : '<p class="lead">Aucun stop à remonter pour l’instant.</p>' });
}

// Bilan par catégorie : espérance en R (gain net ÷ risque prévu) des positions clôturées.
let edgeDim = 'motif';
const EDGE_DIMS = [['motif', 'Motif'], ['sect', 'Secteur'], ['hold', 'Durée'], ['earn', 'Résultats'], ['mkt', 'Marché'], ['plan', 'Plan']];
function edgeKey(dim, c) {
  const l = c.lot;
  if (dim === 'motif') return l.motifSet ? MOTIFS[l.motif] || 'Non renseigné' : 'Non classé';
  if (dim === 'sect') return sectorOf(l.ticker) || 'Non classé';
  if (dim === 'hold') { const d = Core.days(l.date, c.date); return d <= 5 ? '5 jours ou moins' : d <= 20 ? '6 à 20 jours' : 'Plus de 20 jours'; }
  if (dim === 'earn') return !Earn.map[l.ticker] ? 'Calendrier inconnu' : Earn.map[l.ticker].some(([e]) => e >= l.date && e <= c.date) ? 'Résultats pendant la position' : 'Sans résultats';
  if (dim === 'mkt') return lightAt(l.date) ? lightAt(l.date) + ' à l’achat' : 'Historique indices manquant';
  return l.planOk === true ? 'Plan respecté' : l.planOk === false ? 'Plan non respecté' : 'Non renseigné';
}
// ----- Qualité des sorties (MAE / MFE) : clôtures journalières de l'historique du radar pendant chaque trade clôturé -----
// En R (1 R = risque prévu au plan), sur la quantité achetée. Clôtures seulement : pas les plus hauts et plus bas de séance.
let exitRadarAsked = false;
function exitNeedRadar() { if (S.watch.length && !Radar.loaded && !exitRadarAsked) { exitRadarAsked = true; loadRadarCache().then(() => render()); } }
function tickerBars(t) {
  const w = S.watch.find(x => x.ticker === t && !x.idx), h = w && histFixed(symOf(w), Radar.hist[symOf(w)]);
  return h && h.bars && h.bars.length ? h.bars : null;
}
// Meilleure SMA (de la position, ou toutes celles de l'action) sous le cours à la date d : stop qu'elle permettait.
function bestSma(lot, d, px) {
  const all = S.watch.filter(w => w.ticker === lot.ticker && !w.idx), mine = lot.smas && lot.smas.length ? all.filter(w => lot.smas.includes(smaKey(w))) : all;
  const bars = tickerBars(lot.ticker); if (!bars) return null;
  let best = null;
  for (const w of mine) {
    const c = []; let k0 = null;
    for (const [dd, x] of bars) { if (dd > d) break; const k = periodKey(w.tf, dd); if (k === k0) c[c.length - 1] = x; else { c.push(x); k0 = k; } }
    if (w.tf !== 'D') c.pop();   // bougie S ou M en cours : pas encore complétée
    if (c.length < w.period) continue;
    const sma = c.slice(-w.period).reduce((a, v) => a + v, 0) / w.period;
    if (sma < px && (!best || sma > best.sma)) best = { w, sma };
  }
  return best;
}
function exitStats(lot) {
  const ls = Core.lotState(lot), u = planR(lot); if (!ls.closed || !(u > 0)) return null;
  const all = tickerBars(lot.ticker); if (!all) return { none: true, R: ls.netRealized / u };
  const end = ls.closeDate, bars = all.filter(b => b[0] >= lot.date && b[0] <= end); if (!bars.length) return { none: true, R: ls.netRealized / u };
  const q = lot.qty, sells = lot.events.filter(e => e.type === 'sell'), sq = sells.reduce((a, e) => a + e.qty, 0);
  const exitPx = sq > 0 ? sells.reduce((a, e) => a + e.qty * e.price, 0) / sq : null;
  let hi = bars[0], lo = bars[0]; for (const b of bars) { if (b[1] > hi[1]) hi = b; if (b[1] < lo[1]) lo = b; }
  const R = ls.netRealized / u, mfe = Math.max(0, (hi[1] - lot.price) * q / u), mae = Math.min(0, (lo[1] - lot.price) * q / u);
  const after = all.filter(b => b[0] > end).slice(0, 10);
  const rebound = R < 0 && exitPx != null && after.length >= 5 && Math.max(...after.map(b => b[1])) >= exitPx + 2 * u / q;
  const sm = mfe > 0 ? bestSma(lot, hi[0], hi[1]) : null;
  const sma = sm && sm.sma > lot.price ? { w: sm.w, sma: sm.sma, r: (sm.sma - lot.price) * q / u, used: exitPx != null && exitPx >= sm.sma * 0.995 } : null;
  return { mfe, mae, R, given: Math.max(0, mfe - R), u, q, hi, lo, exitPx, rebound, afterN: after.length, sma, stopR: isNum(lot.stopInitial) ? (lot.stopInitial - lot.price) * q / u : -1 };
}
const fR = r => Math.abs(r) < 0.05 ? '0 R' : (r > 0 ? '+' : '−') + fmtNum(Math.abs(r), 1) + ' R';
function exitBlock(lot) {
  exitNeedRadar();
  const x = exitStats(lot); if (!x) return '';
  if (x.none) return `<p class="hint">Qualité de la sortie : ${esc(lot.ticker)} n’est pas au radar (ou historique en attente), le gain et le recul maximaux ne sont pas calculables.</p>`;
  const lo = Math.min(x.stopR, x.mae, x.R, -0.2), hi = Math.max(x.mfe, x.R, 0.5), pad = (hi - lo) * 0.06, X = r => ((r - lo + pad) / (hi - lo + 2 * pad) * 100).toFixed(1);
  const mk = (r, c, lab, top) => { const p = +X(r), al = p < 18 ? ' al' : p > 82 ? ' ar' : '';
    return `<b class="xm ${c}" style="left:${p}%"></b><span class="xt${top ? ' up' : ''}${al} ${c}" style="left:${p}%">${lab}</span>`; };
  return `<div class="xbox"><p class="chart-t" style="margin:0">Qualité de la sortie <small>· clôtures journalières</small></p>
    <div class="xrail"><i class="xz" style="left:${X(x.mae)}%;width:${(X(x.mfe) - X(x.mae)).toFixed(1)}%"></i>${mk(x.stopR, 'stop', 'stop ' + fR(x.stopR), false)}${mk(0, 'entry', 'achat', false)}${mk(x.R, 'out', 'sortie ' + fR(x.R), true)}${x.mfe > 0 ? mk(x.mfe, 'max', 'max ' + fR(x.mfe), true) : ''}</div>
    <dl class="kv">${kv('Gain maximal (MFE)', `${fR(x.mfe)} · ${usd(x.mfe * x.u, true)}`, `meilleure clôture : ${fmtDate(x.hi[0])} à ${usd(x.hi[1])}`, x.mfe > 0 ? 'pos' : '')}
      ${kv('Recul maximal (MAE)', `${fR(x.mae)} · ${usd(x.mae * x.u, true)}`, `pire clôture : ${fmtDate(x.lo[0])} à ${usd(x.lo[1])}`)}
      ${kv('Rendu', x.given > 0.05 ? `${fmtNum(x.given, 1)} R · ${usd(x.given * x.u)}` : 'Rien', 'du meilleur moment à la sortie', x.given >= 1 ? 'neg' : '')}
      ${x.sma ? kv('Votre SMA ce jour-là', x.sma.used ? 'Utilisée' : 'Non remontée', `SMA ${TF_SHORT[x.sma.w.tf]} ${x.sma.w.period} à ${usd(x.sma.sma)} le ${fmtDate(x.hi[0])} : stop possible à ${fR(x.sma.r)}`, x.sma.used ? '' : 'neg') : ''}
      ${x.rebound ? kv('Après la sortie', 'Reparti', 'plus de 2 R au-dessus du prix de sortie dans les 10 séances suivantes') : ''}</dl></div>`;
}
function exitCard() {
  exitNeedRadar();
  const st = S.lots.map(exitStats).filter(Boolean), ok = st.filter(x => !x.none);
  if (st.length < 3) return '';
  const avg = (a, f) => a.length ? a.reduce((t, x) => t + f(x), 0) / a.length : null;
  const losers = ok.filter(x => x.R < 0), wins = ok.filter(x => x.R > 0), beyond = st.filter(x => x.R < -1.2);
  const tile = (l, v, c) => `<div><small>${l}</small><b class="num ${c || ''}">${v}</b></div>`;
  return `<section class="card"><div class="sec-head"><h2>Qualité des sorties</h2><small>${ok.length} trade(s) analysé(s)${st.length > ok.length ? ` sur ${st.length}` : ''}</small></div>
    ${ok.length ? `<div class="btiles">${tile('Gain max. moyen', fR(avg(ok, x => x.mfe)), 'pos')}${tile('Gardé à la sortie', fR(avg(ok, x => x.R)), cls(avg(ok, x => x.R)))}${tile('Rendu en moyenne', fmtNum(avg(ok, x => x.given), 1) + ' R', 'neg')}</div>
    <dl class="kv">${kv('Allés à +1 R puis clôturés en perte', `${ok.filter(x => x.mfe >= 1 && x.R < 0).length} / ${ok.length}`, 'le stop n’avait pas été remonté assez haut', ok.some(x => x.mfe >= 1 && x.R < 0) ? 'neg' : '')}
      ${kv('Stoppés puis repartis', `${losers.filter(x => x.rebound).length} / ${losers.length}`, 'plus de 2 R au-dessus de la sortie dans les 10 séances suivantes')}
      ${wins.length ? kv('Recul max. moyen des gagnants', fR(avg(wins, x => x.mae)), 'avant de finir en gain') : ''}
      ${kv('Pertes au-delà du stop', beyond.length ? `${beyond.length} · pire ${fR(Math.min(...beyond.map(x => x.R)))}` : 'Aucune', 'perte de plus de 1,2 R : trou à l’ouverture ou sortie tardive', beyond.length ? 'neg' : '')}</dl>` : '<p class="hint">Historique du radar en attente pour ces actions.</p>'}
    <p class="hint">Clôtures journalières de l’historique du radar (pas les plus hauts et plus bas de séance), cours ajustés des dividendes.${st.length > ok.length ? ` ${st.length - ok.length} trade(s) sans historique : action absente du radar.` : ''} Détail dans chaque position clôturée du journal.</p></section>`;
}
function edgeCard() {
  const all = Core.tradeStats(S, planR).closed.filter(c => c.R != null);
  if (all.length < 3) return '';
  if (edgeDim === 'mkt' && S.watch.length && !Radar.loaded) loadRadarCache().then(() => { if (tab === 'dash') render(); });
  const g = {};
  for (const c of all) { const k = edgeKey(edgeDim, c); (g[k] = g[k] || []).push(c); }
  const rows = Object.entries(g).map(([k, cs]) => ({ k, n: cs.length, win: cs.filter(c => c.net > 0.0049).length / cs.length * 100, avg: cs.reduce((a, c) => a + c.R, 0) / cs.length, tot: cs.reduce((a, c) => a + c.R, 0) }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg);
  const m = Math.max(...rows.map(r => Math.abs(r.avg)), 0.5);
  const best = rows.filter(r => r.n >= 5).sort((a, b) => b.avg - a.avg)[0], worst = rows.filter(r => r.n >= 5).sort((a, b) => a.avg - b.avg)[0];
  return `<section class="card edge">
    <div class="sec-head"><h2>Ce qui marche pour vous <small>· ${all.length} trade(s)</small></h2>${edgeDim === 'motif' ? '<div class="row"><button class="btn sm" data-act="motif-sort">Classer</button><button class="btn sm" data-act="motif-list">Mes motifs</button></div>' : ''}</div>
    <div class="filters">${EDGE_DIMS.map(([k, l]) => `<button class="btn sm" data-act="edge-dim" data-f="${k}" aria-pressed="${edgeDim === k}">${l}</button>`).join('')}</div>
    <div class="erows">${rows.map(r => `<div class="erow${r.n < 5 ? ' few' : ''}"><span class="ek">${esc(r.k)} <small>${r.n} · ${fmtNum(r.win, 0)} % gagnants</small></span>
      <span class="ebar"><i class="${r.avg >= 0 ? 'p' : 'n'}" style="width:${(Math.abs(r.avg) / m * 50).toFixed(1)}%"></i></span>
      <b class="num ${cls(r.avg)}">${r.avg >= 0 ? '+' : ''}${fmtNum(r.avg, 2)} R</b></div>`).join('')}</div>
    ${best && worst && best.k !== worst.k ? `<p class="hint"><strong>${esc(best.k)}</strong> : ${best.avg >= 0 ? '+' : ''}${fmtNum(best.avg, 2)} R par trade, contre ${worst.avg >= 0 ? '+' : ''}${fmtNum(worst.avg, 2)} R pour <strong>${esc(worst.k)}</strong>.</p>` : ''}
    <p class="hint">R = gain net (frais et swap compris) ÷ risque prévu à l’achat. Une catégorie de moins de 5 trades est grisée : trop peu pour conclure.</p>
  </section>`;
}

// Swap CFD : coût par semaine (4 nuits simples + 1 triple = 7 nuits) et part du gain latent déjà mangée.
const swapWeek = (rem, px) => { const w = S.settings.swap || {}; return w.pct > 0 ? rem * px * w.pct / 100 / 360 * 7 : 0; };
const swapWarnPct = () => isNum(S.settings.swapWarn) ? S.settings.swapWarn : 30;

// Vérifications avant achat (calculateur) : ✓ favorable, ✕ défavorable, ? inconnu.
function preTradeChecks(ticker, risk, expo) {
  const t = String(ticker || '').trim().toUpperCase(); if (!t) return '';
  const items = [], add = (ok, label, detail) => items.push({ ok, label, detail });
  const L = marketLight();
  add(L ? (L.lvl === 'go' ? true : L.lvl === 'stop' ? false : null) : null, 'Marché au vert', L ? `${L.label} · ${L.up}/${L.n} de vos SMA d’indices au-dessus` : 'historique de SPY, QQQ et DIA en attente');
  const ws = S.watch.filter(w => w.ticker === t && !w.idx).map(w => ({ w, a: analyzeWatch(w) })).filter(x => x.a && !x.a.short);
  if (!ws.length) { add(null, 'Au-dessus de ses SMA', 'action absente du radar ou historique en attente'); add(null, 'Tendance alignée J, S et M', '—'); }
  else {
    const up = ws.filter(x => x.a.p > x.a.smaNow).length;
    add(up === ws.length, 'Au-dessus de ses SMA', `${up}/${ws.length} : ${ws.map(x => `${TF_SHORT[x.w.tf]} ${x.w.period} ${x.a.p > x.a.smaNow ? '↑' : '↓'}`).join(', ')}`);
    const tfs = ['D', 'W', 'M'].filter(tf => ws.some(x => x.w.tf === tf)), okTf = tfs.filter(tf => ws.filter(x => x.w.tf === tf).every(x => x.a.p > x.a.smaNow));
    add(tfs.length < 2 ? null : okTf.length === tfs.length, 'Tendance alignée J, S et M', tfs.length < 2 ? 'une seule unité suivie au radar' : tfs.map(tf => `${TF_SHORT[tf]} ${okTf.includes(tf) ? '✓' : '✕'}`).join(' · '));
  }
  const e = nextEarn(t), ed = e ? Core.days(todayISO(), e[0]) : null;
  add(e && ed <= 5 ? false : Earn.day ? true : null, 'Pas de résultats dans les 5 jours', e ? `résultats le ${fmtDate(e[0])}${EARN_H[e[1]] ? ' ' + EARN_H[e[1]] : ''}` : Earn.day ? 'aucune date annoncée' : 'calendrier en attente (clé Finnhub)');
  const s = sectorOf(t);
  if (!s) { if (quoteKey() && sectMissing(t) && !sectBusy) refreshSectors(t); add(null, 'Secteur pas surchargé', quoteKey() ? 'secteur en cours de recherche' : 'secteur inconnu'); }
  else {
    const B = sectorBook(), Lm = sectSet(), g = B.groups.find(x => x.s === s);
    const share = (B.tot + expo) > 0 ? ((g ? g.expo : 0) + expo) / (B.tot + expo) * 100 : 0, rp = B.eq > 0 ? ((g ? g.risk : 0) + risk) / B.eq * 100 : 0;
    const n = g ? g.list.filter(k => k.t !== t).length : 0;
    add(!((B.n >= 2 && share > Lm.expo) || rp > Lm.risk), 'Secteur pas surchargé', `${esc(s)} : ${n} autre(s) position(s) · après achat ${fmtNum(share, 0)} % de l’exposition, ${pct(rp)} de risque au stop`);
  }
  const others = [...new Set(S.lots.filter(l => !Core.lotState(l).closed && l.ticker !== t).map(l => l.ticker))];
  const cs = others.map(o => ({ o, c: corr(t, o) })).filter(x => x.c != null).sort((a, b) => b.c - a.c), lim = sectSet().corr;
  add(!others.length ? true : !cs.length ? null : cs[0].c < lim, 'Pas de doublon caché', !others.length ? 'aucune autre position' : !cs.length ? 'historique nécessaire (action au radar)' : cs[0].c >= lim ? `évolue comme ${cs.filter(x => x.c >= lim).slice(0, 3).map(x => `${esc(x.o)} (${fmtNum(x.c, 2)})`).join(', ')}` : `corrélation max. ${fmtNum(cs[0].c, 2)} avec ${esc(cs[0].o)}`);
  const known = items.filter(x => x.ok != null), good = known.filter(x => x.ok).length;
  return `<div class="checks ${known.length && good === known.length ? 'all' : ''}"><div class="sec-head"><h3>Vérifications avant achat</h3><b class="num">${good}/${known.length}</b></div>
    <ul>${items.map(x => `<li class="${x.ok === true ? 'ok' : x.ok === false ? 'bad' : 'unk'}"><i aria-hidden="true">${x.ok === true ? '✓' : x.ok === false ? '✕' : '?'}</i><span><strong>${x.label}</strong><small>${x.detail}</small></span></li>`).join('')}</ul>
    <p class="hint">Information seulement : la quantité reste calculée sur votre stop.</p></div>`;
}
// ----- Secteurs et diversification : information seulement, le calculateur n'en tient jamais compte -----
// Secteur Finnhub (finnhubIndustry) gardé sur l'appareil ; une correction à la main (S.settings.sectorFix) est synchronisée.
const SECT_KEY = 'carnet-positions:sectors';
const SECTORS = ['Technologie', 'Communication', 'Santé', 'Finance', 'Conso. cyclique', 'Conso. de base', 'Énergie', 'Industrie', 'Matériaux', 'Immobilier', 'Services publics'];
const SECT_COL = { 'Technologie': '#5B57D1', 'Communication': '#C2549A', 'Santé': '#1D9E75', 'Finance': '#2F7FD6', 'Conso. cyclique': '#D8632F', 'Conso. de base': '#B58A12',
  'Énergie': '#8A5A2B', 'Industrie': '#6F7E8F', 'Matériaux': '#4E9A3A', 'Immobilier': '#9B6BC9', 'Services publics': '#2A9AA6', 'Autre': '#9AA3AE', 'Non classé': '#C4CAD2' };
const IND_SECT = {
  'technology': 'Technologie', 'semiconductors': 'Technologie', 'communications': 'Technologie', 'electronic equipment': 'Technologie', 'it services': 'Technologie', 'software': 'Technologie',
  'media': 'Communication', 'telecommunication': 'Communication', 'entertainment': 'Communication',
  'health care': 'Santé', 'pharmaceuticals': 'Santé', 'biotechnology': 'Santé', 'life sciences tools & services': 'Santé',
  'banking': 'Finance', 'financial services': 'Finance', 'insurance': 'Finance', 'capital markets': 'Finance',
  'retail': 'Conso. cyclique', 'automobiles': 'Conso. cyclique', 'auto components': 'Conso. cyclique', 'hotels, restaurants & leisure': 'Conso. cyclique', 'hotels restaurants & leisure': 'Conso. cyclique',
  'textiles, apparel & luxury goods': 'Conso. cyclique', 'textiles apparel & luxury goods': 'Conso. cyclique', 'leisure products': 'Conso. cyclique', 'diversified consumer services': 'Conso. cyclique', 'distributors': 'Conso. cyclique',
  'beverages': 'Conso. de base', 'food products': 'Conso. de base', 'tobacco': 'Conso. de base', 'consumer products': 'Conso. de base',
  'energy': 'Énergie', 'oil & gas': 'Énergie',
  'aerospace & defense': 'Industrie', 'airlines': 'Industrie', 'machinery': 'Industrie', 'electrical equipment': 'Industrie', 'industrial conglomerates': 'Industrie', 'logistics & transportation': 'Industrie',
  'road & rail': 'Industrie', 'marine': 'Industrie', 'commercial services & supplies': 'Industrie', 'professional services': 'Industrie', 'construction': 'Industrie', 'building': 'Industrie',
  'trading companies & distributors': 'Industrie', 'transportation infrastructure': 'Industrie',
  'chemicals': 'Matériaux', 'metals & mining': 'Matériaux', 'packaging': 'Matériaux', 'paper & forest': 'Matériaux',
  'real estate': 'Immobilier', 'utilities': 'Services publics'
};
const IND_RE = [[/semicond|tech|software|electronic|internet/, 'Technologie'], [/media|telecom|entertain/, 'Communication'], [/health|pharm|biotech|medic|life science/, 'Santé'],
  [/bank|financ|insur|capital|credit/, 'Finance'], [/retail|auto|hotel|restaurant|leisure|apparel|luxury|consumer serv/, 'Conso. cyclique'], [/beverage|food|tobacco|consumer|household/, 'Conso. de base'],
  [/energy|oil|gas/, 'Énergie'], [/aero|defen|airline|machin|industr|logist|transport|rail|marine|construct|building|electrical/, 'Industrie'], [/chemi|metal|mining|packag|paper/, 'Matériaux'],
  [/real estate|reit/, 'Immobilier'], [/utilit/, 'Services publics']];
function mapIndustry(ind) {
  const k = String(ind || '').trim().toLowerCase();
  if (!k) return 'Autre';
  return IND_SECT[k] || (IND_RE.find(([re]) => re.test(k)) || [0, 'Autre'])[1];
}
const Sect = (() => { try { return JSON.parse(localStorage.getItem(SECT_KEY)) || {}; } catch (e) { return {}; } })();
const sectFix = () => S.settings.sectorFix || {};
const industryOf = t => (sectGet(String(t).toUpperCase()) || [''])[0];
// Secteurs : cache de l'appareil, complété par ceux trouvés sur vos autres appareils (S.settings.sect, synchronisé).
const sectGet = t => Sect[t] || (S.settings.sect || {})[t] || null;
function sectorOf(t) {
  t = String(t || '').toUpperCase();
  const x = sectGet(t);
  return sectFix()[t] || (x ? mapIndustry(x[0]) : null);
}
const sectMissing = t => { const x = sectGet(t); return !sectFix()[t] && (!x || (!x[0] && Core.days(x[1], todayISO()) > 30)); };
// Recopie dans les données synchronisées les secteurs connus de cet appareil (une fois par changement).
function sectShare() {
  const sh = S.settings.sect || {}, add = {};
  for (const t in Sect) if (Sect[t] && Sect[t][0] && !(sh[t] && sh[t][0] === Sect[t][0])) add[t] = Sect[t];
  if (!Object.keys(add).length) return false;
  S.settings.sect = Object.assign({}, sh, add); save(); return true;
}
let sectBusy = false;
// Une douzaine de profils par passage (positions d'abord) : la clé gratuite sert aussi aux cours en direct.
async function refreshSectors(only) {
  const key = quoteKey(); if (!key || sectBusy) return false;
  const openT = S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker);
  const want = only ? [String(only).toUpperCase()] : [...new Set([...openT, ...S.watch.filter(w => !w.sym && !w.idx).map(w => w.ticker)])];
  const todo = want.filter(sectMissing).slice(0, 12);
  if (!todo.length) { setTimeout(sectShare, 0); return false; }
  sectBusy = true; let got = 0;
  try {
    for (const t of todo) {
      if (got) await new Promise(r => setTimeout(r, 1100));
      const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(t)}&token=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (r.status === 401 || r.status === 429) break;
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      Sect[t] = [String((j && j.finnhubIndustry) || '').trim(), todayISO()]; got++;
    }
  } catch (e) { /* hors ligne : on réessaiera */ } finally { sectBusy = false; }
  if (got) {
    try { localStorage.setItem(SECT_KEY, JSON.stringify(Sect)); } catch (e) {}
    sectShare();
    if (tab === 'calc') updateCalc(); else if (tab === 'dash' || tab === 'radar') render();
  }
  return got > 0;
}
const sectSet = () => Object.assign({ expo: 30, risk: 3, corr: 0.8 }, S.settings.sectLim || {});
// Positions ouvertes rangées par secteur : exposition au cours actuel, et ce qui serait rendu si tous les stops sautaient (cours → stop, frais compris).
function sectorBook() {
  const eq = referenceCapital().acc.equity, by = {};
  let tot = 0, n = 0;
  for (const v of S.lots.map(lotView)) {
    if (v.ls.closed) continue;
    const t = v.lot.ticker, s = sectorOf(t) || 'Non classé', px = v.last ? v.last.price : v.lot.price, e = v.ls.rem * px;
    const risk = v.sa && !v.sa.missing && v.sa.pullback != null ? Math.max(0, v.sa.pullback) : null;
    const g = by[s] = by[s] || { s, expo: 0, risk: 0, noStop: 0, tickers: {} };
    const k = g.tickers[t] = g.tickers[t] || { t, expo: 0, risk: 0, noStop: false };
    g.expo += e; k.expo += e; tot += e;
    if (risk == null) { g.noStop++; k.noStop = true; } else { g.risk += risk; k.risk += risk; }
  }
  const groups = Object.values(by).sort((a, b) => b.expo - a.expo);
  for (const g of groups) { g.list = Object.values(g.tickers).sort((a, b) => b.expo - a.expo); n += g.list.length; }
  return { eq, tot, n, groups };
}
// Corrélation des variations journalières sur environ 3 mois (63 séances communes), avec l'historique du radar.
function histFor(t) {
  const w = S.watch.find(x => x.ticker === t), h = Radar.hist[w ? symOf(w) : t];
  return h && h.bars && h.bars.length > 45 ? h : null;
}
function corr(a, b) {
  const ha = histFor(a), hb = histFor(b); if (!ha || !hb) return null;
  const mb = new Map(hb.bars.slice(-120));
  const pts = ha.bars.slice(-120).filter(x => mb.has(x[0])).map(x => [x[1], mb.get(x[0])]).slice(-64);
  if (pts.length < 40) return null;
  const ra = [], rb = [];
  for (let i = 1; i < pts.length; i++) { ra.push(Math.log(pts[i][0] / pts[i - 1][0])); rb.push(Math.log(pts[i][1] / pts[i - 1][1])); }
  const m = x => x.reduce((s, v) => s + v, 0) / x.length, ma = m(ra), mbv = m(rb);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < ra.length; i++) { const da = ra[i] - ma, db = rb[i] - mbv; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
function corrPairs(tickers) {
  const T = [...new Set(tickers)], out = [];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) { const c = corr(T[i], T[j]); if (c != null) out.push({ a: T[i], b: T[j], c }); }
  return { pairs: out.sort((x, y) => y.c - x.c), missing: T.filter(t => !histFor(t)) };
}
let sectMode = 'E';
function sectorCard() {
  const B = sectorBook(); if (!B.n) return '';
  if (S.watch.length && !Radar.loaded) loadRadarCache().then(() => { if (tab === 'dash') render(); });
  const L = sectSet(), isE = sectMode === 'E', val = g => isE ? g.expo : g.risk, max = Math.max(...B.groups.map(val), 1e-9);
  const rows = B.groups.map(g => {
    const share = B.tot > 0 ? g.expo / B.tot * 100 : 0, rp = B.eq > 0 ? g.risk / B.eq * 100 : 0;
    const over = B.n >= 3 && (isE ? share > L.expo : rp > L.risk);
    return `<button type="button" class="srow${over ? ' over' : ''}" data-act="sect-detail" data-s="${esc(g.s)}">
      <span class="sn"><i style="background:${SECT_COL[g.s] || SECT_COL.Autre}"></i>${esc(g.s)} <small>${g.list.length} pos.</small></span>
      <span class="sbar"><i style="width:${(val(g) / max * 100).toFixed(1)}%;background:${SECT_COL[g.s] || SECT_COL.Autre}"></i></span>
      <span class="sv num">${isE ? `${usd(g.expo)} · ${fmtNum(share, 0)} %` : `${usd(-g.risk)} · ${pct(rp)}`}${!isE && g.noStop ? ' *' : ''}</span></button>`;
  }).join('');
  const warns = [];
  if (B.n >= 3) for (const g of B.groups) {
    const share = B.tot > 0 ? g.expo / B.tot * 100 : 0, rp = B.eq > 0 ? g.risk / B.eq * 100 : 0;
    if (share > L.expo) warns.push(`<strong>${esc(g.s)}</strong> : ${fmtNum(share, 0)} % de l’exposition (limite ${fmtNum(L.expo, 0)} %)`);
    if (rp > L.risk) warns.push(`<strong>${esc(g.s)}</strong> : ${pct(rp)} du capital rendu si ses ${g.list.length} stop(s) sautent ensemble (limite ${pct(L.risk)})`);
  }
  const C = corrPairs(B.groups.flatMap(g => g.list.map(k => k.t))), hi = C.pairs.filter(p => p.c >= L.corr);
  if (hi.length) warns.push(`${hi.length} paire(s) de positions évoluent presque pareil (corrélation ≥ ${fmtNum(L.corr, 2)}) : ${hi.slice(0, 3).map(p => `${esc(p.a)}·${esc(p.b)}`).join(', ')}${hi.length > 3 ? '…' : ''}`);
  const real = B.groups.filter(g => SECTORS.includes(g.s)).length, nc = B.groups.find(g => g.s === 'Non classé');
  const top = B.groups[0], second = B.groups[1];
  const pairRows = C.pairs.slice(0, 8).map(p => `<div class="cpair${p.c >= L.corr ? ' hi' : ''}"><span class="tk">${esc(p.a)} · ${esc(p.b)}</span><span class="sbar"><i style="width:${(Math.max(0, p.c) * 100).toFixed(0)}%"></i></span><b class="num">${fmtNum(p.c, 2)}</b></div>`).join('');
  return `<section class="card sect">
    <div class="sec-head"><h2>Diversification <small>· ${B.n} position(s)</small></h2><div class="row"><div class="seg" role="group" aria-label="Mesure"><button type="button" data-act="sect-mode" data-m="E" aria-pressed="${isE}">Exposition</button><button type="button" data-act="sect-mode" data-m="R" aria-pressed="${!isE}">Risque au stop</button></div><button class="btn sm" data-act="sect-set" aria-label="Réglages diversification">Réglages</button></div></div>
    <div class="srows">${rows}</div>
    ${warns.length ? `<div class="banner warn"><span>${warns.join('<br>')}</span></div>` : ''}
    <p class="hint">${real} secteur(s) sur ${SECTORS.length}${top && second && second.expo > 0 ? ` · le plus gros (${esc(top.s)}) pèse ${fmtNum(top.expo / second.expo, 1)} fois le suivant` : ''}.${isE ? '' : ' Risque : ce que vous rendriez entre le cours actuel et les stops, frais compris' + (B.groups.some(g => g.noStop) ? ' (* position sans stop, non comptée)' : '') + '.'}${nc ? ` Secteur en attente pour ${nc.list.map(k => esc(k.t)).join(', ')}${quoteKey() ? ' (récupéré automatiquement)' : ' : clé Finnhub nécessaire, ou touchez la ligne pour le choisir'}.` : ''}</p>
    ${C.pairs.length ? `<details class="more"><summary>Positions qui évoluent ensemble</summary><div class="cpairs">${pairRows}</div>
      <p class="hint">Corrélation des variations journalières sur 3 mois : 1 = elles bougent exactement pareil, 0 = aucun lien. Au-dessus de ${fmtNum(L.corr, 2)}, deux positions comptent presque comme une seule.${C.missing.length ? ` Sans historique (hors radar) : ${C.missing.map(esc).join(', ')}.` : ''}</p></details>`
      : C.missing.length && B.n > 1 ? `<p class="hint">Corrélations : historique du radar nécessaire pour ${C.missing.map(esc).join(', ')}.</p>` : ''}
  </section>`;
}
function sheetSector(s) {
  const B = sectorBook(), g = B.groups.find(x => x.s === s); if (!g) return;
  const rows = g.list.map(k => `<tr><td><b>${esc(k.t)}</b><br><small class="muted">${esc(industryOf(k.t) || '—')}${sectFix()[k.t] ? ' · choisi à la main' : ''}</small></td><td class="n">${usd(k.expo)}</td><td class="n">${k.noStop ? 'sans stop' : usd(-k.risk)}</td><td><button type="button" class="btn sm" data-act="sect-fix" data-t="${esc(k.t)}">Changer</button></td></tr>`).join('');
  openSheet({ title: s, noFocus: true,
    body: `<p class="lead">${usd(g.expo)} d’exposition (${fmtNum(B.tot > 0 ? g.expo / B.tot * 100 : 0, 0)} %) · ${usd(-g.risk)} si tous les stops sautent (${pct(B.eq > 0 ? g.risk / B.eq * 100 : 0)} du capital).</p>
      <div class="tbl"><table><thead><tr><th>Position</th><th class="n">Exposition</th><th class="n">Au stop</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Secteur fourni par Finnhub, regroupé en ${SECTORS.length} grands secteurs. « Changer » pour le corriger : le choix est synchronisé entre vos appareils.</p>` });
}
function sheetSectorFix(t) {
  const cur = sectFix()[t] || '', ind = industryOf(t);
  openSheet({ title: 'Secteur de ' + t, ok: 'Enregistrer',
    body: `<div class="fields"><div class="fld wide"><label for="f-sec">Secteur</label><select id="f-sec" name="sec">
      <option value="" ${cur ? '' : 'selected'}>Automatique${ind ? ` (Finnhub : ${esc(ind)} → ${esc(mapIndustry(ind))})` : ''}</option>
      ${SECTORS.map(x => `<option ${cur === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option ${cur === 'Autre' ? 'selected' : ''}>Autre</option></select></div></div>`,
    onSubmit: form => {
      const v = F(form, 'sec'), m = Object.assign({}, sectFix());
      if (v) m[t] = v; else delete m[t];
      S.settings.sectorFix = m;
      save(`${t} : ${v || 'secteur automatique'}`);
    } });
}
// ----- Risque du portefeuille : tous les stops ensemble, la marge, le nombre de positions -----
// Information seulement : les limites ne bloquent rien et ne changent pas la taille calculée sur le stop.
const riskLim = () => Object.assign({ heat: null, margin: null, pos: null }, S.settings.riskLim || {});
const riskPushOpt = () => Object.assign({ level: true, back: false }, S.settings.riskPush || {});
function portfolioRisk(addRisk = 0, addMargin = 0, addPos = 0) {
  const ref = referenceCapital(), eq = ref.value, acc = ref.acc, today = todayISO();
  const { heat, by, noStop, expo, locked, lots, pos } = Core.riskSummary(S, fees());   // même calcul que la notification du robot
  const soon = Object.keys(by).filter(t => { const e = nextEarn(t); return e && Core.days(today, e[0]) <= 7; }).sort((a, b) => by[b] - by[a]);
  const h = heat + addRisk, m = acc.margin + addMargin;
  return { eq, heat: h, heatPct: eq > 0 ? h / eq * 100 : null, margin: m, marginPct: eq > 0 ? m / eq * 100 : null, level: m > 0 ? eq / m * 100 : null,
    pos: pos + addPos, lots, noStop, locked, expo, drop5: expo * 0.05,
    soon, soonRisk: soon.reduce((a, t) => a + by[t], 0), top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5) };
}
function riskCard() {
  const P = portfolioRisk(); if (!P.lots || P.heatPct == null) return '';
  const L = riskLim(), over = [], none = L.heat == null && L.margin == null && L.pos == null;
  const meter = (label, valTxt, val, lim, limTxt, scale, sub, cls) => {
    const o = lim != null && val > lim; if (o) over.push(label);
    const w = scale > 0 ? Math.min(100, val / scale * 100) : 0;
    return `<div class="rmeter${o ? ' over' : ''}"><div class="rmrow"><span>${label}</span><b class="num">${valTxt}</b></div>
      ${scale > 0 ? `<div class="rmtrack"><i class="${o ? 'over' : cls || ''}" style="width:${w.toFixed(1)}%"></i>${lim != null ? `<span class="rmlim" style="left:${Math.min(100, lim / scale * 100).toFixed(1)}%"></span>` : ''}</div>` : ''}
      <div class="rmsub"><span>${sub}</span><span>${lim != null ? 'votre limite ' + limTxt : 'pas de limite'}</span></div></div>`;
  };
  const m1 = meter('Perte si tous les stops sautent', `${usd(P.heat)} · ${pct(P.heatPct)}`, P.heatPct, L.heat, L.heat != null ? pct(L.heat) : '', Math.max(L.heat != null ? L.heat * 3 : 0, P.heatPct * 1.1, 10), `du capital (${usd(P.eq)}), cours → stop, frais compris`);
  const m2 = meter('Marge utilisée', `${usd(P.margin)} · ${fmtNum(P.marginPct, 0)} %`, P.marginPct, L.margin, L.margin != null ? fmtNum(L.margin, 0) + ' %' : '', 100, `de la valeur nette${P.level != null ? ` · niveau de marge ${fmtNum(P.level, 0)} %` : ''}`);
  const m3 = meter('Positions ouvertes', String(P.pos), P.pos, L.pos, L.pos != null ? String(L.pos) : '', L.pos != null ? Math.max(L.pos * 1.5, P.pos) : 0, `${P.locked} stop(s) déjà au-dessus de l’achat`, 'mut');
  return `<section class="card rcard">
    <div class="sec-head"><h2>Risque du portefeuille</h2><div class="row">${over.length ? `<span class="pill loss">${over.length} limite${over.length > 1 ? 's' : ''} dépassée${over.length > 1 ? 's' : ''}</span>` : ''}<button class="btn sm" data-act="risk-set">Limites</button></div></div>
    ${m1}${m2}${m3}
    <dl class="kv" style="margin-top:6px">
      ${kv('Marché −5 % d’un coup', usd(-P.drop5), `${pct(P.eq > 0 ? P.drop5 / P.eq * 100 : 0)} du capital · sur ${usd(P.expo)} d’exposition, avant le déclenchement des stops`, 'neg')}
      ${kv('Résultats d’ici 7 jours', P.soon.length ? `${P.soon.length} position(s) · ${usd(-P.soonRisk)}` : 'Aucune', P.soon.length ? esc(P.soon.join(', ')) + ' : le cours peut ouvrir sous le stop' : 'parmi les positions ouvertes (calendrier Finnhub)', P.soon.length ? 'neg' : '')}
      ${P.noStop ? kv('Sans stop', `${P.noStop} position(s)`, 'non comptées dans la perte au stop : risque non borné', 'neg') : ''}
    </dl>
    ${P.top.length ? `<p class="chart-t" style="margin-top:10px">Plus gros risques au stop</p><div class="rtop">${P.top.map(([t, r]) => `<div><span class="tk">${esc(t)}</span><span class="num">${usd(-r)} · ${pct(P.eq > 0 ? r / P.eq * 100 : 0)}</span></div>`).join('')}</div>` : ''}
    ${none ? '<p class="hint">Aucune limite fixée : touchez « Limites » pour être alerté ici et dans le calculateur.</p>' : ''}
  </section>`;
}
// Calculateur : risque total et marge après ce trade. Information seulement, la taille reste celle du stop.
function riskCalcHint(ticker, risk, margin) {
  const t = String(ticker || '').trim().toUpperCase(), isNew = !S.lots.some(l => l.ticker === t && !Core.lotState(l).closed);
  const P = portfolioRisk(risk, margin, t && isNew ? 1 : 0), L = riskLim(); if (P.heatPct == null) return '';
  const hO = L.heat != null && P.heatPct > L.heat, mO = L.margin != null && P.marginPct > L.margin, pO = L.pos != null && P.pos > L.pos;
  return `<div class="banner ${hO || mO || pO ? 'warn' : 'info'}"><span>Avec ce trade : perte si tous les stops sautent <strong class="num">${usd(P.heat)}</strong>, soit ${pct(P.heatPct)} du capital${L.heat != null ? ` (votre limite ${pct(L.heat)})` : ''} ; marge ${fmtNum(P.marginPct, 0)} % de la valeur nette${L.margin != null ? ` (limite ${fmtNum(L.margin, 0)} %)` : ''}${L.pos != null ? ` ; ${P.pos} position(s) (limite ${L.pos})` : ''}. La taille reste calculée sur votre stop.</span></div>`;
}
function sheetRiskLim() {
  const L = riskLim(), v = x => x == null ? '' : x;
  openSheet({ title: 'Limites de risque', ok: 'Enregistrer',
    body: `<p class="lead">Vos limites pour l’ensemble du portefeuille. Elles ne bloquent rien et ne changent pas le calculateur : elles colorent le panneau et ajoutent un avertissement sous le résultat du calculateur.</p>
      <div class="fields">${dec('heat', 'Perte max. si tous les stops sautent (% du capital)', v(L.heat), 'placeholder="aucune"')}${dec('margin', 'Marge utilisée max. (% de la valeur nette)', v(L.margin), 'placeholder="aucune"')}${dec('pos', 'Positions ouvertes max.', v(L.pos), 'inputmode="numeric" placeholder="aucune"')}</div>
      <p class="hint">Case vide : pas de limite, les chiffres restent affichés.</p>
      <label class="check" style="margin-top:10px"><input type="checkbox" name="pushRisk" ${S.settings.pushRisk !== false ? 'checked' : ''}> M’envoyer une notification quand une limite est dépassée</label>
      <p class="hint" style="margin:2px 0 0 26px">Le robot vérifie chaque soir sur la clôture, avec le même calcul que ce panneau. Une seule notification, puis plus rien tant que ça reste dépassé.</p>
      <label class="check" style="margin-top:8px"><input type="checkbox" name="riskLevel" ${riskPushOpt().level ? 'checked' : ''}> Compter aussi le niveau de marge (alerte sous ${fmtNum(S.settings.marginMin || 150, 0)} %, réglé dans Réglages)</label>
      <label class="check" style="margin-top:8px"><input type="checkbox" name="riskBack" ${riskPushOpt().back ? 'checked' : ''}> Prévenir aussi quand tout redevient normal</label>`,
    onSubmit: form => {
      const g = k => { const x = F(form, k).trim(); return x === '' ? null : num(x); };
      S.settings.pushRisk = !!form.elements.pushRisk.checked;
      S.settings.riskPush = { level: !!form.elements.riskLevel.checked, back: !!form.elements.riskBack.checked };
      const h = g('heat'), m = g('margin'), p = g('pos');
      need(h == null || (h > 0 && h <= 100), 'Perte max. entre 0 et 100 %.'); need(m == null || (m > 0 && m <= 100), 'Marge max. entre 0 et 100 %.');
      need(p == null || (p >= 1 && Number.isInteger(p)), 'Nombre de positions entier, 1 ou plus.');
      S.settings.riskLim = { heat: h, margin: m, pos: p };
      save('Limites de risque enregistrées');
    } });
}
function sheetSectSet() {
  const L = sectSet();
  openSheet({ title: 'Seuils d’alerte', ok: 'Enregistrer',
    body: `<p class="lead">Seuils d’alerte, pour information : ils ne bloquent rien et ne changent pas le calculateur.</p>
      <div class="fields">${dec('expo', 'Exposition max. par secteur (%)', L.expo)}${dec('risk', 'Risque au stop max. par secteur (% du capital)', L.risk)}${dec('corr', 'Corrélation jugée forte (0 à 1)', L.corr)}${dec('swapw', 'Alerte swap (% du gain latent)', swapWarnPct())}</div>`,
    onSubmit: form => {
      const e = num(F(form, 'expo')), r = num(F(form, 'risk')), c = num(F(form, 'corr'));
      need(e > 0 && e <= 100, 'Exposition entre 0 et 100 %.'); need(r > 0 && r <= 50, 'Risque entre 0 et 50 %.'); need(c > 0 && c < 1, 'Corrélation entre 0 et 1.');
      const sw = num(F(form, 'swapw')); need(sw > 0 && sw <= 100, 'Alerte swap entre 0 et 100 %.');
      S.settings.sectLim = { expo: e, risk: r, corr: c }; S.settings.swapWarn = sw;
      save('Seuils de diversification enregistrés');
    } });
}
// Calculateur : rappel du secteur et des positions liées, sous le résultat. La quantité reste celle calculée sur le stop.
function sectorCalcHint(ticker, risk, expo) {
  const t = String(ticker || '').trim().toUpperCase(); if (!t) return '';
  const s = sectorOf(t);
  if (!s) { if (quoteKey() && sectMissing(t) && !sectBusy) refreshSectors(t); return quoteKey() ? '<p class="hint">Secteur : recherche en cours…</p>' : ''; }
  const B = sectorBook(), L = sectSet(), g = B.groups.find(x => x.s === s);
  const n = g ? g.list.filter(k => k.t !== t).length : 0, has = g && g.list.some(k => k.t === t);
  const share = (B.tot + expo) > 0 ? ((g ? g.expo : 0) + expo) / (B.tot + expo) * 100 : 0, rp = B.eq > 0 ? ((g ? g.risk : 0) + risk) / B.eq * 100 : 0;
  const others = B.groups.flatMap(x => x.list.map(k => k.t)).filter(x => x !== t);
  const links = others.map(o => ({ o, c: corr(t, o) })).filter(x => x.c != null && x.c >= L.corr).sort((a, b) => b.c - a.c);
  const warn = (B.n >= 2 && share > L.expo) || rp > L.risk || links.length;
  return `<div class="banner ${warn ? 'warn' : 'info'}"><span>Secteur <strong>${esc(s)}</strong> : ${n ? `déjà ${n} position(s)${has ? ` (et ${esc(t)} lui-même)` : ''}, ${usd(g.expo)} d’exposition, ${pct(B.eq > 0 ? g.risk / B.eq * 100 : 0)} de risque au stop` : has ? `${esc(t)} est déjà en position` : 'aucune position pour l’instant'}. Avec cet achat : ${fmtNum(share, 0)} % de l’exposition, ${pct(rp)} de risque au stop dans ce secteur.${links.length ? `<br>Évolue comme ${links.slice(0, 3).map(x => `${esc(x.o)} (${fmtNum(x.c, 2)})`).join(', ')} sur 3 mois.` : ''}<br><small>Information seulement : la quantité reste calculée sur votre stop.</small></span></div>`;
}
// ----- Marché US : S&P 500, Nasdaq 100 et Dow Jones via leurs ETF (indices payants chez Finnhub et Twelve Data) -----
// Leurs SMA vivent dans S.watch (idx: true) pour l'historique, le robot et les alertes, mais restent hors des cartes du radar.
const IDX = [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow Jones']];
const IDX_DEF = 'SPY J 200 J 233 S 21 S 55 M 8\nQQQ J 89 J 233 S 13 S 89 M 5 M 21\nDIA J 50 S 55 M 13';
const TF_ORD = { D: 0, W: 1, M: 2 };
const idxWatch = t => S.watch.filter(w => w.idx && w.ticker === t).sort((x, y) => TF_ORD[x.tf] - TF_ORD[y.tf] || y.period - x.period);
const idxText = () => IDX.map(([t]) => idxWatch(t)).filter(ws => ws.length).map(ws => ws[0].ticker + ' ' + ws.map(w => TF_SHORT[w.tf] + ' ' + w.period).join(' ')).join('\n');
function setIdx(text) {
  const { rows, bad } = parseSmaList(text), known = new Set(IDX.map(x => x[0]));
  const keep = S.watch.filter(w => w.idx), out = [];
  for (const { t, pairs } of rows) {
    if (!known.has(t)) { bad.push(t); continue; }
    for (const [tf, n] of pairs) if (!out.some(w => w.ticker === t && w.tf === tf && w.period === n)) out.push(keep.find(w => w.ticker === t && w.tf === tf && w.period === n) || { id: `idx-${t}-${tf}${n}`, ticker: t, period: n, tf, sym: '', note: '', idx: true });  // id fixe : pas de doublon entre appareils
  }
  S.watch = S.watch.filter(w => !w.idx).concat(out);
  return bad;
}
function migrateIdx() {
  if (S.settings.idxV >= 1) return;
  if (!S.watch.some(w => w.idx)) setIdx(IDX_DEF);
  S.settings.idxV = 1;
}
// Variation du jour : celle de Finnhub en direct, sinon les deux dernières clôtures de l'historique.
function idxDay(t) {
  const L = Live.prices[t];
  if (L && isNum(L.dp)) return L.dp;
  const h = Radar.hist[t], b = h && h.bars;
  return b && b.length > 1 ? (b[b.length - 1][1] / b[b.length - 2][1] - 1) * 100 : null;
}
const idxSide = a => !a || a.short ? '' : a.p > a.smaNow ? 'up' : 'down';
function marketCard() {
  if (!Radar.loaded && S.watch.length) loadRadarCache().then(() => { if (tab === 'dash') render(); });
  const tiles = IDX.map(([t, name]) => {
    const ws = idxWatch(t); if (!ws.length) return '';
    const as = ws.map(w => ({ w, a: analyzeWatch(w) })), ok = as.filter(x => idxSide(x.a));
    const up = ok.filter(x => idxSide(x.a) === 'up').length, dp = idxDay(t);
    const chips = as.map(({ w, a }) => `<i class="${idxSide(a)}">${TF_SHORT[w.tf]}${w.period}</i>`).join('');
    return `<button type="button" class="itile" data-act="idx-detail" data-t="${t}"><span>${name} <small>${t}</small></span>
      <b class="num ${dp == null ? '' : cls(dp)}">${dp == null ? '—' : pct(dp, true)}</b>
      <span class="ichips">${chips}</span><small>${ok.length ? `${up}/${ok.length} au-dessus` : 'historique en attente'}</small></button>`;
  }).join('');
  if (!tiles) return '';
  const live = IDX.some(([t]) => Live.prices[t]) && marketOpen(Date.now());
  return `<section class="card mkt"><div class="sec-head"><h2>Marché US <small>· ${live ? 'en direct' : 'dernière séance'}</small></h2><button class="btn sm" data-act="idx-edit">SMA</button></div>
    <div class="itiles">${tiles}</div>
    ${feuLine(marketLight())}
    <p class="hint" style="margin:6px 0 0">Via les ETF SPY, QQQ et DIA. Vert : cours au-dessus de la SMA, rouge : en dessous. Touchez un indice pour le détail.</p></section>`;
}
function sheetIdxDetail(t) {
  const name = (IDX.find(x => x[0] === t) || [t, t])[1], dd = d => fmtDate(d).replace(/ \d{4}$/, '');
  const rows = idxWatch(t).map(w => { const a = analyzeWatch(w), ok = a && !a.short;
    return `<tr><td>${TF_SHORT[w.tf]} ${w.period}</td><td class="n">${ok ? usd(a.smaNow) : '—'}</td><td class="n ${ok ? cls(a.dist) : ''}">${ok ? pct(a.dist, true) : a && a.short ? 'historique court' : 'en attente'}</td><td>${ok && a.lastCross ? `${a.lastCross.dir === 'up' ? '↑' : '↓'} ${dd(a.lastCross.date)}` : ''}</td></tr>`; }).join('');
  const a0 = idxWatch(t).map(analyzeWatch).find(a => a && !a.short), dp = idxDay(t);
  openSheet({ title: `${name} · ${t}`, noFocus: true,
    body: `<p class="lead">${a0 ? `Cours ${usd(a0.p)} <small class="muted">(${a0.src})</small>` : ''}${dp == null ? '' : ` · jour <span class="${cls(dp)}">${pct(dp, true)}</span>`}</p>
      <div class="tbl"><table><thead><tr><th>SMA</th><th class="n">Valeur</th><th class="n">Écart</th><th>Dernier croisement</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Mêmes calculs que le radar (cours ${adjMode() === 'all' ? 'ajustés des dividendes' : 'non ajustés'}). Les croisements apparaissent aussi dans les alertes.</p>` });
}
function sheetIdxEdit() {
  openSheet({ title: 'SMA des indices', ok: 'Enregistrer',
    body: `<p class="lead">Une ligne par ETF (SPY, QQQ, DIA), comme pour l’import du radar.</p>
      <div class="fields"><div class="fld wide"><label for="f-idx">SMA suivies</label><textarea id="f-idx" name="idx" rows="4" autocapitalize="characters">${esc(idxText())}</textarea></div></div>`,
    onSubmit: form => {
      const bad = setIdx(F(form, 'idx'));
      save('SMA des indices enregistrées' + (bad.length ? ' · ignoré : ' + bad.slice(0, 4).join(' | ') : ''));
      refreshRadar();
    } });
}
function viewDash() {
  const ref = referenceCapital(), acc = ref.acc, lb = latestBroker(), P = perf(), T = Core.tradeStats(S, planR);
  let gap = '';
  if (lb) {
    const atDate = Core.accountState(S, lb.date, 'last');
    const appV = atDate.equity;
    gap = appV == null
      ? `Écart non calculable : cours manquants au ${fmtDate(lb.date)}.`
      : `Écart avec le calcul à cette date : <span class="${cls(lb.netValue - appV)}">${usd(lb.netValue - appV, true)}</span> (courtier − application).`;
  }
  const lev = acc.equity > 0 ? acc.exposure / acc.equity : null;
  const invested = S.settings.initialCapital + acc.deposits - acc.withdrawals;
  const gain = acc.equity - invested, gainPct = invested > 0 ? gain / invested * 100 : null;
  const mUse = acc.equity > 0 ? acc.margin / acc.equity * 100 : null;
  const mCls = mUse == null ? '' : mUse >= 80 ? 'hi' : mUse >= 50 ? 'mid' : '';
  const hc = x => !isNum(x) || Math.abs(x) < 0.005 ? '' : x > 0 ? 'up' : 'down';
  // Courbe de la période choisie, repartant de 0 % au début de la période.
  const sel = P[perfRange] || P.itd, rangePts = !sel ? P.pts : P.pts.filter(p => p.date >= sel.from && p.date <= sel.to).map((p, i, a) => Object.assign({}, p, { index: p.index / a[0].index }));
  const DD = Core.maxDrawdown(rangePts), BM = benchBlock(P, sel, rangePts);
  const perfTile = (k, l, sub, p) => `<button type="button" class="ptile" data-act="perf-range" data-f="${k}" aria-pressed="${perfRange === k}"><span>${l}</span><b class="${p ? cls(p.r) : ''}">${p ? pct(p.r, true) : '—'}</b><small>${p ? perfSub(k, p) + (p.est ? ' · estimé' : '') : sub}</small></button>`;
  const method = P.estCount ? `Rendement pondéré dans le temps, ${P.estCount} sous-période(s) estimée(s) par Modified Dietz faute de valorisation à la date d’un flux.` : 'Rendement pondéré dans le temps (valorisations disponibles autour de chaque flux).';
  const tn = tonightCard();
  return `${demoBanner()}
  ${tn}
  ${alertsStrip(!!tn)}
  ${mt5Remind()}
  ${healthBanner()}
  ${earnCard()}
  ${liveBar()}
  ${marketCard()}
  <div class="hero-card">
    <div class="row" style="justify-content:space-between"><span class="lbl">Valeur nette du compte</span><small>${ref.label} · cours au ${fmtDate(acc.openCount ? acc.minPriceDate : todayISO())}</small></div>
    <div><div class="big">${usd(acc.equity)}</div>
      <div class="row" style="margin-top:8px"><span class="chg ${hc(gain)}">${usd(gain, true)}${gainPct == null ? '' : ' · ' + pct(gainPct, true)}</span><small>par rapport à ${usd(invested)} apportés</small></div></div>
    <dl class="hero-stats" style="margin:0">
      <div><dt>Latent</dt><dd class="${hc(acc.unreal)}">${usd(acc.unreal, true)}</dd></div>
      <div><dt>Réalisé net</dt><dd class="${hc(acc.realized)}">${usd(acc.realized, true)}</dd></div>
      <div><dt>Exposition</dt><dd>${usd(acc.exposure)}</dd></div>
      <div><dt>Levier effectif</dt><dd>${lev == null ? '—' : '×' + fmtNum(lev, 2)}</dd></div>
    </dl>
    ${mUse != null && acc.margin > 0 ? `<div class="gauge"><div class="row"><span>Marge estimée utilisée : <strong style="color:var(--hero-ink)">${usd(acc.margin)}</strong></span><span>${fmtNum(mUse, 0)} % de la valeur nette</span></div><div class="track"><i class="${mCls}" style="width:${Math.min(100, mUse).toFixed(1)}%"></i></div></div>` : ''}
  </div>
  ${ref.stale ? `<div class="banner warn"><span>Valorisation datée de ${ref.age} jours (${fmtDate(ref.date)}). Mettez à jour les cours ou saisissez la valeur du courtier.</span><button class="btn sm" data-act="prices">Mettre à jour</button></div>` : ''}
  ${riskCard()}
  ${acctCard(ref)}
  ${sectorCard()}
  ${lb ? `<div class="banner info"><span>Courtier au ${fmtDate(lb.date)} : <strong class="num">${usd(lb.netValue)}</strong>${isNum(lb.marginAvail) ? `, marge disponible <span class="num">${usd(lb.marginAvail)}</span>` : ''}. ${gap}</span></div>` : ''}
  <section class="card">
    <div class="sec-head"><h2>Performance <small>· ${PERIODS.find(x => x[0] === perfRange)[2]}</small></h2>${P[perfRange] ? `<strong class="num ${cls(P[perfRange].r)}" style="font-size:1.2rem">${pct(P[perfRange].r, true)}</strong>` : ''}</div>
    <p class="hint" style="margin:0 0 8px">Touchez une période pour afficher sa courbe. Rendement du compte hors dépôts et retraits ; le « +x % » de la valeur nette, lui, compare à la somme apportée.</p>
    <div class="ptiles" role="group" aria-label="Période">${PERIODS.map(([k, l, sub]) => perfTile(k, l, sub, P[k])).join('')}${acctTile(ref)}</div>
    ${P.broken ? `<div class="banner err">Courbe interrompue au ${fmtDate(P.brokenAt)} : valeur de départ nulle ou négative.</div>` : ''}
    ${perfWhy(P)}
    ${BM.tiles}
    ${rangePts.length > 1 ? `<p class="chart-t">${PERIODS.find(x => x[0] === perfRange)[1]} : ${fmtDate(rangePts[0].date)} → ${fmtDate(rangePts[rangePts.length - 1].date)}</p>` : ''}
    ${chartSVG(rangePts, BM.at)}
    <dl class="kv" style="margin-top:10px">${BM.kv}${kv('Drawdown maximal', DD ? `<span class="${cls(DD.dd)}">${pct(DD.dd)}</span>` : 'Non calculable', DD && DD.dd < 0 ? `${fmtDate(DD.peak)} → ${fmtDate(DD.trough)}` : 'sur la période affichée')}</dl>
    <details class="more"><summary>Comment c’est calculé</summary>
    <p class="hint">${method} Un dépôt n’est jamais compté comme un gain, un retrait jamais comme une perte. ${P.freq ? `${P.freq.count} observations, écart médian ${fmtNum(P.freq.medianGap, 1)} jour(s), écart maximal ${P.freq.maxGap} jours. Les baisses survenues entre deux observations (intrajournalières notamment) ne sont pas mesurées.` : ''}
    Une observation existe quand toutes les positions ouvertes ont un cours saisi le même jour, quand aucune position n’est ouverte, ou quand vous saisissez la valeur du courtier. ● calcul exact, ○ sous-période estimée, ● orange : valeur courtier.</p></details>
  </section>
  ${closedCard()}
  ${disciplineCard(T)}
  ${edgeCard()}
  ${exitCard()}
  <section class="card">
    <details class="more"><summary>Détail du calcul de la valeur nette</summary>
    <dl class="kv">
      ${kv('Capital initial', usd(S.settings.initialCapital), fmtDate(S.settings.startDate))}
      ${kv('Versements cumulés', usd(acc.deposits))}
      ${kv('Retraits cumulés', usd(acc.withdrawals))}
      ${kv('Résultat réalisé net', usd(acc.realized, true), acc.catchup ? `après tous les frais payés, dont rattrapage ${usd(acc.catchup, true)}` : 'après tous les frais payés', cls(acc.realized))}
      ${kv('Résultat latent', usd(acc.unreal, true), 'avant frais de sortie', cls(acc.unreal))}
      ${kv('Frais de transaction', usd(acc.txFees))}
      ${kv('Frais de financement', usd(acc.funding))}
      ${kv('Dividendes et ajustements', usd(acc.divs, true))}
      ${kv('Marge estimée utilisée', usd(acc.margin), 'exposition ÷ levier, indicatif')}
      ${kv('Marge disponible saisie', lb && isNum(lb.marginAvail) ? usd(lb.marginAvail) : 'Non saisie', lb && isNum(lb.marginAvail) ? fmtDate(lb.date) : 'Réglages › Valeurs courtier')}
    </dl></details>
  </section>`;
}
// Bilan du compte courtier depuis son ouverture, période d'avant le carnet comprise (relevé du courtier : dépôts et retraits cumulés).
// Résultat total = valeur actuelle − dépôts nets. Il se partage entre l'avant-carnet et le carnet, dont l'apport est capital initial + versements saisis.
function acctBalance(ref) {
  const a = S.settings.acct;
  if (!a || !(a.deposits > 0)) return null;
  const ext = S.flows.filter(f => f.kind !== 'pnl');   // un rattrapage est du résultat, pas un dépôt
  const later = ext.filter(f => f.date > a.at).reduce((x, f) => x + f.amount, 0);
  const net = a.deposits - (a.withdrawals || 0) + later;
  const carnetIn = S.settings.initialCapital + ext.reduce((x, f) => x + f.amount, 0);
  const total = ref.value - net;
  return { a, later, net, total, totalPct: net > 0 ? total / net * 100 : null, carnet: ref.value - carnetIn, before: carnetIn - net };
}
// Tuile « Compte entier » : résultat en dollars depuis l'ouverture rapporté aux dépôts nets (pas de courbe, faute d'historique avant le carnet).
function acctTile(ref) {
  const B = acctBalance(ref);
  if (!B) return `<button type="button" class="ptile whole" data-act="acct"><span>Compte entier</span><b>—</b><small>Saisir le relevé MT5</small></button>`;
  return `<div class="ptile whole" title="Valeur actuelle − dépôts nets, depuis l’ouverture du compte"><span>Compte entier</span><b class="${cls(B.total)}">${B.totalPct == null ? '—' : pct(B.totalPct, true)}</b><small>${B.a.since ? 'depuis ' + esc(B.a.since) : 'depuis l’ouverture'} · ${usd(B.total, true)}</small></div>`;
}
function acctCard(ref) {
  const B = acctBalance(ref);
  if (!B) return '';
  const { a } = B;
  return `<section class="card">
    <div class="sec-head"><h2>Depuis l’ouverture du compte${a.since ? ` <small>· ${esc(a.since)}</small>` : ''}</h2><strong class="num ${cls(B.total)}" style="font-size:1.2rem">${usd(B.total, true)}</strong></div>
    <dl class="kv">
      ${kv('Dépôts nets', usd(B.net), `${usd(a.deposits)} déposés${a.withdrawals ? ` − ${usd(a.withdrawals)} retirés` : ''} au relevé du ${fmtDate(a.at)}${Math.abs(B.later) >= 0.005 ? `, ${usd(B.later, true)} saisis depuis` : ''}`)}
      ${kv('Valeur actuelle', usd(ref.value), ref.label)}
      ${kv('Résultat total', `${usd(B.total, true)}${B.totalPct == null ? '' : ' · ' + pct(B.totalPct, true)}`, 'en dollars, dépôts déduits', cls(B.total))}
      ${kv('dont avant le carnet', usd(B.before, true), `avant le ${fmtDate(S.settings.startDate)} : forex, or et trades d’actions non saisis dans le carnet`, cls(B.before))}
      ${kv('dont depuis le carnet', usd(B.carnet, true), `depuis le ${fmtDate(S.settings.startDate)}, par rapport à ${usd(B.net + B.before)} au départ`, cls(B.carnet))}
    </dl>
    <details class="more"><summary>Pourquoi ce n’est pas le « Gain » de MT5</summary>
    <p class="hint">MT5 affiche un rendement pondéré dans le temps : une perte faite quand le compte était petit pèse autant qu’une perte sur un gros compte, et les dépôts suivants ne la rattrapent pas. Ici, c’est l’argent réellement gagné ou perdu par rapport à l’argent déposé. Le partage avant / depuis le carnet suppose que les versements faits depuis le ${fmtDate(S.settings.startDate)} sont saisis dans Réglages › Versements et retraits.</p>
    <button type="button" class="btn sm" data-act="acct">Modifier le relevé</button></details>
  </section>`;
}
function sheetAcct() {
  const a = S.settings.acct || {};
  openSheet({
    title: 'Relevé du compte courtier', ok: 'Enregistrer',
    body: `<p class="hint" style="margin-top:0">Dans MT5 : Historique › clic droit › Rapport. Recopiez les dépôts et retraits cumulés depuis l’ouverture du compte, toutes périodes et tous instruments confondus.</p>
      <div class="fields">${dec('deposits', 'Dépôts cumulés ($)', a.deposits)}${dec('withdrawals', 'Retraits cumulés ($)', a.withdrawals || 0)}
      ${inp('at', 'Date du relevé', a.at || todayISO(), 'type="date"')}${inp('since', 'Compte ouvert en', a.since || '', 'placeholder="avril 2025" autocomplete="off"')}</div>
      ${a.deposits ? '<div class="row"><button type="button" class="btn sm danger" data-act="acct-off">Retirer le bilan</button></div>' : ''}`,
    onSubmit: form => {
      const dep = num(F(form, 'deposits')), wd = numOr(F(form, 'withdrawals'), 0), at = F(form, 'at');
      need(dep > 0, 'Dépôts cumulés : montant positif.'); need(wd >= 0, 'Retraits cumulés : montant positif ou nul.'); need(!!at, 'Date du relevé manquante.');
      S.settings.acct = { deposits: dep, withdrawals: wd, at, since: F(form, 'since').trim() };
      save('Bilan depuis l’ouverture enregistré');
    }
  });
}
const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const MOIS_C = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
// Positions clôturées : statistiques, histogramme et répartition pour la période choisie (toutes, une année, ou un mois),
// avec le bilan mois par mois de l'année choisie. Une position compte dans le mois de sa clôture.
function closedCard() {
  const all = Core.tradeStats(S, planR).closed;
  const years = [...new Set(all.map(c => c.date.slice(0, 4)))].sort().reverse();
  if (tradeYear !== 'all' && !years.includes(tradeYear)) { tradeYear = 'all'; tradeMonth = 'all'; }
  const inP = c => (tradeYear === 'all' || c.date.slice(0, 4) === tradeYear) && (tradeMonth === 'all' || c.date.slice(5, 7) === tradeMonth);
  const ids = new Set(all.filter(inP).map(c => c.lot.id));
  const T = Core.tradeStats({ lots: S.lots.filter(l => ids.has(l.id)) }, planR);
  const yb = ['all'].concat(years).map(y => `<button class="btn sm" data-act="trade-year" data-f="${y}" aria-pressed="${tradeYear === y}">${y === 'all' ? 'Tout' : y}</button>`).join('');
  let months = '', table = '';
  if (tradeYear !== 'all') {
    const rows = MOIS.map((m, i) => {
      const k = String(i + 1).padStart(2, '0'), cs = all.filter(c => c.date.slice(0, 7) === tradeYear + '-' + k);
      const net = cs.reduce((a, c) => a + c.net, 0), r = cs.reduce((a, c) => a + (c.R || 0), 0);
      return { k, m, cs, net, r, w: cs.filter(c => c.net > 0.0049).length, l: cs.filter(c => c.net < -0.0049).length };
    });
    months = `<div class="filters" style="margin-top:6px"><button class="btn sm" data-act="trade-month" data-f="all" aria-pressed="${tradeMonth === 'all'}">Année entière</button>${rows.map(x => `<button class="btn sm" data-act="trade-month" data-f="${x.k}" aria-pressed="${tradeMonth === x.k}" ${x.cs.length ? '' : 'disabled'}>${MOIS_C[+x.k - 1]}</button>`).join('')}</div>`;
    const used = rows.filter(x => x.cs.length), tot = used.reduce((a, x) => ({ n: a.n + x.cs.length, w: a.w + x.w, l: a.l + x.l, net: a.net + x.net, r: a.r + x.r }), { n: 0, w: 0, l: 0, net: 0, r: 0 });
    table = used.length ? `<p class="chart-t" style="margin-top:14px">Mois par mois · ${tradeYear}</p>
      <div class="tbl"><table class="months"><thead><tr><th>Mois</th><th class="n">Trades</th><th class="n">G / P</th><th class="n">Net</th><th class="n">R</th></tr></thead><tbody>
      ${used.map(x => `<tr class="${tradeMonth === x.k ? 'sel' : ''}" data-act="trade-month" data-f="${x.k}"><td>${MOIS_C[+x.k - 1]}</td><td class="n">${x.cs.length}</td><td class="n">${x.w} / ${x.l}</td><td class="n ${cls(x.net)}">${usd(x.net, true)}</td><td class="n ${cls(x.r)}">${fmtR(x.r)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th>Total</th><th class="n">${tot.n}</th><th class="n">${tot.w} / ${tot.l}</th><th class="n ${cls(tot.net)}">${usd(tot.net, true)}</th><th class="n ${cls(tot.r)}">${fmtR(tot.r)}</th></tr></tfoot></table></div>
      <p class="hint">Touchez un mois pour voir son détail ci-dessus. Une position compte dans le mois de sa clôture.</p>` : '';
  }
  const label = tradeYear === 'all' ? 'depuis le début' : tradeMonth === 'all' ? 'année ' + tradeYear : MOIS[+tradeMonth - 1].toLowerCase() + ' ' + tradeYear;
  const net = T.closed.reduce((a, c) => a + c.net, 0);
  return `<section class="card">
    <div class="sec-head"><h2>Positions clôturées <small>· ${label}</small></h2>${T.count ? `<strong class="num ${cls(net)}" style="font-size:1.2rem">${usd(net, true)}</strong>` : ''}</div>
    <div class="filters">${yb}</div>${months}
    ${T.count ? `<dl class="kv" style="margin-top:10px">
      ${kv('Positions clôturées', String(T.count), 'sorties partielles regroupées avec leur achat')}
            ${kv('Taux de réussite', T.winRate == null ? 'Non calculable' : pct(T.winRate), T.count ? `${T.wins} gagnante(s), ${T.losses} perdante(s)` : '')}
      ${kv('Gain moyen', T.avgWin == null ? 'Non calculable' : usd(T.avgWin, true), '', 'pos')}
      ${kv('Perte moyenne', T.avgLoss == null ? 'Non calculable' : usd(T.avgLoss, true), '', 'neg')}
      ${kv('Profit factor', T.profitFactor == null ? 'Non calculable' : fmtNum(T.profitFactor, 2), 'gains bruts ÷ pertes brutes')}
      ${kv('Espérance par trade', T.avgR == null ? 'Non calculable' : fmtR(T.avgR), '1 R = ' + fmtNum(S.settings.riskPct, 2) + ' % du capital à l’achat' + (T.rCount < T.count ? ` · ${T.rCount} sur ${T.count}` : ''), T.avgR == null ? '' : cls(T.avgR))}
      ${kv('Gain moyen en R', T.avgWinR == null ? '—' : fmtR(T.avgWinR), '', 'pos')}
      ${kv('Perte moyenne en R', T.avgLossR == null ? '—' : fmtR(T.avgLossR), T.avgLossR != null && T.avgLossR < -1.2 ? 'au-delà de −1 R : stop ou taille hors plan' : '', 'neg')}
    </dl>
    ${rCharts(T)}` : '<p class="lead" style="margin-top:10px">Aucune position clôturée sur cette période.</p>'}
    ${table}
  </section>`;
}
// Résultats des trades clôturés en R : une barre par trade (ordre de clôture), puis leur répartition.
function rCharts(T) {
  const tr = T.closed.filter(c => c.R != null).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  if (!tr.length) return '<p class="hint">Les graphiques en R apparaîtront après la première position clôturée.</p>';
  const vw = (document.querySelector('#view') || {}).clientWidth || 700;
  const W = Math.round(Math.max(300, Math.min(700, vw - 38))), H = W < 500 ? 190 : 230, L = 38, Rm = 8, Tp = 10, B = 24;
  const lo = Math.min(-1.5, ...tr.map(c => c.R)), hi = Math.max(1.5, ...tr.map(c => c.R));
  const step = hi - lo > 12 ? 4 : hi - lo > 6 ? 2 : 1, a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const y = v => Tp + (b - v) / (b - a) * (H - Tp - B);
  const slot = (W - L - Rm) / tr.length, bw = Math.max(2, Math.min(28, slot * 0.7));
  let g = '';
  for (let v = a; v <= b + 1e-9; v += step) g += `<line class="grid" x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${v} R</text>`;
  const bars = tr.map((c, i) => {
    const x = L + slot * i + (slot - bw) / 2, y0 = y(0), y1 = y(c.R);
    return `<rect class="${c.R >= 0 ? 'bw' : 'bl'}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2"><title>${esc(c.lot.ticker)} · ${fmtDate(c.date)} · ${fmtR(c.R)} (${usd(c.net, true)})</title></rect>`;
  }).join('');
  const ref = [-1, 1].map(v => `<line class="rref" x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('');
  const lab = `<text x="${L}" y="${H - 6}">${fmtDate(tr[0].date)}</text><text x="${W - Rm}" y="${H - 6}" text-anchor="end">${fmtDate(tr[tr.length - 1].date)}</text>`;
  const svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Résultat de chaque position clôturée, en R">${g}${ref}<line class="zero" x1="${L}" x2="${W - Rm}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${bars}${lab}</svg>`;
  // Répartition : en suivi de tendance, on cherche beaucoup de petites pertes vers −1 R et quelques gros gains.
  const BK = [['≤ −2 R', r => r <= -2], ['−2 à −1 R', r => r > -2 && r <= -1], ['−1 à 0 R', r => r > -1 && r < 0], ['0 à +1 R', r => r >= 0 && r < 1], ['+1 à +2 R', r => r >= 1 && r < 2], ['+2 à +3 R', r => r >= 2 && r < 3], ['≥ +3 R', r => r >= 3]];
  const cnt = BK.map(([l, f], i) => ({ l, n: tr.filter(c => f(c.R)).length, neg: i < 3 })), mx = Math.max(...cnt.map(c => c.n));
  const dist = cnt.map(c => `<div class="dist-row"><span>${c.l}</span><div class="dist-bar"><i class="${c.neg ? 'bl' : 'bw'}" style="width:${mx ? (c.n / mx * 100).toFixed(1) : 0}%"></i></div><b class="num">${c.n}</b></div>`).join('');
  const best = tr.reduce((m, c) => c.R > m.R ? c : m), worst = tr.reduce((m, c) => c.R < m.R ? c : m);
  return `<p class="chart-t" style="margin-top:14px">Chaque position clôturée, en R</p>${svg}
    <p class="hint">Lignes pointillées : −1 R et +1 R. Meilleure : ${esc(best.lot.ticker)} ${fmtR(best.R)} · pire : ${esc(worst.lot.ticker)} ${fmtR(worst.R)}. Touchez une barre pour le détail.</p>
    <p class="chart-t" style="margin-top:12px">Répartition</p><div class="dist">${dist}</div>`;
}
// Explique ce qui manque quand la performance n'est pas calculable.
function perfWhy(P) {
  const s = S.settings, msgs = [];
  const early = S.lots.filter(l => l.date < s.startDate).sort((a, b) => a.date < b.date ? -1 : 1);
  if (early.length) msgs.push(`${early.length} position(s) sont antérieures à la date de départ (${fmtDate(s.startDate)}), la première le ${fmtDate(early[0].date)}. Dans Réglages, mettez comme date de départ le jour de votre premier dépôt et comme capital initial le montant déposé ce jour-là.`);
  const open = S.lots.filter(l => !Core.lotState(l).closed);
  const day = todayISO();
  const miss = [...new Set(open.filter(l => !(S.prices[l.ticker] || []).some(x => x.date === day)).map(l => l.ticker))].sort();
  if (open.length && miss.length && miss.length < open.length) msgs.push(`Pour une observation aujourd’hui, il manque le cours du jour de : <strong>${miss.map(esc).join(', ')}</strong>. Ou saisissez les fonds propres MT5 dans Réglages › Valeurs courtier.`);
  if (!msgs.length || (P.itd && !early.length)) return '';
  return `<div class="banner warn"><span>${msgs.join('<br>')}</span></div>`;
}
// ----- Comparaison avec le S&P 500 : ETF SPY de l'historique du radar (cours ajustés, dividendes inclus), aux dates des observations du compte -----
function spyAt() {
  const h0 = Radar.hist.SPY, h = h0 && (histFixed('SPY', h0) || h0); if (!h || !h.bars || h.bars.length < 2) return null;
  const b = h.bars;
  return d => { let lo = 0, hi = b.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m][0] <= d) { r = b[m][1]; lo = m + 1; } else hi = m - 1; } return r; };
}
// Variations entre deux observations consécutives (compte, SPY). Seulement les écarts de 5 jours ou moins (séances, pas des trous).
function benchPairs(pts, at) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], x = at(a.date), y = at(b.date);
    if (b.r == null || !(x > 0 && y > 0) || Core.days(a.date, b.date) > 5) continue;
    out.push([b.r * 100, (y / x - 1) * 100]);
  }
  return out;
}
function benchBlock(P, sel, rangePts) {
  const at = spyAt();
  if (!at) return { tiles: `<p class="hint">Comparaison avec le S&amp;P 500 : historique de SPY en attente${S.watch.some(w => w.ticker === 'SPY') ? ' (chargé par le radar)' : ' : ajoutez SPY au radar (carte Marché US › SMA)'}.</p>`, kv: '', at: null };
  if (!sel || rangePts.length < 2) return { tiles: '', kv: '', at: null };
  const a = at(sel.from), b = at(sel.to); if (!(a > 0 && b > 0)) return { tiles: '', kv: '', at: null };
  const rS = (b / a - 1) * 100, gap = sel.r - rS;
  const tiles = `<div class="btiles"><div><small>Votre compte</small><b class="num ${cls(sel.r)}">${pct(sel.r, true)}</b></div><div><small>S&amp;P 500</small><b class="num ${cls(rS)}">${pct(rS, true)}</b></div><div><small>Écart</small><b class="num ${cls(gap)}">${(gap >= 0 ? '+' : '−') + fmtNum(Math.abs(gap), 2)} pt</b></div></div>`;
  // Bêta sur les 60 dernières variations de séance du compte (toutes périodes) ; séances gagnantes sur la période affichée.
  const all = benchPairs(P.pts, at).slice(-60), inR = benchPairs(rangePts, at);
  let beta = null;
  if (all.length >= 8) {
    const mx = all.reduce((t, p) => t + p[1], 0) / all.length, my = all.reduce((t, p) => t + p[0], 0) / all.length;
    let cv = 0, vr = 0; for (const [y, x] of all) { cv += (x - mx) * (y - my); vr += (x - mx) ** 2; }
    beta = vr > 0 ? cv / vr : null;
  }
  const won = inR.filter(([y, x]) => y > x).length;
  let kvs = kv('Sensibilité au marché (bêta)', beta == null ? 'Pas assez de séances' : `${fmtNum(beta, 2)}`, beta == null ? `il faut au moins 8 séances consécutives observées (${all.length} pour l’instant)` : `quand le S&amp;P fait −1 %, votre compte fait environ ${pct(-beta, true)} · ${all.length} séance(s) observée(s)`, beta != null && beta > 1.5 ? 'neg' : '');
  if (inR.length) kvs += kv('Séances meilleures que le S&amp;P', `${won} / ${inR.length}`, 'sur les séances observées de la période');
  if (perfRange !== 'itd' && P.itd) { const a0 = at(P.itd.from), b0 = at(P.itd.to); if (a0 > 0 && b0 > 0) { const r0 = (b0 / a0 - 1) * 100; kvs += kv('Depuis le début', `${pct(P.itd.r, true)} vs ${pct(r0, true)}`, `${fmtDate(P.itd.from)} → ${fmtDate(P.itd.to)} · compte vs S&amp;P 500`, cls(P.itd.r - r0)); } }
  return { tiles, kv: kvs, at };
}
function chartSVG(pts, bench) {
  if (pts.length < 2) return '<p class="hint">La courbe apparaîtra après deux observations.</p>';
  const vw = (document.querySelector('#view') || {}).clientWidth || 700;
  const W = Math.round(Math.max(320, Math.min(700, vw - 38))), H = W < 500 ? 220 : 280, L = 46, R = 10, Tp = 14, B = 28;
  const t0 = Date.parse(pts[0].date), t1 = Date.parse(pts[pts.length - 1].date);
  const ticks = (lo, hi, n) => {
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    const stepRaw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(stepRaw)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= stepRaw);
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  };
  const x = d => L + (t1 === t0 ? 0 : (Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const grid = (sc, y) => { let g = ''; for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v, 1)} %</text>`; return g; };
  // Courbe cumulée corrigée des apports
  const vals = pts.map(p => (p.index - 1) * 100);
  // S&P 500 rebasé à 0 % au premier point, aux mêmes dates.
  const b0 = bench && bench(pts[0].date), bv = b0 > 0 ? pts.map(p => { const v = bench(p.date); return v > 0 ? (v / b0 - 1) * 100 : null; }) : null;
  const allV = vals.concat(bv ? bv.filter(v => v != null) : []);
  const sc = ticks(Math.min(0, ...allV), Math.max(0, ...allV), 4);
  const y = v => Tp + (sc.hi - v) / (sc.hi - sc.lo) * (H - Tp - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y((p.index - 1) * 100).toFixed(1)}`).join('');
  const area = path + `L${x(pts[pts.length - 1].date).toFixed(1)},${y(sc.lo)}L${x(pts[0].date).toFixed(1)},${y(sc.lo)}Z`;
  const dots = pts.map(p => `<circle class="dot ${p.source === 'courtier' ? 'br' : (p.est ? 'est' : '')}" cx="${x(p.date).toFixed(1)}" cy="${y((p.index - 1) * 100).toFixed(1)}" r="3.5"><title>${fmtDate(p.date)} : ${pct((p.index - 1) * 100, true)} · ${usd(p.value)}</title></circle>`).join('');
  const bpath = bv ? pts.map((p, i) => bv[i] == null ? '' : `${i && bv[i - 1] != null ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(bv[i]).toFixed(1)}`).join('') : '';
  const lab = `<text x="${L}" y="${H - 8}">${fmtDate(pts[0].date)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end">${fmtDate(pts[pts.length - 1].date)}</text>`;
  const main = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de performance cumulée corrigée des apports"><defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>${grid(sc, y)}<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/><path class="area" d="${area}"/>${bpath ? `<path class="bench" d="${bpath}"/>` : ''}<path class="line" d="${path}"/>${dots}${lab}</svg>${bpath ? '<div class="blegend"><span><i class="me"></i>Votre compte</span><span><i class="sp"></i>S&amp;P 500 (SPY, dividendes inclus)</span></div>' : ''}`;
  // Drawdown : recul depuis le plus haut précédent
  let peak = pts[0].index;
  const dd = pts.map(p => { peak = Math.max(peak, p.index); return (p.index / peak - 1) * 100; });
  const minDD = Math.min(...dd);
  if (!(minDD < -0.005)) return main;
  const H2 = W < 500 ? 110 : 130, sd = ticks(minDD, 0, 2);
  const y2 = v => Tp + (0 - v) / (0 - sd.lo) * (H2 - Tp - 10);
  const dpath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y2(dd[i]).toFixed(1)}`).join('');
  let g2 = ''; for (let v = sd.lo; v <= 1e-9; v += sd.step) g2 += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y2(v)}" y2="${y2(v)}"/><text x="${L - 6}" y="${y2(v) + 4}" text-anchor="end">${fmtNum(v, 1)} %</text>`;
  return main + `<p class="chart-t">Drawdown</p><svg class="chart" viewBox="0 0 ${W} ${H2}" role="img" aria-label="Recul depuis le plus haut">${g2}<path class="dd" d="${dpath}L${x(pts[pts.length - 1].date).toFixed(1)},${y2(0)}L${x(pts[0].date).toFixed(1)},${y2(0)}Z"/><path class="ddl" d="${dpath}"/></svg>`;
}

// ----- Calculateur -----
function freshDraft() {
  const s = S.settings, lb = latestBroker();
  return { ticker: '', entry: '100', stop: '90', leverage: String(s.leverage), cap: String(s.cap),
    inFixed: String(s.fees.inFixed), inPct: String(s.fees.inPct), outFixed: String(s.fees.outFixed), outPct: String(s.fees.outPct),
    fractional: s.fractional, decimals: String(s.decimals), marginAvail: lb && isNum(lb.marginAvail) ? String(lb.marginAvail) : '', example: true };
}
function viewCalc() {
  if (!calcDraft) calcDraft = freshDraft();
  const d = calcDraft, ref = referenceCapital();
  const f = (id, label, val, extra = '') => `<div class="fld"><label for="c-${id}">${label}</label><input id="c-${id}" name="${id}" value="${esc(val)}" inputmode="decimal" autocomplete="off" ${extra}></div>`;
  return `${demoBanner()}
  <div class="grid2">
  <section class="card">
    <div class="sec-head"><h2>Calculateur avant achat</h2><button class="btn sm" data-act="reset-calc">Réinitialiser</button></div>
    <div class="banner ${ref.stale ? 'warn' : 'info'}"><span>Capital de référence : <strong class="num">${usd(ref.value)}</strong> · ${ref.label.toLowerCase()} au ${fmtDate(ref.date)}${ref.stale ? ` · <strong>données de ${ref.age} jours</strong>` : ''}. Budget de risque : <strong class="num">${usd(ref.value * S.settings.riskPct / 100)}</strong> (${fmtNum(S.settings.riskPct)} %).${ref.notes.length ? '<br>' + ref.notes.join(' ') : ''}</span></div>
    <form id="calcForm" class="fields" autocomplete="off">
      <div class="fld"><label for="c-ticker">Ticker</label><input id="c-ticker" name="ticker" value="${esc(d.ticker)}" autocapitalize="characters" placeholder="ex. MSFT"></div>
      ${f('entry', 'Prix d’entrée prévu ($)', d.entry)}
      ${f('stop', 'Stop initial ($)', d.stop)}
      ${f('leverage', 'Levier applicable (×)', d.leverage)}
      ${f('cap', 'Plafond d’exposition ($)', d.cap)}
      ${f('marginAvail', 'Marge disponible courtier ($)', d.marginAvail, 'placeholder="facultatif"')}
      ${f('inFixed', 'Frais entrée fixes ($)', d.inFixed)}
      ${f('inPct', 'Frais entrée (% montant)', d.inPct)}
      ${f('outFixed', 'Frais sortie fixes ($)', d.outFixed)}
      ${f('outPct', 'Frais sortie (% montant)', d.outPct)}
      ${S.settings.fees.perShare || S.settings.fees.minComm ? `<p class="hint wide">Commission courtier en plus : ${usd(S.settings.fees.perShare || 0)} par action, ${usd(S.settings.fees.minComm || 0)} minimum, à l’entrée et à la sortie (Réglages).</p>` : ''}
      <div class="fld"><span class="lbl">Fractions d’action</span><label class="check"><input type="checkbox" id="c-fractional" name="fractional" ${d.fractional ? 'checked' : ''}> autorisées</label></div>
      ${f('decimals', 'Précision (décimales)', d.decimals, d.fractional ? '' : 'disabled')}
    </form>
    ${d.example ? '<p class="hint">Entrée 100 $ et stop 90 $ sont des valeurs d’exemple : remplacez-les.</p>' : ''}
  </section>
  <section class="card" aria-live="polite"><div id="calcResult"></div></section>
  </div>`;
}
// Niveau de marge estimé (valeur nette ÷ marge) si l'on ajoute une marge de « add » : alerte seulement, jamais bloquant.
function marginAfter(add) {
  const acc = Core.accountState(S, null, 'last'), m = acc.margin + (add || 0);
  return acc.equity > 0 && m > 0 ? { now: acc.margin > 0 ? acc.equity / acc.margin * 100 : null, after: acc.equity / m * 100 } : null;
}
function marginWarn(add) {
  const ma = marginAfter(add), min = S.settings.marginMin || 150;
  if (!ma || ma.after >= min) return '';
  return `<div class="banner warn"><span>Après cet achat, niveau de marge estimé <strong class="num">${fmtNum(ma.after, 0)} %</strong>${ma.now != null ? ` (aujourd’hui ${fmtNum(ma.now, 0)} %)` : ''}, sous votre seuil de ${fmtNum(min, 0)} %. Le courtier ferme des positions vers 50 %. Vous pouvez quand même enregistrer l’achat.</span></div>`;
}
function calcInput() {
  const d = calcDraft, ref = referenceCapital();
  return { equity: ref.value, riskPct: S.settings.riskPct, entry: d.entry, stop: d.stop, leverage: d.leverage, cap: d.cap,
    fractional: d.fractional, decimals: d.decimals, marginAvail: d.marginAvail,
    fees: { inFixed: d.inFixed, inPct: d.inPct, outFixed: d.outFixed, outPct: d.outPct, perShare: S.settings.fees.perShare, minComm: S.settings.fees.minComm } };
}
function updateCalc() {
  const box = $('#calcResult'); if (!box) return;
  const r = Core.sizePosition(calcInput());
  if (!r.ok) {
    box.innerHTML = `<h2>Résultat</h2><ul class="errs">${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>${fine()}`;
    return;
  }
  const lev = r.params.leverage;
  box.innerHTML = `<div class="result">
    <div class="sec-head"><h2>Quantité proposée</h2><small>${calcDraft.ticker ? esc(calcDraft.ticker.toUpperCase()) : 'Ticker non saisi'}</small></div>
    <div class="qty-big">${qty(r.q)} <small>action${r.q >= 2 ? 's' : ''}</small></div>
    ${r.reason ? `<p class="reason">${esc(r.reason)}</p>` : ''}
    <dl class="kv">
      ${kv('Exposition totale', usd(r.exposure), `plafond ${usd(r.params.cap)}`)}
      ${kv('Marge initiale estimée', usd(r.margin), `exposition ÷ ${fmtNum(lev)}`)}
      ${kv('Distance du stop', pct(r.stopDistPct))}
      ${kv('Perte prévue au stop', usd(-r.totalRisk), `prix ${usd(r.priceRisk)} + frais ${usd(r.feesRT)}`, 'neg')}
      ${kv('Risque du compte', pct(r.riskPctAccount), `budget ${usd(r.budget)}`)}
      ${(o => { const loss = r.totalRisk + r.q * r.params.stop * o.pct / 100; return kv(`Si la clôture passe ${fmtNum(o.pct, 1)} % sous le stop`, usd(-loss), `${pct(loss / r.params.equity * 100)} du capital · ${o.src} (information, la taille reste calculée sur votre stop)`, 'neg'); })(overshootUsed())}
      ${kv('Baisse de 10 % du cours', usd(-r.drop10), 'perte réelle, sans re-multiplier par le levier', 'neg')}
    </dl>
    ${r.marginChecked ? '' : '<p class="hint">Marge disponible non saisie : la contrainte de marge n’est pas vérifiée.</p>'}
    ${marginWarn(r.margin)}
    ${preTradeChecks(calcDraft.ticker, r.totalRisk, r.exposure)}
    ${riskCalcHint(calcDraft.ticker, r.totalRisk, r.margin)}
    <div class="row"><button class="btn primary" data-act="record-buy">Enregistrer l’achat</button></div>
    ${fine()}</div>`;
}
const fine = () => '<p class="fine">Le risque au stop est estimé. Un gap, le glissement ou les frais de financement peuvent augmenter la perte réelle. La marge affichée est indicative : les règles du courtier prévalent. Aucun prix de liquidation n’est calculé.</p>';

// ----- Positions et journal -----
function lotView(lot) {
  const ls = Core.lotState(lot), last = Core.lastPrice(S.prices, lot.ticker);
  const sa = ls.closed ? null : Core.stopAnalysis(lot, ls, last, fees());
  const unreal = ls.closed || !last ? 0 : ls.rem * (last.price - lot.price);
  return { lot, ls, last, sa, unreal };
}
// Barre stop · entrée · cours : où se trouve le cours entre le stop et le prix d'achat.
function rail(entry, stop, price) {
  if (!(isNum(stop) && stop > 0) || !isNum(price)) return '';
  const lo = Math.min(stop, entry, price), hi = Math.max(stop, entry, price), pad = (hi - lo) * 0.06 || entry * 0.01;
  const X = v => (v - lo + pad) / (hi - lo + 2 * pad) * 100;
  const a = X(Math.min(stop, price)), b = X(Math.max(stop, price));
  return `<div class="rail" aria-hidden="true"><i class="zone ${price > stop ? '' : 'bad'}" style="left:${a.toFixed(1)}%;width:${(b - a).toFixed(1)}%"></i><b class="mk stop" style="left:${X(stop).toFixed(1)}%"></b><b class="mk entry" style="left:${X(entry).toFixed(1)}%"></b><b class="mk px" style="left:${X(price).toFixed(1)}%"></b></div>
    <div class="rail-leg"><span class="s">Stop ${usd(stop)}</span><span>Entrée ${usd(entry)}</span><span class="p">Cours ${usd(price)}</span></div>`;
}
let posSort = 'risk', posQuery = '';
// Filtre sans redessiner la page : le clavier reste ouvert pendant la saisie.
function applyPosQuery() {
  const q = posQuery.trim().toLowerCase();
  let n = 0;
  for (const el of document.querySelectorAll('.pcard[data-q], #view details.lot[data-q]')) {
    const hit = !q || el.dataset.q.includes(q);
    el.hidden = !hit;
    if (hit && el.classList.contains('pcard')) n++;
  }
  const c = $('#pos-q-n'); if (c) c.textContent = q ? n + ' position(s) ouverte(s) trouvée(s)' : '';
}
function viewPos() {
  const today = todayISO();
  const views = S.lots.map(lotView);
  const open = views.filter(v => !v.ls.closed);
  const byT = {};
  for (const v of open) (byT[v.lot.ticker] = byT[v.lot.ticker] || []).push(v);
  const totalExpo = open.reduce((a, v) => a + v.ls.rem * (v.last ? v.last.price : v.lot.price), 0);
  const missing = open.filter(v => v.sa.missing);
  const riskInit = open.reduce((a, v) => a + (v.lot.riskInitial || 0), 0);
  const withStop = open.filter(v => !v.sa.missing);
  const lossVsEntry = withStop.reduce((a, v) => a + Math.min(0, v.sa.vsEntry), 0);
  const pullback = withStop.reduce((a, v) => a + (v.sa.pullback || 0), 0);
  const equity = referenceCapital().acc.equity;
  const cards = Object.keys(byT).map(t => {
    const vs = byT[t];
    const q = vs.reduce((a, v) => a + v.ls.rem, 0);
    const avg = vs.reduce((a, v) => a + v.ls.rem * v.lot.price, 0) / q;
    const last = vs[0].last, px = last ? last.price : null;
    const expo = q * (px == null ? avg : px);
    const margin = vs.reduce((a, v) => a + v.ls.rem * (px == null ? v.lot.price : px) / (v.lot.leverage || 1), 0);
    const un = vs.reduce((a, v) => a + v.unreal, 0), swapT = vs.reduce((a, v) => a + v.ls.funding, 0);
    const stops = vs.map(v => v.lot.stopCurrent).filter(x => isNum(x) && x > 0);
    const stop = stops.length === vs.length ? Math.min(...stops) : null;
    const atStop = vs.every(v => !v.sa.missing) ? vs.reduce((a, v) => a + v.sa.vsEntry, 0) : null;
    const dist = stop != null && px != null ? (px - stop) / px * 100 : null;
    const first = vs.map(v => v.lot.date).sort()[0];
    const stale = !last || Core.days(last.date, today) > S.settings.staleDays;
    const lev = [...new Set(vs.map(v => v.lot.leverage))].map(x => '×' + fmtNum(x)).join(' / ');
    const sTf = stopTf(t), wait = stop != null && px != null && px <= stop && !stopWindow(sTf, last.date);
    const state = ((stop != null && px != null && px <= stop) || stop == null) && !wait ? 'danger' : un > 0.005 ? 'up' : un < -0.005 ? 'down' : '';
    const html = `<article class="pcard ${state}" data-q="${esc((t + ' ' + vs.map(v => v.lot.note || '').join(' ')).toLowerCase())}">
      <header><div><span class="tk">${esc(t)}</span> <button class="src ${manualSet().has(t) ? '' : 'on'}" data-act="quote-toggle" data-t="${esc(t)}" title="Source du cours : touchez pour changer">${manualSet().has(t) ? 'Cours manuel' : 'Cours Finnhub'}</button> ${stop != null && stop >= avg ? '<span class="pill win">Sans risque</span>' : ''}${state === 'danger' ? `<span class="pill loss">${stop == null ? 'Sans stop' : 'Stop atteint'}</span>` : ''}${wait ? `<span class="pill earn" title="Alerte à la clôture de l’unité d’entrée">Sous le stop · ${sTf === 'W' ? 'clôture hebdo' : 'clôture mensuelle'}</span>` : ''}
        <small>${vs.length > 1 ? vs.length + ' achats · ' : ''}${Core.days(first, today)} j · levier ${lev}${swapT > 0.0049 ? ` · swap ${usd(-swapT, true)}` : ''}</small></div>
        <div class="pl ${cls(un)}">${usd(un, true)}<small>${pct(un / (q * avg) * 100, true)}</small></div></header>
      ${px != null ? rail(avg, stop, px) : '<p class="hint">Aucun cours saisi.</p>'}
      <div class="mini">
        <div><span>Quantité</span><b>${qty(q)}</b></div>
        <div><span>Exposition</span><b>${usd(expo)}</b></div>
        <div><span>Marge</span><b>${usd(margin)}</b></div>
        <div><span>Au stop</span><b class="${cls(atStop)}">${atStop == null ? '—' : usd(atStop, true)}</b></div>
        <div><span>Dist. stop</span><b class="${dist != null && dist < 1 ? 'neg' : ''}">${dist == null ? '—' : pct(dist)}</b></div>
        <div><span>Cours du</span><b class="${stale ? 'wrn' : last && last.live ? 'pos' : ''}">${last ? (last.live ? 'direct ' + hhmm(last.at) : fmtDate(last.date).replace(/ \d{4}$/, '')) : '—'}</b></div>
      </div>
      ${swapT > 0.0049 ? (w => `<p class="swapl ${un > 0.5 && swapT / un * 100 >= swapWarnPct() ? 'hi' : ''}">Swap payé <b class="num">${usd(swapT)}</b>${w > 0 ? ` · ≈ <b class="num">${usd(w)}</b> par semaine` : ''}${un > 0.5 ? ` · ${fmtNum(swapT / un * 100, 0)} % du gain latent` : un < -0.5 ? ' · position en perte : le swap s’y ajoute' : ''}</p>`)(swapWeek(q, px == null ? avg : px)) : ''}
      ${(k => `<p class="smal">SMA de la position : ${k.length ? `<b>${k.map(smaLbl).join(' · ')}</b>` : '<span class="wrn">à choisir</span>'} <button class="btn sm" data-act="pos-sma" data-t="${esc(t)}">${k.length ? 'Modifier' : 'Choisir les SMA'}</button> <button class="btn sm" data-act="chart" data-t="${esc(t)}">Graphique</button></p>`)(posSmas(t))}
      ${vs.map(v => lotDetails(v, false, vs.length === 1)).join('')}
    </article>`;
    return { t, html, dist: dist == null ? -1e9 : dist, un, expo };
  });
  const sorter = { risk: (a, b) => a.dist - b.dist, gain: (a, b) => b.un - a.un, expo: (a, b) => b.expo - a.expo, az: (a, b) => a.t < b.t ? -1 : 1 }[posSort] || ((a, b) => a.dist - b.dist);
  cards.sort(sorter);
  const sortBtns = [['risk', 'Près du stop'], ['gain', 'Gain'], ['expo', 'Exposition'], ['az', 'A → Z']]
    .map(([k, l]) => `<button class="btn sm" data-act="psort" data-f="${k}" aria-pressed="${posSort === k}">${l}</button>`).join('');
  const jl = views.filter(v => journalFilter === 'all' || (journalFilter === 'closed' ? v.ls.closed : !v.ls.closed))
    .sort((a, b) => (a.lot.date < b.lot.date ? 1 : -1));
  const expoRows = Object.keys(byT).map(t => [t, byT[t].reduce((a, v) => a + v.ls.rem * (v.last ? v.last.price : v.lot.price), 0)]).sort((a, b) => b[1] - a[1]);
  const maxE = expoRows.length ? expoRows[0][1] : 1;
  return `${demoBanner()}
  ${alertsStrip()}
  ${liveBar()}
  <section class="card">
    <div class="sec-head"><h2>Risque des positions ouvertes</h2><button class="btn primary sm" data-act="prices" ${open.length ? '' : 'disabled'}>Mettre à jour les cours</button></div>
    <dl class="kv">
      ${kv('Positions ouvertes', String(open.length), Object.keys(byT).length + ' ticker(s)')}
      ${kv('Risque initial historique', usd(riskInit), equity > 0 ? pct(riskInit / equity * 100) + ' de la valeur nette' : '')}
      ${kv('Perte possible vs entrée', usd(lossVsEntry, true), 'si les stops actuels sont exécutés', cls(lossVsEntry))}
      ${kv('Recul possible depuis le cours', usd(-pullback), 'gain latent pouvant être reperdu inclus', pullback > 0 ? 'neg' : '')}
    </dl>
    ${missing.length ? `<div class="banner err">Stop manquant : ${[...new Set(missing.map(v => esc(v.lot.ticker)))].join(', ')}. Le risque de ces lignes n’est pas borné et n’est pas compté dans les totaux ci-dessus.</div>` : ''}
    ${open.length ? `<details class="more"><summary>Exposition par ticker (${usd(totalExpo)})</summary><div class="expo-list">${expoRows.map(([t, e]) =>
      `<div class="expo"><span class="tk">${esc(t)}</span><span class="bar"><i class="${e > S.settings.cap + 0.005 ? 'over' : ''}" style="width:${(e / maxE * 100).toFixed(1)}%"></i></span><span class="num">${usd(e)}</span></div>`).join('')}</div>
      <p class="hint" style="margin-top:8px">En orange : au-dessus du plafond de ${usd(S.settings.cap)}.</p></details>` : ''}
  </section>
  <section class="card">
    <div class="sec-head"><h2>Positions ouvertes</h2><button class="btn sm primary" data-act="go-calc">+ Nouvelle position</button></div>
    ${open.length ? `<div class="search"><input type="search" id="pos-q" value="${esc(posQuery)}" placeholder="Rechercher une action (ex. ABBV)" autocomplete="off" autocapitalize="characters" aria-label="Rechercher une action"><small id="pos-q-n"></small></div>
    <div class="filters">${sortBtns}</div><div class="pgrid">${cards.map(c => c.html).join('')}</div>` : '<p class="lead">Aucune position ouverte. Calculez une taille dans « Nouvelle position », puis enregistrez l’achat.</p>'}
  </section>
  <section class="card">
    <div class="sec-head"><h2>Journal</h2>
      <div class="filters">${[['closed', 'Clôturées'], ['open', 'Ouvertes'], ['all', 'Toutes']].map(([k, l]) => `<button class="btn sm" data-act="jfilter" data-f="${k}" aria-pressed="${journalFilter === k}">${l}</button>`).join('')}</div></div>
    ${jl.length ? jl.map(v => lotDetails(v, true)).join('') : '<p class="lead">Rien à afficher pour ce filtre.</p>'}
  </section>`;
}
function lotDetails(v, inJournal, compact) {
  const { lot, ls, last, sa, unreal } = v;
  const R = lotR(lot, ls), u = planR(lot), xPlan = u > 0 && lot.riskInitial > 0 ? lot.riskInitial / u : null;
  const status = ls.closed ? (ls.netRealized > 0.0049 ? '<span class="pill win">Gagnante</span>' : ls.netRealized < -0.0049 ? '<span class="pill loss">Perdante</span>' : '<span class="pill">Neutre</span>') : '<span class="pill open">Ouverte</span>';
  const key = (inJournal ? 'j-' : 'p-') + lot.id;
  const evRows = lot.events.slice().sort((a, b) => a.date < b.date ? -1 : 1).map(e => {
    const lab = { sell: 'Vente', funding: 'Financement', dividend: 'Dividende', adjust: 'Ajustement', stop: 'Stop' }[e.type] || e.type;
    let detail = '', amt = '';
    if (e.type === 'sell') { detail = `${qty(e.qty)} × ${usd(e.price)} · frais ${usd(e.fee || 0)}`; amt = usd(e.qty * (e.price - lot.price) - (e.fee || 0), true); }
    else if (e.type === 'funding') { detail = esc(e.note || ''); amt = usd(-e.amount, true); }
    else if (e.type === 'stop') { detail = `${e.from == null ? 'aucun' : usd(e.from)} → ${e.to == null ? 'aucun' : usd(e.to)}`; }
    else { detail = esc(e.note || ''); amt = usd(e.amount, true); }
    const photo = e.type === 'sell' ? `<button class="btn sm" data-act="sell-img" data-lot="${lot.id}" data-ev="${e.id}">${e.imgId ? 'Photo ✓' : '+ Photo'}</button> ` : '';
    return `<tr><td>${fmtDate(e.date)}</td><td>${lab}</td><td>${detail}</td><td class="n">${amt}</td><td>${photo}<button class="btn sm" data-act="del-event" data-lot="${lot.id}" data-ev="${e.id}" aria-label="Supprimer ce mouvement">Suppr.</button></td></tr>`;
  }).join('');
  // Positions en cours : « Modifier » directement sur la ligne, sans déplier les détails.
  const quick = inJournal ? '' : `<button type="button" class="btn sm" data-act="edit-lot" data-lot="${lot.id}">Modifier</button>`;
  const sumRight = ls.closed
    ? `<span class="num ${cls(ls.netRealized)}">${usd(ls.netRealized, true)}${R != null ? ' · ' + fmtR(R) : ''}</span>`
    : `<span class="num ${cls(unreal)}">${usd(unreal, true)}</span>`;
  return `<details class="lot" data-key="${key}" ${inJournal ? `data-q="${esc((lot.ticker + ' ' + (lot.note || '')).toLowerCase())}"` : ''} ${openLots.has(key) ? 'open' : ''}>
    <summary>${compact ? `<span>Détails et actions <small>· achat du ${fmtDate(lot.date)} à ${usd(lot.price)}</small></span><span class="sum-r">${quick}<span class="chev">›</span></span>` : `<span><span class="tk">${esc(lot.ticker)}</span> ${status}${ls.closed ? '' : earnPill(lot.ticker)} ${lot.demo ? '<span class="pill demo">Démo</span>' : ''}<br><small>${fmtDate(lot.date)} · ${qty(lot.qty)} à ${usd(lot.price)} · ${MOTIFS[lot.motif] || 'Autre'}</small></span><span class="sum-r">${sumRight}${quick}</span>`}</summary>
    <div class="body">
      <dl class="kv">
        ${kv('Quantité restante', qty(ls.rem), ls.sold ? `vendu ${qty(ls.sold)}` : '')}
        ${kv('Exposition à l’entrée', usd(lot.qty * lot.price), `levier ×${fmtNum(lot.leverage)}`)}
        ${kv('Stop initial', isNum(lot.stopInitial) ? usd(lot.stopInitial) : 'Non saisi')}
        ${kv('Stop actuel', isNum(lot.stopCurrent) && lot.stopCurrent > 0 ? usd(lot.stopCurrent) : 'Manquant', '', isNum(lot.stopCurrent) && lot.stopCurrent > 0 ? '' : 'neg')}
        ${kv('Risque initial', isNum(lot.riskInitial) ? usd(lot.riskInitial) : 'Non calculable', (isNum(lot.riskInitialPct) ? pct(lot.riskInitialPct) + ' de ' + usd(lot.refCapital) : '') + (xPlan != null ? ` · ${fmtNum(xPlan, 1)} × le plan (1 R = ${usd(u)})` : ''), xPlan > 1.2 ? 'neg' : '')}
        ${kv('Frais payés', usd(ls.txFees), `entrée ${usd(ls.entryFee)} · sortie ${usd(ls.exitFees)}`)}
        ${kv('Financement', usd(ls.funding), ls.fundingEst > 0.0049 ? `dont ${usd(ls.fundingEst)} de swap estimé${ls.funding - ls.fundingEst > 0.0049 ? ', le reste saisi' : ''}` : '')}
        ${ls.divs ? kv('Dividendes / ajust.', usd(ls.divs, true)) : ''}
        ${kv('Réalisé net', usd(ls.netRealized, true), 'frais déduits', cls(ls.netRealized))}
        ${ls.closed ? kv('Durée', Core.days(lot.date, ls.closeDate) + ' jours', 'clôturée le ' + fmtDate(ls.closeDate)) : kv('Durée de détention', Core.days(lot.date, todayISO()) + ' jours')}
        ${!ls.closed && sa && !sa.missing ? kv('Si stop actuel exécuté', usd(sa.vsEntry, true), 'partie restante vs entrée, frais de sortie estimés', cls(sa.vsEntry)) : ''}
        ${!ls.closed && sa && !sa.missing ? kv('Résultat total si stop', usd(sa.totalIfStop, true), 'y compris réalisé et frais payés', cls(sa.totalIfStop)) : ''}
        ${!ls.closed && sa && !sa.missing ? kv('Recul cours → stop', sa.pullback == null ? 'Non calculable' : usd(-sa.pullback), sa.belowStop ? 'cours sous le stop !' : (last ? 'depuis ' + usd(last.price) : ''), sa.belowStop ? 'neg' : '') : ''}
        ${ls.closed && R != null ? kv('Résultat en R', fmtR(R), `1 R = ${usd(u)} (${fmtNum(S.settings.riskPct, 2)} % du capital à l’achat)`, cls(R)) : ''}
        ${kv('Plan respecté', lot.planOk === true ? 'Oui' : lot.planOk === false ? 'Non' : 'Non renseigné', esc(lot.planComment || ''))}
      </dl>
      ${ls.closed ? exitBlock(lot) : ''}
      ${!ls.closed && sa && sa.missing ? '<div class="banner err">Stop manquant : risque non borné.</div>' : ''}
      ${lot.note ? `<p class="lead">${esc(lot.note)}</p>` : ''}
      ${lotImgIds(lot).length ? `<div class="shots">${lot.imgId ? `<figure><img class="thumb" data-img="${lot.imgId}" alt="Capture à l’achat ${esc(lot.ticker)}"><figcaption>Achat du ${fmtDate(lot.date)}</figcaption></figure>` : ''}${lot.events.filter(e => e.imgId).sort((a, b) => a.date < b.date ? -1 : 1).map(e => `<figure><img class="thumb" data-img="${e.imgId}" alt="Capture à la vente ${esc(lot.ticker)}"><figcaption>Vente du ${fmtDate(e.date)}</figcaption></figure>`).join('')}</div>` : ''}
      ${evRows ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Mouvement</th><th>Détail</th><th class="n">Montant</th><th></th></tr></thead><tbody>${evRows}</tbody></table></div>` : ''}
      <div class="row">
        ${ls.closed ? '' : `<button class="btn sm primary" data-act="sell" data-lot="${lot.id}">Vendre</button><button class="btn sm" data-act="stop" data-lot="${lot.id}">Modifier le stop</button><button class="btn sm" data-act="funding" data-lot="${lot.id}">Financement</button>`}
        <button class="btn sm" data-act="dividend" data-lot="${lot.id}">Dividende / ajustement</button>
        <button class="btn sm" data-act="plan" data-lot="${lot.id}">Plan respecté ?</button>
        <button class="btn sm" data-act="edit-lot" data-lot="${lot.id}">Corriger</button>
        <button class="btn sm danger" data-act="del-lot" data-lot="${lot.id}">Supprimer</button>
      </div>
    </div></details>`;
}
async function loadThumbs() {
  for (const img of document.querySelectorAll('img[data-img]')) {
    const src = await getImage(img.dataset.img);
    if (src) img.src = src; else img.replaceWith(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Capture introuvable sur cet appareil.' }));
  }
}

// ----- Réglages -----
function viewSettings() {
  const s = S.settings, f = s.fees;
  const fld = (id, label, val, hint) => `<div class="fld"><label for="s-${id}">${label}</label><input id="s-${id}" name="${id}" value="${esc(val)}" inputmode="decimal">${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  const flows = S.flows.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  const snaps = S.snapshots.slice().sort((a, b) => a.date < b.date ? 1 : -1);
  const snapRows = snaps.map(b => {
    const a = Core.accountState(S, b.date, 'last'), g = b.netValue - a.equity;
    const gap = a.equity > 0 ? `<span class="${Math.abs(g / a.equity * 100) < 0.5 ? '' : cls(g)}">${usd(g, true)} · ${pct(g / a.equity * 100, true)}</span>` : '—';
    return `<tr><td>${fmtDate(b.date)}</td><td class="n">${usd(b.netValue)}</td><td class="n">${usd(a.equity)}</td><td class="n">${isNum(b.marginUsed) ? usd(b.marginUsed) : isNum(b.marginAvail) ? usd(b.netValue - b.marginAvail) : '—'}</td><td class="n">${gap}</td><td>${b.demo ? '<span class="pill demo">Démo</span>' : ''}</td><td><button class="btn sm" data-act="del-snap" data-id="${b.id}">Suppr.</button></td></tr>`;
  }).join('');
  return `${demoBanner()}
  ${healthCard()}
  ${aboutCard()}
  <section class="card">
    <div class="sec-head"><h2>Compte et règles de risque</h2></div>
    <form id="setForm" class="fields">
      ${fld('initialCapital', 'Capital initial ($)', s.initialCapital)}
      <div class="fld"><label for="s-startDate">Date de départ</label><input type="date" id="s-startDate" name="startDate" value="${esc(s.startDate)}"></div>
      ${fld('riskPct', 'Risque par position (%)', s.riskPct)}
      ${fld('cap', 'Plafond d’exposition ($)', s.cap, 'Exposition réelle, pas la marge.')}
      ${fld('leverage', 'Levier par défaut (×)', s.leverage)}
      ${fld('staleDays', 'Alerte données anciennes (jours)', s.staleDays)}
      ${fld('overshoot', 'Dépassement prévu sous le stop (%)', isNum(s.overshoot) ? s.overshoot : 3, 'Sortie à la clôture : écart habituel sous le stop. Information du calculateur, remplacée par votre moyenne réelle dès 3 sorties.')}
      ${fld('marginMin', 'Alerte niveau de marge sous (%)', s.marginMin || 150, 'Valeur nette ÷ marge. Prévient sans bloquer ; le courtier ferme vers 50 %.')}
      ${fld('inFixed', 'Frais entrée fixes ($)', f.inFixed)}
      ${fld('inPct', 'Frais entrée (%)', f.inPct)}
      ${fld('outFixed', 'Frais sortie fixes ($)', f.outFixed)}
      ${fld('outPct', 'Frais sortie (%)', f.outPct)}
      ${fld('perShare', 'Commission par action ($)', f.perShare || 0, 'CFD actions : 1 action par lot. Entrée et sortie.')}
      ${fld('minComm', 'Commission minimum ($)', f.minComm || 0)}
      ${fld('swapPct', 'Swap acheteur (% par an)', (s.swap && s.swap.pct) || 0, 'Coût estimé chaque nuit : exposition × taux ÷ 360. 0 = pas d’estimation.')}
      <div class="fld"><label for="s-swapTriple">Swap triple le</label><select id="s-swapTriple" name="swapTriple">${['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'].map((l, i) => `<option value="${i + 1}" ${((s.swap && s.swap.triple) || 5) === i + 1 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="fld wide"><button type="button" class="btn sm" data-act="preset-icm">Préremplir IC Markets (CFD actions US)</button><p class="hint">Commission 0,02 $ par action (minimum 0,02 $), swap acheteur 5,93 % par an, triple le vendredi. Vérifiez dans MT5 : clic droit sur le symbole › Spécification.</p></div>
      <div class="fld"><span class="lbl">Fractions d’action</span><label class="check"><input type="checkbox" name="fractional" ${s.fractional ? 'checked' : ''}> autorisées</label></div>
      ${fld('decimals', 'Précision (décimales)', s.decimals)}
      <div class="fld wide"><label for="s-refSource">Capital de référence du calculateur</label>
        <select id="s-refSource" name="refSource">
          <option value="auto" ${s.refSource === 'auto' ? 'selected' : ''}>Automatique : la valorisation la plus récente</option>
          <option value="app" ${s.refSource === 'app' ? 'selected' : ''}>Toujours le calcul de l’application</option>
          <option value="broker" ${s.refSource === 'broker' ? 'selected' : ''}>Toujours la dernière valeur courtier</option>
        </select></div>
      <div class="row fld wide"><button type="submit" class="btn primary">Enregistrer les réglages</button></div>
    </form>
  </section>
  <div class="grid2">
  <section class="card">
    <div class="sec-head"><h2>Versements, retraits et rattrapages</h2><div class="row"><button class="btn sm" data-act="mt5-import">Import MT5</button><button class="btn sm" data-act="add-catchup">Rattrapage</button><button class="btn sm primary" data-act="add-flow">Ajouter</button></div></div>
    <p class="lead">Versements et retraits : flux externes, ils changent la valeur nette, jamais la performance. Rattrapage : un résultat déjà réalisé chez le courtier mais pas saisi trade par trade ; il compte dans la valeur et la performance, pas dans les statistiques de trades.</p>
    <div class="row" style="margin-bottom:8px"><button class="btn sm" data-act="acct">${S.settings.acct ? 'Modifier' : 'Saisir'} le relevé depuis l’ouverture du compte</button>${S.settings.acct ? `<small>${usd(S.settings.acct.deposits)} déposés au ${fmtDate(S.settings.acct.at)}</small>` : ''}</div>
    ${flows.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th>Type</th><th class="n">Montant</th><th></th><th></th></tr></thead><tbody>${flows.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${x.kind === 'pnl' ? 'Rattrapage' : x.amount >= 0 ? 'Versement' : 'Retrait'}${x.note ? ' · ' + esc(x.note) : ''}</td><td class="n">${usd(x.amount, true)}</td><td>${x.demo ? '<span class="pill demo">Démo</span>' : ''}</td><td><button class="btn sm" data-act="del-flow" data-id="${x.id}">Suppr.</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Aucun flux saisi.</p>'}
  </section>
  <section class="card">
    <div class="sec-head"><h2>Valeurs courtier</h2><button class="btn sm primary" data-act="add-snap">Rapprochement MT5</button></div>
    <p class="lead">Rapprochements MT5 : fonds propres et marge lus dans MT5, comparés au calcul de l’app à la même date. Un écart qui grandit d’une semaine à l’autre signale une saisie oubliée ou un swap mal estimé.</p>
    ${snaps.length ? `<div class="tbl"><table><thead><tr><th>Date</th><th class="n">MT5</th><th class="n">App</th><th class="n">Marge</th><th class="n">Écart</th><th></th><th></th></tr></thead><tbody>${snapRows}</tbody></table></div>` : '<p class="hint">Aucune valeur saisie.</p>'}
  </section>
  </div>
  ${quotesPanel()}
  <section class="card">
    <div class="sec-head"><h2>Sauvegarde et données</h2></div>
    <div class="banner ${Store.ref ? 'info' : 'warn'}"><span>${Store.ref
      ? 'Sauvegarde automatique dans votre espace privé claude.ai (lisible par vous seul, y compris depuis l’iPhone connecté au même compte), plus une copie sur cet appareil.'
      : '<strong>Données conservées uniquement sur cet appareil</strong>, dans ce navigateur. Elles disparaissent si les données du site sont effacées. Exportez régulièrement en JSON.'}</span></div>
    <div class="row">
      <button class="btn" data-act="export-csv">Exporter le journal (CSV)</button>
      <button class="btn" data-act="export-json">Exporter tout (JSON)</button>
      <button class="btn" data-act="import-json">Restaurer un JSON</button>
    </div>
    <div class="row">
      ${hasDemo() ? '<button class="btn" data-act="clear-demo">Effacer les données de démonstration</button>' : '<button class="btn" data-act="load-demo">Charger des données de démonstration</button>'}
      <button class="btn danger" data-act="wipe">Effacer toutes les données</button>
    </div>
    <p class="hint">L’application ne demande aucun identifiant de courtier, n’exécute aucun ordre et n’utilise aucune API de cotation : les cours se saisissent à la main.</p>
  </section>`;
}

// ---------- Feuilles de saisie ----------
let sheetCfg = null;
function openSheet(cfg) {
  sheetCfg = cfg;
  $('#sheetTitle').textContent = cfg.title;
  $('#sheetBody').innerHTML = cfg.body;
  $('#sheetErr').textContent = '';
  const ok = $('#sheetOk');
  ok.hidden = !cfg.onSubmit; ok.textContent = cfg.ok || 'Valider';
  ok.className = 'btn ' + (cfg.danger ? 'danger' : 'primary');
  $('#sheet').hidden = false;
  if (cfg.onInput) cfg.onInput($('#sheetForm'));
  const first = $('#sheetBody input:not([type=hidden]):not([readonly]), #sheetBody select');
  if (first && !cfg.noFocus) first.focus();
}
function closeSheet() { $('#sheet').hidden = true; sheetCfg = null; }
function confirmSheet(title, message, okLabel, fn) {
  openSheet({ title, body: `<p>${message}</p>`, ok: okLabel, danger: true, noFocus: true, onSubmit: () => { fn(); } });
}
const F = (form, n) => form.elements[n] ? form.elements[n].value : '';
const inp = (id, label, val, attrs = '', hint = '') => `<div class="fld"><label for="f-${id}">${label}</label><input id="f-${id}" name="${id}" value="${esc(val == null ? '' : val)}" ${attrs}>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
const dec = (id, label, val, attrs = '', hint = '') => inp(id, label, val, 'inputmode="decimal" autocomplete="off" ' + attrs, hint);
const dateInp = (id, label, val) => `<div class="fld"><label for="f-${id}">${label}</label><input type="date" id="f-${id}" name="${id}" value="${esc(val)}" required></div>`;
const planSel = (val) => `<div class="fld"><label for="f-planOk">Plan respecté</label><select id="f-planOk" name="planOk"><option value="" ${val == null ? 'selected' : ''}>Non renseigné</option><option value="yes" ${val === true ? 'selected' : ''}>Oui</option><option value="no" ${val === false ? 'selected' : ''}>Non</option></select></div>`;
const planVal = v => v === 'yes' ? true : v === 'no' ? false : null;
function need(cond, msg) { if (!cond) throw new Error(msg); }
function findLot(id) { return S.lots.find(l => l.id === id); }
function addPrice(ticker, date, price, demo, src) {
  const h = S.prices[ticker] = S.prices[ticker] || [];
  const i = h.findIndex(x => x.date === date);
  const rec = { date, price }; if (demo) rec.demo = true; if (src) rec.src = src;
  if (i >= 0) h[i] = rec; else h.push(rec);
  h.sort((a, b) => a.date < b.date ? -1 : 1);
}

function riskOf(q, price, stop, entryFee, f) {
  if (!(q > 0 && price > 0 && stop > 0)) return null;
  return q * (price - stop) + entryFee + Core.feeOut(q, stop, f);
}
function sheetBuy() {
  const r = Core.sizePosition(calcInput()); if (!r.ok) return;
  const d = calcDraft, ref = referenceCapital();
  const f = Core.normFees({ inFixed: d.inFixed, inPct: d.inPct, outFixed: d.outFixed, outPct: d.outPct, perShare: S.settings.fees.perShare, minComm: S.settings.fees.minComm });
  openSheet({
    title: 'Confirmer l’achat exécuté', ok: 'Enregistrer l’achat',
    body: `<p class="lead">Corrigez avec les valeurs réellement exécutées chez le courtier.</p><div class="fields">
      ${inp('ticker', 'Ticker', (d.ticker || '').toUpperCase(), 'autocapitalize="characters" required')}
      ${dateInp('date', 'Date d’exécution', todayISO())}
      ${dec('price', 'Prix exécuté ($)', d.entry)}
      ${dec('qty', 'Quantité exécutée', r.q)}
      ${dec('leverage', 'Levier (×)', d.leverage)}
      ${dec('entryFee', 'Frais réels d’entrée ($)', Core.roundTo(r.feeIn, 4))}
      ${dec('stop', 'Stop initial ($)', d.stop)}
      ${motifField((d.ticker || '').toUpperCase(), todayISO(), '')}
      <div class="fld wide"><label>Entrée grâce à quelle(s) SMA ?</label><div id="buySma" data-t="${esc((d.ticker || '').toUpperCase())}">${smaChoices((d.ticker || '').toUpperCase(), [])}</div><p class="hint">Seuls les stops de ces SMA vous seront proposés.</p></div>
      <div class="fld wide"><label for="f-note">Note</label><textarea id="f-note" name="note" placeholder="facultatif"></textarea></div>
      <div class="fld wide"><label class="check"><input type="checkbox" name="auto" ${manualSet().has((d.ticker || '').toUpperCase()) ? '' : 'checked'}> Action US : cours automatiques Finnhub</label><p class="hint">Décochez pour une action hors USA : vous saisirez son cours à la main.</p></div>
      <div class="fld wide"><label for="f-img">Capture du graphique</label><input type="file" id="f-img" name="img" accept="image/*"><p class="hint">Facultatif. Compressée avant sauvegarde.</p></div>
    </div><div id="buyCheck" class="banner info"></div>`,
    onInput: form => {
      const q = num(F(form, 'qty')), p = num(F(form, 'price')), st = num(F(form, 'stop')), fe = numOr(F(form, 'entryFee'), 0), lv = num(F(form, 'leverage'));
      const bt = F(form, 'ticker').trim().toUpperCase(), bs = $('#buySma');
      if (bs && bs.dataset.t !== bt) { bs.dataset.t = bt; bs.innerHTML = smaChoices(bt, []); }
      const risk = riskOf(q, p, st, fe, f), box = $('#buyCheck');
      if (risk == null || !(st < p) || !(lv >= 1)) { box.className = 'banner err'; box.textContent = 'Vérifiez prix, quantité, stop (inférieur au prix) et levier.'; return; }
      const rp = risk / ref.value * 100, over = risk > r.budget + 0.005, expo = q * p;
      const ma = marginAfter(expo / lv), low = ma && ma.after < (S.settings.marginMin || 150);
      box.className = 'banner ' + (over || low || expo > r.params.cap + 0.005 ? 'warn' : 'info');
      box.innerHTML = (low ? `<strong>Niveau de marge après achat ≈ ${fmtNum(ma.after, 0)} %</strong>, sous votre seuil de ${fmtNum(S.settings.marginMin || 150, 0)} %. ` : '') + `Exposition <strong class="num">${usd(expo)}</strong> · marge ≈ <span class="num">${usd(expo / lv)}</span> · risque initial <strong class="num">${usd(risk)}</strong> (${pct(rp)} de ${usd(ref.value)})${over ? ' · <strong>dépasse le budget de ' + usd(r.budget) + '</strong>' : ''}${expo > r.params.cap + 0.005 ? ' · <strong>dépasse le plafond</strong>' : ''}`;
    },
    onSubmit: async form => {
      const t = F(form, 'ticker').trim().toUpperCase(), date = F(form, 'date');
      const q = num(F(form, 'qty')), p = num(F(form, 'price')), st = num(F(form, 'stop')), fe = numOr(F(form, 'entryFee'), NaN), lv = num(F(form, 'leverage'));
      need(/^[A-Z0-9.\-]{1,12}$/.test(t), 'Ticker invalide (lettres, chiffres, point ou tiret).');
      need(date, 'Date requise.');
      need(p > 0 && q > 0, 'Prix et quantité doivent être positifs.');
      need(st > 0 && st < p, 'Le stop initial doit être positif et inférieur au prix d’achat.');
      need(lv >= 1, 'Levier invalide.');
      need(isNum(fe) && fe >= 0, 'Frais d’entrée invalides.');
      const id = uid(); let imgId = null;
      const file = form.elements.img.files[0];
      if (file) { imgId = 'i' + id; await putImage(imgId, await readImageFile(file)); }
      const estExitFee = Core.feeOut(q, st, f);
      const risk = q * (p - st) + fe + estExitFee;
      S.lots.push({ id, ticker: t, date, price: p, qty: q, leverage: lv, entryFee: fe, estExitFee, stopInitial: st, stopCurrent: st,
        refCapital: ref.value, refDate: ref.date, riskInitial: risk, riskInitialPct: risk / ref.value * 100, riskPlan: ref.value * S.settings.riskPct / 100,
        motif: F(form, 'motif'), motifSet: !!F(form, 'motif'), note: F(form, 'note').trim(), imgId, planOk: null, planComment: '', events: [], smas: smaPicked(form) });
      const smaN = smaToRadar(form, t, smaPicked(form)); if (smaN) refreshRadar();
      const lp = Core.lastPrice(S.prices, t);
      if (!lp || lp.date <= date) addPrice(t, date, p);
      const man = manualSet();
      if (!form.elements.auto.checked) man.add(t); else man.delete(t);
      S.settings.manualTickers = [...man].sort();
      calcDraft = null; tab = 'pos'; openLots.add('p-' + id);
      save('Achat enregistré');
    }
  });
}
function sheetSell(lot) {
  const ls = Core.lotState(lot), f = fees(), last = Core.lastPrice(S.prices, lot.ticker);
  openSheet({
    title: 'Vente ' + lot.ticker, ok: 'Enregistrer la vente',
    body: `<p class="lead">Reste ${qty(ls.rem)} action(s) achetée(s) à ${usd(lot.price)}. Une vente totale clôture la position.</p><div class="fields">
      ${dateInp('date', 'Date', todayISO())}
      ${dec('qty', 'Quantité vendue', ls.rem)}
      ${dec('price', 'Prix de vente ($)', last ? last.price : '')}
      ${dec('fee', 'Frais réels de sortie ($)', '')}
      ${planSel(lot.planOk)}
      <div class="fld wide"><label for="f-planComment">Commentaire</label><input id="f-planComment" name="planComment" value="${esc(lot.planComment || '')}" placeholder="facultatif"></div>
      <div class="fld wide"><label for="f-img">Capture du graphique à la vente</label><input type="file" id="f-img" name="img" accept="image/*"><p class="hint">facultatif</p></div>
    </div><div id="sellCheck" class="banner info"></div>`,
    onInput: form => {
      const q = num(F(form, 'qty')), p = num(F(form, 'price'));
      const feeEl = form.elements.fee;
      if (!feeEl.dataset.touched && q > 0 && p > 0) feeEl.value = Core.roundTo(Core.feeOut(q, p, f), 4);
      const fe = numOr(feeEl.value, 0), box = $('#sellCheck');
      if (!(q > 0 && p > 0)) { box.textContent = 'Saisissez quantité et prix.'; return; }
      box.innerHTML = `Résultat de cette vente : <strong class="num ${cls(q * (p - lot.price) - fe)}">${usd(q * (p - lot.price) - fe, true)}</strong> (frais de sortie déduits)${q >= ls.rem - 1e-9 ? ' · clôture la position' : ''}`;
    },
    onSubmit: async form => {
      const q = num(F(form, 'qty')), p = num(F(form, 'price')), fe = numOr(F(form, 'fee'), 0), date = F(form, 'date');
      need(date, 'Date requise.'); need(date >= lot.date, 'La vente ne peut pas précéder l’achat.');
      need(q > 0 && q <= ls.rem + 1e-9, `Quantité entre 0 et ${qty(ls.rem)}.`);
      need(p > 0, 'Prix invalide.'); need(isNum(fe) && fe >= 0, 'Frais invalides.');
      const id = uid(), file = form.elements.img.files[0]; let imgId = null;
      if (file) { imgId = 'i' + id; await putImage(imgId, await readImageFile(file)); }
      lot.events.push({ id, type: 'sell', date, qty: Math.min(q, ls.rem), price: p, fee: fe, imgId });
      lot.planOk = planVal(F(form, 'planOk')); lot.planComment = F(form, 'planComment').trim();
      const lp = Core.lastPrice(S.prices, lot.ticker);
      if (!lp || lp.date <= date) addPrice(lot.ticker, date, p);
      save(Core.lotState(lot).closed ? 'Position clôturée' : 'Vente partielle enregistrée');
    }
  });
}
function sheetStop(lot) {
  openSheet({
    title: 'Stop actuel ' + lot.ticker, ok: 'Enregistrer',
    body: `<p class="lead">Le risque initial historique (${usd(lot.riskInitial)}) reste inchangé. Laissez vide pour signaler une position sans stop.</p><div class="fields">
      ${dateInp('date', 'Date', todayISO())}${dec('stop', 'Nouveau stop ($)', lot.stopCurrent)}</div>`,
    onSubmit: form => {
      const v = F(form, 'stop').trim(), st = v === '' ? null : num(v);
      need(st === null || st > 0, 'Stop invalide.');
      lot.events.push({ id: uid(), type: 'stop', date: F(form, 'date') || todayISO(), from: isNum(lot.stopCurrent) ? lot.stopCurrent : null, to: st });
      lot.stopCurrent = st;
      save('Stop mis à jour');
    }
  });
}
function sheetAmount(lot, kind) {
  const isF = kind === 'funding';
  openSheet({
    title: (isF ? 'Frais de financement ' : 'Dividende ou ajustement ') + lot.ticker, ok: 'Enregistrer',
    body: `<p class="lead">${isF ? 'Montant réellement débité par le courtier (nombre positif), par exemple le swap cumulé lu dans MT5. Il remplace le swap estimé jusqu’à cette date.' : 'Montant réellement crédité (positif) ou débité (négatif).'}</p><div class="fields">
      ${dateInp('date', 'Date', todayISO())}${dec('amount', 'Montant ($)', '')}
      ${isF ? '' : `<div class="fld"><label for="f-kind">Type</label><select id="f-kind" name="kind"><option value="dividend">Dividende</option><option value="adjust">Ajustement</option></select></div>`}
      <div class="fld wide"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="facultatif"></div></div>`,
    onSubmit: form => {
      const a = num(F(form, 'amount'));
      need(isNum(a) && a !== 0, 'Montant invalide.');
      need(!isF || a > 0, 'Les frais de financement se saisissent en positif.');
      lot.events.push({ id: uid(), type: isF ? 'funding' : F(form, 'kind'), date: F(form, 'date') || todayISO(), amount: a, note: F(form, 'note').trim() });
      save('Mouvement enregistré');
    }
  });
}
function sheetPlan(lot) {
  openSheet({
    title: 'Plan respecté ? ' + lot.ticker, ok: 'Enregistrer',
    body: `<div class="fields">${planSel(lot.planOk)}<div class="fld wide"><label for="f-planComment">Commentaire</label><textarea id="f-planComment" name="planComment">${esc(lot.planComment || '')}</textarea></div></div>`,
    onSubmit: form => { lot.planOk = planVal(F(form, 'planOk')); lot.planComment = F(form, 'planComment').trim(); save('Évaluation enregistrée'); }
  });
}
function sheetSellImg(lot, ev) {
  openSheet({
    title: 'Capture de la vente ' + lot.ticker, ok: 'Enregistrer',
    body: `<p class="lead">Vente du ${fmtDate(ev.date)} : ${qty(ev.qty)} × ${usd(ev.price)}.</p><div class="fields">
      <div class="fld wide"><label for="f-img">${ev.imgId ? 'Remplacer la capture' : 'Ajouter une capture'}</label><input type="file" id="f-img" name="img" accept="image/*">
      ${ev.imgId ? '<label class="check"><input type="checkbox" name="rmImg"> supprimer la capture actuelle</label>' : ''}</div></div>`,
    onSubmit: async form => {
      const file = form.elements.img.files[0], rm = form.elements.rmImg && form.elements.rmImg.checked;
      need(file || rm, 'Choisissez une image.');
      if (ev.imgId) await delImage(ev.imgId);
      ev.imgId = file ? 'i' + uid() : null;
      if (file) await putImage(ev.imgId, await readImageFile(file));
      save(file ? 'Capture enregistrée' : 'Capture supprimée');
    }
  });
}
function sheetEdit(lot) {
  // Ventes déjà saisies : corrigeables ici (date, quantité, prix, frais). Position clôturée : les ventes d'abord.
  const sells = lot.events.filter(e => e.type === 'sell').sort((a, b) => a.date < b.date ? -1 : 1), closed = Core.lotState(lot).closed;
  const sellBox = sells.length ? `<h3 class="chart-t">${sells.length > 1 ? 'Ventes' : 'Vente'}</h3>${sells.map((e, i) => `<div class="fields">
      ${dateInp(`s${i}_date`, sells.length > 1 ? `Date de la vente ${i + 1}` : 'Date de vente', e.date)}${dec(`s${i}_qty`, 'Quantité vendue', e.qty)}
      ${dec(`s${i}_price`, 'Prix de vente ($)', e.price)}${dec(`s${i}_fee`, 'Frais de sortie ($)', Core.roundTo(e.fee || 0, 4))}</div>`).join('')}` : '';
  openSheet({
    title: 'Corriger ' + lot.ticker, ok: 'Enregistrer la correction',
    body: `<p class="lead">Pour corriger une erreur de saisie${sells.length ? ', à l’achat comme à la vente' : ''}. Le risque initial est recalculé à partir des valeurs d’entrée corrigées.</p>
      ${closed ? sellBox : ''}${sells.length ? '<h3 class="chart-t">Achat</h3>' : ''}<div class="fields">
      ${inp('ticker', 'Ticker', lot.ticker, 'autocapitalize="characters"')}${dateInp('date', 'Date d’achat', lot.date)}
      ${dec('price', 'Prix d’achat ($)', lot.price)}${dec('qty', 'Quantité achetée', lot.qty)}${dec('leverage', 'Levier (×)', lot.leverage)}
      ${dec('entryFee', 'Frais d’entrée ($)', lot.entryFee)}${dec('estExitFee', 'Frais de sortie estimés ($)', Core.roundTo(lot.estExitFee || 0, 4), '', 'pour le risque initial')}
      ${dec('stopInitial', 'Stop initial ($)', lot.stopInitial)}${dec('stopCurrent', 'Stop actuel ($)', lot.stopCurrent, 'placeholder="vide = aucun"')}
      ${dec('refCapital', 'Capital de référence ($)', Core.roundTo(lot.refCapital, 2))}
      ${motifField(lot.ticker, lot.date, lot.motifSet ? lot.motif : '')}
      <div class="fld wide"><label for="f-note">Note</label><textarea id="f-note" name="note">${esc(lot.note || '')}</textarea></div>
      <div class="fld wide"><label for="f-img">${lot.imgId ? 'Remplacer la capture' : 'Ajouter une capture'}</label><input type="file" id="f-img" name="img" accept="image/*">
      ${lot.imgId ? '<label class="check"><input type="checkbox" name="rmImg"> supprimer la capture actuelle</label>' : ''}</div></div>${closed ? '' : sellBox}`,
    onSubmit: async form => {
      const t = F(form, 'ticker').trim().toUpperCase(), p = num(F(form, 'price')), q = num(F(form, 'qty')), lv = num(F(form, 'leverage'));
      const fe = numOr(F(form, 'entryFee'), 0), xf = numOr(F(form, 'estExitFee'), 0), si = num(F(form, 'stopInitial'));
      const scv = F(form, 'stopCurrent').trim(), sc = scv === '' ? null : num(scv), rc = num(F(form, 'refCapital')), date = F(form, 'date');
      const sv = sells.map((e, i) => ({ e, date: F(form, `s${i}_date`), qty: num(F(form, `s${i}_qty`)), price: num(F(form, `s${i}_price`)), fee: numOr(F(form, `s${i}_fee`), 0) }));
      sv.forEach((x, i) => { const n = sells.length > 1 ? ` (vente ${i + 1})` : '';
        need(x.date, 'Date de vente requise' + n + '.'); need(x.qty > 0, 'Quantité vendue invalide' + n + '.'); need(x.price > 0, 'Prix de vente invalide' + n + '.'); need(isNum(x.fee) && x.fee >= 0, 'Frais de sortie invalides' + n + '.'); });
      const sold = sv.reduce((a, x) => a + x.qty, 0);
      need(/^[A-Z0-9.\-]{1,12}$/.test(t), 'Ticker invalide.'); need(date, 'Date requise.');
      need(sv.every(x => x.date >= date), 'Une vente ne peut pas précéder la date d’achat.');
      need(lot.events.filter(e => e.type !== 'sell').every(e => e.date >= date), 'Des mouvements sont antérieurs à cette date d’achat.');
      need(p > 0 && q > 0, 'Prix et quantité doivent être positifs.'); need(q >= sold - 1e-9, `Quantité inférieure aux ventes déjà saisies (${qty(sold)}).`);
      need(lv >= 1, 'Levier invalide.'); need(fe >= 0 && xf >= 0, 'Frais invalides.');
      need(si > 0 && si < p, 'Stop initial positif et inférieur au prix.'); need(sc === null || sc > 0, 'Stop actuel invalide.'); need(rc > 0, 'Capital de référence invalide.');
      const file = form.elements.img.files[0];
      if (file) { if (lot.imgId) await delImage(lot.imgId); lot.imgId = 'i' + uid(); await putImage(lot.imgId, await readImageFile(file)); }
      else if (form.elements.rmImg && form.elements.rmImg.checked && lot.imgId) { await delImage(lot.imgId); lot.imgId = null; }
      Object.assign(lot, { ticker: t, date, price: p, qty: q, leverage: lv, entryFee: fe, estExitFee: xf, stopInitial: si, stopCurrent: sc, refCapital: rc, motif: F(form, 'motif') || lot.motif, note: F(form, 'note').trim() });
      if (F(form, 'motif')) lot.motifSet = true;
      lot.riskInitial = q * (p - si) + fe + xf; lot.riskInitialPct = lot.riskInitial / rc * 100;
      for (const x of sv) {
        // Cours enregistré à la vente (même date, même prix) : suit la correction.
        const h = S.prices[lot.ticker] || [], i = h.findIndex(y => y.date === x.e.date && Math.abs(y.price - x.e.price) < 1e-9);
        if (i >= 0 && (x.date !== x.e.date || x.price !== x.e.price)) { h.splice(i, 1); addPrice(t, x.date, x.price); }
        Object.assign(x.e, { date: x.date, qty: x.qty, price: x.price, fee: x.fee });
      }
      save(closed && !Core.lotState(lot).closed ? 'Correction enregistrée · la position est de nouveau ouverte (ventes inférieures à l’achat)' : 'Correction enregistrée');
    }
  });
}
function sheetPrices() {
  const tickers = [...new Set(S.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker))].sort();
  openSheet({
    title: 'Mettre à jour les cours', ok: 'Enregistrer les cours',
    body: `<p class="lead">Cours de clôture lus dans MT5. Saisir tous les tickers à la même date crée une observation exacte pour la performance.</p>
      <div class="fields">${dateInp('date', 'Date des cours', todayISO())}</div>
      <div class="search"><input type="search" id="price-q" placeholder="Rechercher une action" autocomplete="off" autocapitalize="characters" aria-label="Rechercher une action"></div>
      ${(() => {
        // Avec Finnhub, les actions en saisie manuelle passent en premier : ce sont les seules à taper chaque soir.
        const auto = quoteKey(), man = manualSet();
        const row = t => { const lp = Core.lastPrice(S.prices, t);
          return `<label class="pr" data-t="${esc(t.toLowerCase())}" for="f-p_${esc(t)}"><span class="tk">${esc(t)}</span><small>${lp ? usd(lp.price) + ' · ' + fmtDate(lp.date).replace(/ \d{4}$/, '') : 'aucun cours'}</small><input id="f-p_${esc(t)}" name="p_${esc(t)}" inputmode="decimal" autocomplete="off" placeholder="${lp ? fmtNum(lp.price, 4) : ''}"></label>`; };
        if (!auto) return `<div class="plist">${tickers.map(row).join('')}</div>`;
        const m = tickers.filter(t => man.has(t)), a = tickers.filter(t => !man.has(t));
        return `${m.length ? `<h3 class="chart-t">À saisir à la main (${m.length})</h3><div class="plist">${m.map(row).join('')}</div>` : ''}
          <details class="more" ${m.length ? '' : 'open'}><summary>Cours automatiques Finnhub (${a.length})</summary><p class="hint" style="margin-bottom:8px">Enregistrés tout seuls à la clôture. À remplir seulement pour corriger.</p><div class="plist">${a.map(row).join('')}</div></details>`;
      })()}
      <p class="hint">Case vide : le cours n’est pas modifié.</p>`,
    onSubmit: form => {
      const date = F(form, 'date'); need(date, 'Date requise.'); need(date <= todayISO(), 'Date dans le futur.');
      let n = 0;
      for (const t of tickers) {
        const v = F(form, 'p_' + t).trim(); if (v === '') continue;
        const p = num(v); need(p > 0, 'Cours invalide pour ' + t + '.');
        addPrice(t, date, p); n++;
      }
      need(n > 0, 'Saisissez au moins un cours.');
      save(n === tickers.length ? 'Cours enregistrés · observation de performance créée' : `${n} cours enregistré(s) · pas d’observation complète`);
    }
  });
}
function sheetCatchup() {
  openSheet({
    title: 'Rattrapage de résultat', ok: 'Enregistrer',
    body: `<p class="lead">Gains ou pertes déjà réalisés chez le courtier mais pas saisis trade par trade. Comptés dans la valeur et la performance, pas dans les statistiques de trades. Différent d’un retrait : un retrait ne change pas votre performance, un rattrapage oui.</p>
      <div class="fields">${dateInp('date', 'Date', todayISO())}<div class="fld"><label for="f-sign">Type</label><select id="f-sign" name="sign"><option value="-1">Perte</option><option value="1">Gain</option></select></div>${dec('amount', 'Montant ($)', '')}
      <div class="fld wide"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="Trades clôturés avant le carnet (MT5)"></div></div>`,
    onSubmit: form => {
      const m = num(F(form, 'amount')); need(isNum(m) && m > 0, 'Montant positif requis : choisissez Perte ou Gain.');
      const a = Math.abs(m) * (F(form, 'sign') === '1' ? 1 : -1);
      const d = F(form, 'date') || todayISO(); need(d >= S.settings.startDate, 'Date à partir du départ du compte (' + fmtDate(S.settings.startDate) + ').');
      S.flows.push({ id: uid(), kind: 'pnl', date: d, amount: Core.roundTo(a, 2), note: F(form, 'note').trim() || 'Rattrapage' });
      save('Rattrapage enregistré : ' + usd(a, true));
    }
  });
}
function sheetFlow() {
  openSheet({
    title: 'Versement ou retrait', ok: 'Enregistrer',
    body: `<div class="fields">${dateInp('date', 'Date', todayISO())}
      <div class="fld"><label for="f-kind">Type</label><select id="f-kind" name="kind"><option value="dep">Versement</option><option value="wd">Retrait</option></select></div>
      ${dec('amount', 'Montant ($)', '')}<div class="fld wide"><label for="f-note">Note</label><input id="f-note" name="note" placeholder="facultatif"></div></div>`,
    onSubmit: form => {
      const a = num(F(form, 'amount')); need(a > 0, 'Montant positif requis.');
      S.flows.push({ id: uid(), date: F(form, 'date') || todayISO(), amount: F(form, 'kind') === 'wd' ? -a : a, note: F(form, 'note').trim() });
      save('Flux enregistré');
    }
  });
}
// ----- Santé des données : contrôles à chaque affichage, rien n'est corrigé sans l'utilisateur -----
// lvl : 'imp' (fausse la valeur ou la performance), 'chk' (fausse un détail), 'stat' (statistiques).
const radarSkip = () => new Set((S.settings.radarSkip || []).map(t => String(t).toUpperCase()));
function healthChecks() {
  const out = [], today = todayISO(), start = S.settings.startDate, real = S.lots.filter(l => !l.demo);
  const open = real.filter(l => !Core.lotState(l).closed), closed = real.filter(l => Core.lotState(l).closed && l.date >= start);
  const btn = (label, act, data) => ({ label, act, data: data || {} });
  const inRadar = t => S.watch.some(w => w.ticker === t && !w.idx), skip = radarSkip();   // skip : actions que vous ne voulez pas au radar (hors USA…)
  const lb = latestBroker();
  if (lb && !lb.demo) {
    const a = Core.accountState(S, lb.date, 'last'), g = a.equity > 0 ? (lb.netValue - a.equity) / a.equity * 100 : 0;
    if (Math.abs(g) > 1) out.push({ lvl: 'imp', title: `Écart de ${fmtNum(Math.abs(g), 1)} % avec MT5 au ${fmtDate(lb.date)}`, sub: `App ${usd(a.equity)} · MT5 ${usd(lb.netValue)}. Causes habituelles : trades clôturés absents de l’app, swap réel plus élevé que l’estimation, capital de départ.`, btn: btn('Refaire le rapprochement', 'add-snap') });
    if (isNum(lb.marginUsed) && a.margin > 0 && Math.abs(lb.marginUsed - a.margin) / a.margin > 0.1) {
      const lv = {}; for (const l of open) lv[l.leverage] = (lv[l.leverage] || 0) + 1;
      out.push({ lvl: 'imp', title: `Marge estimée ${fmtNum(Math.abs(a.margin / lb.marginUsed - 1) * 100, 0)} % ${a.margin > lb.marginUsed ? 'au-dessus' : 'en dessous'} de MT5`, sub: `App ${usd(a.margin)} · MT5 ${usd(lb.marginUsed)}. Leviers enregistrés : ${Object.entries(lv).map(([k, n]) => `×${fmtNum(+k)} (${n})`).join(', ')}. Comparez avec le levier de chaque action chez le courtier (Corriger › Levier).`, btn: btn('Voir les positions', 'go-tab', { tab: 'pos' }) });
    }
  }
  const noStop = open.filter(l => !(l.stopCurrent > 0));
  if (noStop.length) out.push({ lvl: 'imp', title: `${noStop.length} position(s) ouverte(s) sans stop`, sub: noStop.map(l => esc(l.ticker)).join(', ') + ' : risque non borné, absent du panneau de risque.', btn: btn('Mettre un stop', 'stop', { lot: noStop[0].id }) });
  // Jours de détention sans cours, même après le cours reporté et l'historique du radar.
  const pp = perfPrices(), days = [...new Set(Object.values(S.prices).flat().map(x => x.date))].filter(d => d >= start && d <= today && wdOf(d) >= 1 && wdOf(d) <= 5).sort();
  const gaps = [];
  for (const l of real) {
    const ls = Core.lotState(l), end = ls.closed ? ls.closeDate : today, have = new Set((pp.prices[l.ticker] || []).map(x => x.date));
    const miss = days.filter(d => d >= l.date && d < end && !have.has(d)).length;
    if (miss >= 3) gaps.push([l, miss]);
  }
  if (gaps.length) out.push({ lvl: 'imp', title: `${gaps.length} position(s) avec des jours sans cours`, sub: gaps.slice(0, 6).map(([l, n]) => `${esc(l.ticker)} : ${n} jour(s)`).join(' · ') + '. Ces jours sont écartés de la performance. L’historique du radar les complète si l’action y est.', btn: inRadar(gaps[0][0].ticker) || skip.has(gaps[0][0].ticker) ? btn('Mettre à jour les cours', 'prices') : btn(`Ajouter ${gaps[0][0].ticker} au radar`, 'health-radar', { t: gaps[0][0].ticker }) });
  // Cours enregistré le jour d'une vente (saisie à la main) différent du prix de vente : reste d'une saisie corrigée.
  for (const l of real) for (const e of l.events.filter(x => x.type === 'sell')) {
    const pr = (S.prices[l.ticker] || []).find(x => x.date === e.date); if (!pr || pr.src) continue;
    const sales = real.filter(m => m.ticker === l.ticker).flatMap(m => m.events.filter(x => x.type === 'sell' && x.date === e.date).map(x => x.price));
    if (sales.every(p => Math.abs(pr.price / p - 1) > 0.005) && !out.some(o => o.key === l.ticker + e.date))
      out.push({ key: l.ticker + e.date, lvl: 'chk', title: `${esc(l.ticker)} : cours du ${fmtDate(e.date)} (${usd(pr.price)}) ≠ prix de vente (${usd(e.price)})`, sub: 'Reste d’une saisie corrigée. Sans effet sur le résultat de la position, mais faux dans l’historique des cours.', btn: btn(`Remplacer par ${usd(e.price)}`, 'health-px', { t: l.ticker, d: e.date, p: e.price }) });
  }
  const noRadar = [...new Set(closed.concat(open).map(l => l.ticker))].filter(t => !inRadar(t) && !skip.has(t));
  if (noRadar.length) out.push({ lvl: 'chk', title: `${noRadar.length} action(s) de vos trades absente(s) du radar`, sub: noRadar.map(esc).join(', ') + ' : pas d’analyse de sortie, pas de cours de secours pour la performance.', btn: btn(`Ajouter ${noRadar[0]} au radar`, 'health-radar', { t: noRadar[0] }), btn2: btn(`Ne plus signaler ${noRadar[0]}`, 'health-noradar', { t: noRadar[0] }) });
  if (open.length && (S.settings.swap || {}).pct > 0 && !open.some(l => l.events.some(e => e.type === 'funding')))
    out.push({ lvl: 'chk', title: 'Swap jamais remplacé par le réel', sub: `Estimé à ${fmtNum(S.settings.swap.pct, 2)} % par an. Saisissez le swap total de MT5 dans le rapprochement et cochez « Remplacer le swap estimé ».`, btn: btn('Saisir le swap MT5', 'add-snap') });
  const lim = S.settings.staleDays || 4, stale = open.filter(l => { const lp = Core.lastPrice(S.prices, l.ticker); return !lp || Core.days(lp.date, lastWeekday(today)) > lim; });
  if (stale.length) out.push({ lvl: 'chk', title: `${stale.length} position(s) avec un cours de plus de ${lim} jours`, sub: [...new Set(stale.map(l => esc(l.ticker)))].join(', '), btn: btn('Mettre à jour les cours', 'prices') });
  const seen = new Map(), dup = [];
  for (const l of real) { const k = [l.ticker, l.date, l.qty, l.price].join('|'); if (seen.has(k)) dup.push(l); else seen.set(k, l); }
  if (dup.length) out.push({ lvl: 'chk', title: `${dup.length} doublon(s) possible(s)`, sub: dup.map(l => `${esc(l.ticker)} du ${fmtDate(l.date)}`).join(', ') + ' : même action, même date, même quantité et même prix.', btn: btn('Corriger', 'edit-lot', { lot: dup[0].id }) });
  const early = real.filter(l => l.date < start);
  if (early.length) out.push({ lvl: 'chk', title: `${early.length} achat(s) avant la date de départ`, sub: `Date de départ : ${fmtDate(start)}. Ces positions faussent la performance.`, btn: btn('Corriger', 'edit-lot', { lot: early[0].id }) });
  const unsorted = real.filter(l => !l.motifSet);
  if (unsorted.length >= 3) out.push({ lvl: 'stat', title: `${unsorted.length} trade(s) sans motif choisi`, sub: 'Le bilan par motif ne peut rien vous apprendre tant qu’ils ne sont pas classés. Une pastille par trade, suggestions du radar comprises.', btn: btn('Classer mes trades', 'motif-sort') });
  const noPlan = closed.filter(l => l.planOk !== true && l.planOk !== false);
  if (noPlan.length) out.push({ lvl: 'stat', title: `${noPlan.length} trade(s) clôturé(s) sans « Plan respecté ? »`, sub: noPlan.map(l => esc(l.ticker)).join(', '), btn: btn('Renseigner', 'plan', { lot: noPlan[0].id }) });
  const noSect = [...new Set(open.map(l => l.ticker))].filter(t => !sectorOf(t));
  if (noSect.length) out.push({ lvl: 'stat', title: `${noSect.length} action(s) sans secteur sur cet appareil`, sub: quoteKey() ? 'Recherche automatique en cours (Finnhub, une douzaine à la fois).' : 'Ils arrivent depuis l’appareil qui a la clé Finnhub, ou touchez une ligne de la carte Diversification pour les choisir.' });
  return out;
}
const HLVL = { imp: ['Important · fausse la valeur et la performance', 'err'], chk: ['À vérifier · fausse un détail', 'warn'], stat: ['Pour les statistiques', 'mut'] };
function healthCard() {
  const H = healthChecks();
  const skOnly = [...radarSkip()].sort();
  if (!H.length) return `<section class="card" id="health"><div class="sec-head"><h2>Santé des données</h2><span class="pill win">Tout est bon</span></div><p class="hint">Aucun point à vérifier.</p>${skOnly.length ? `<p class="hint">Jamais proposées au radar : ${skOnly.map(esc).join(', ')}. <button class="btn sm" data-act="health-noradar-reset">Signaler à nouveau</button></p>` : ''}</section>`;
  const b1 = y => `<button class="btn sm" data-act="${y.act}"${Object.entries(y.data).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('')}>${y.label}</button>`;
  const b = x => x.btn ? (x.btn2 ? `<div class="row">${b1(x.btn)}${b1(x.btn2)}</div>` : b1(x.btn)) : '';
  const sk = [...radarSkip()].sort(), skLine = sk.length ? `<p class="hint">Jamais proposées au radar : ${sk.map(esc).join(', ')}. <button class="btn sm" data-act="health-noradar-reset">Signaler à nouveau</button></p>` : '';
  return `<section class="card" id="health"><div class="sec-head"><h2>Santé des données</h2><span class="pill ${H.some(x => x.lvl === 'imp') ? 'loss' : 'warn'}">${H.length} point(s)</span></div>
    <p class="hint" style="margin-top:0">Vérifié à chaque affichage. Rien n’est corrigé sans vous.</p>
    ${['imp', 'chk', 'stat'].map(k => { const g = H.filter(x => x.lvl === k); if (!g.length) return ''; return `<p class="hlv ${HLVL[k][1]}">${HLVL[k][0]}</p>${g.map(x => `<div class="hit"><i class="hd ${HLVL[k][1]}"></i><div><b>${x.title}</b><small>${x.sub}</small>${b(x)}</div></div>`).join('')}`; }).join('')}
    ${skLine}
  </section>`;
}
function healthBanner() {
  const n = healthChecks().filter(x => x.lvl === 'imp').length; if (!n) return '';
  return `<div class="banner err"><span><strong>Santé des données</strong> : ${n} point(s) important(s) faussent vos chiffres.</span><button class="btn sm" data-act="go-health">Voir</button></div>`;
}
// ----- Motifs : pastilles en un geste, suggestion d'après le radar, liste modifiable -----
// auto : 'cross' (clôture passée au-dessus d'une de vos SMA dans les 3 bougies avant l'achat), 'near' (au-dessus et proche d'une SMA).
const MOTIF_DEF = [{ k: 'xsma', l: 'Croisement SMA', auto: 'cross' }, { k: 'rsma', l: 'Rebond sur SMA', auto: 'near' }, { k: 'cassure', l: 'Cassure' }, { k: 'continuation', l: 'Continuation' }, { k: 'autre', l: 'Autre' }];
const motifList = () => Array.isArray(S.settings.motifs) && S.settings.motifs.length ? S.settings.motifs : MOTIF_DEF;
function motifsSync() {
  const m = {}; for (const x of motifList()) m[x.k] = x.l;
  for (const l of S.lots) if (l.motif && !m[l.motif]) m[l.motif] = MOTIFS_OLD[l.motif] || l.motif;
  MOTIFS = m;
}
function motifSuggest(t, date) {
  t = String(t || '').toUpperCase(); const bars = t && tickerBars(t); if (!bars) return null;
  const pre = bars.filter(b => b[0] < date); if (pre.length < 30) return null;
  const nearPct = S.settings.nearPct || 2; let got = null;
  for (const w of S.watch.filter(x => x.ticker === t && !x.idx)) {
    const c = []; let k0 = null;
    for (const [d, x] of pre) { const k = periodKey(w.tf, d); if (k === k0) c[c.length - 1] = x; else { c.push(x); k0 = k; } }
    if (w.tf !== 'D' && periodKey(w.tf, pre[pre.length - 1][0]) === periodKey(w.tf, date)) c.pop();   // bougie S/M de l'achat pas encore complétée
    const n = c.length, P = w.period; if (n < P + 4) continue;
    const sma = j => { let t2 = 0; for (let i = j - P + 1; i <= j; i++) t2 += c[i]; return t2 / P; };
    const last = n - 1, above = c[last] > sma(last);
    if (above && [1, 2, 3].some(i => c[last - i] <= sma(last - i))) { got = { auto: 'cross', w }; break; }
    if (above && !got && (c[last] / sma(last) - 1) * 100 <= nearPct) got = { auto: 'near', w };
  }
  if (!got) return null;
  const m = motifList().find(x => x.auto === got.auto); if (!m) return null;
  return { k: m.k, why: `${got.auto === 'cross' ? 'clôture passée au-dessus de' : 'clôture au-dessus et proche de'} la SMA ${TF_SHORT[got.w.tf]} ${got.w.period}` };
}
// Pastilles (boutons radio) ; sug : motif suggéré, en pointillé.
const motifChips = (name, cur, sug) => `<div class="mchips" role="radiogroup">${Object.entries(MOTIFS).filter(([k]) => motifList().some(x => x.k === k) || k === cur).map(([k, l]) => `<label class="mchip${sug === k ? ' sg' : ''}"><input type="radio" name="${name}" value="${k}" ${cur === k ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>`;
function motifField(t, date, cur) {
  const sg = motifSuggest(t, date), pick = cur || (sg ? sg.k : '');
  return `<div class="fld wide"><label>Motif</label>${motifChips('motif', pick, sg && sg.k)}${sg ? `<p class="hint sgh">Suggéré d’après le radar : ${esc(sg.why)}${cur && cur !== sg.k ? ' (votre choix est gardé)' : ''}.</p>` : ''}</div>`;
}
function sheetMotifSort() {
  const lots = S.lots.filter(l => !l.demo).sort((a, b) => a.date < b.date ? 1 : -1);
  const sug = new Map(lots.map(l => [l.id, motifSuggest(l.ticker, l.date)]));
  const done = () => lots.filter(l => l.motifSet).length;
  openSheet({ title: 'Classer vos trades', ok: 'Enregistrer',
    body: `<p class="lead">Une pastille par trade. En pointillé : la suggestion du radar à la date d’achat. Rien n’est enregistré avant « Enregistrer ».</p>
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><span id="msortN" class="hint" style="margin:0"></span><button type="button" class="btn sm" data-act="motif-accept">Accepter les suggestions</button></div>
      ${lots.map(l => { const ls = Core.lotState(l), R = lotR(l, ls), sg = sug.get(l.id);
        return `<div class="msrow" data-id="${l.id}"><div class="msh"><b>${esc(l.ticker)}</b><span class="${R == null ? 'muted' : cls(R)}">${fmtDate(l.date)}${R == null ? ' · en cours' : ' · ' + fR(R)}</span></div>${motifChips('m_' + l.id, l.motifSet ? l.motif : '', sg && sg.k)}</div>`; }).join('')}`,
    onInput: form => { const n = lots.filter(l => form.querySelector(`input[name="m_${l.id}"]:checked`)).length; const el = $('#msortN'); if (el) el.textContent = `${n} / ${lots.length} classés`; },
    onSubmit: form => {
      let n = 0;
      for (const l of lots) { const r = form.querySelector(`input[name="m_${l.id}"]:checked`); if (!r) continue; if (l.motif !== r.value || !l.motifSet) n++; l.motif = r.value; l.motifSet = true; }
      save(n ? `${n} trade(s) classé(s)` : 'Aucun changement');
    } });
  window.__msortSug = sug;
}
function sheetMotifs() {
  const L = motifList(), used = k => S.lots.some(l => l.motif === k);
  openSheet({ title: 'Mes motifs', ok: 'Enregistrer',
    body: `<p class="lead">Renommez vos motifs ou ajoutez les vôtres (6 au plus, pour garder des groupes assez grands dans le bilan). Videz un nom pour retirer un motif inutilisé.</p><div class="fields">
      ${L.map((m, i) => inp('m' + i, m.auto ? `${m.auto === 'cross' ? 'Suggéré quand la clôture croise une SMA' : 'Suggéré quand le cours est proche d’une SMA'}` : 'Motif', m.l)).join('')}
      ${L.length < 6 ? inp('mnew', 'Nouveau motif', '', 'placeholder="facultatif"') : ''}</div>`,
    onSubmit: form => {
      const out = [];
      L.forEach((m, i) => { const v = F(form, 'm' + i).trim(); if (v) out.push(Object.assign({}, m, { l: v })); else need(!used(m.k), `« ${m.l} » est utilisé par des positions : gardez-le ou renommez-le.`); });
      const nv = F(form, 'mnew').trim(); if (nv) { need(out.length < 6, '6 motifs au plus.'); out.push({ k: 'm' + uid(), l: nv }); }
      need(out.length >= 2, 'Gardez au moins 2 motifs.');
      S.settings.motifs = out; motifsSync(); save('Motifs enregistrés');
    } });
}
// ----- À propos : version, tests automatiques (build.json écrit par GitHub Actions), historique -----
let BuildInfo = null, buildAsked = false;
function aboutCard() {
  if (!buildAsked) {
    buildAsked = true;
    fetch('./build.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : false).catch(() => false).then(j => { BuildInfo = j || false; if (tab === 'set') render(); });
  }
  const b = BuildInfo, ok = b && b.total > 0 && b.passed === b.total;
  const tests = b === null ? 'Chargement…' : !b ? 'Non disponibles' : `<span class="${ok ? 'pos' : 'neg'}">${b.passed} / ${b.total} réussis</span> · ${fmtDate(String(b.date).slice(0, 10))}`;
  return `<section class="card"><div class="sec-head"><h2>À propos</h2></div><dl class="kv">
    ${kv('Version', '__APP_VERSION__')}
    ${kv('Tests automatiques', tests, b ? 'calculateur, positions, swap, performance, radar, rapprochement MT5, risque : vérifiés avant chaque mise en ligne' : b === false ? 'publication directe sans tests : GitHub › Settings › Pages › Source : « GitHub Actions » pour les activer' : '')}
    ${kv('Nouveautés', '<a href="https://github.com/clairnet1905/carnet-de-positions/commits/main" target="_blank" rel="noopener">Voir l’historique</a>', 'chaque changement, sur GitHub')}
  </dl></section>`;
}
// ----- Rapprochement avec MT5 : fonds propres, marge et swap lus dans MT5, comparés au calcul de l'app -----
const MT5_SNOOZE = 'carnet-positions:mt5-plus-tard';
const lastWeekday = d => { while (wdOf(d) === 0 || wdOf(d) === 6) d = addDays(d, -1); return d; };
// Swap des positions ouvertes à la date D : saisi (Financement) + estimé, et la part saisie à la main.
// Même convention que la valeur du compte à la date D (Core.accountState) : nuits avant D, pour que l'écart App / MT5 tombe juste.
function swapBook(D) {
  const rows = [];
  for (const lot of S.lots) {
    if (lot.date > D) continue;
    const ls = Core.lotState(lot, D); if (ls.rem <= 1e-9) continue;
    const man = lot.events.filter(e => e.type === 'funding' && e.date <= D).reduce((a, e) => a + e.amount, 0);
    rows.push({ lot, cur: ls.funding, man, est: ls.fundingEst, expo: ls.rem * lot.price });
  }
  return { rows, tot: rows.reduce((a, r) => a + r.cur, 0), allEst: rows.every(r => Math.abs(r.man) < 0.005) };
}
// ----- Import du rapport d'historique MT5 (PDF partagé depuis MT5, ou texte collé) -----
// Lu sur l'appareil, rien n'est envoyé. Compare au carnet à partir du dernier rapprochement ; rien n'est modifié sans case cochée.
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const loadScript = src => new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ko(new Error('Lecteur PDF indisponible (connexion ?). Collez plutôt le texte du rapport.')); document.head.appendChild(s); });
// Texte du PDF ligne par ligne : morceaux regroupés par hauteur, puis triés de gauche à droite.
async function pdfText(file) {
  if (!window.pdfjsLib) await loadScript(PDFJS + 'pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent(), rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5]; let r = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!r) rows.push(r = { y, it: [] });
      r.it.push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) { r.it.sort((a, b) => a.x - b.x); let line = '', end = null; for (const t of r.it) { line += (end != null && t.x - end > 0.8 ? ' ' : '') + t.s; end = t.x + t.w; } out.push(line); }
  }
  return out.join('\n');
}
// Le solde de chaque ligne doit suivre le précédent : sinon une ligne n'a pas été lue.
function mt5Breaks(rep) {
  const ev = rep.deals.map(d => [d.date + d.time + d.id, d.profit + d.comm + d.fee + d.swap, d.bal]).concat(rep.ops.map(o => [o.date + o.time + o.id, o.amount, o.bal])).sort((a, b) => a[0] < b[0] ? -1 : 1);
  let n = 0; for (let i = 1; i < ev.length; i++) if (ev[i][2] != null && ev[i - 1][2] != null && Math.abs(ev[i - 1][2] + ev[i][1] - ev[i][2]) > 0.011) n++;
  return n;
}
function mt5Since() {
  const m = S.settings.mt5; if (m && m.upTo) return m.upTo;
  return S.flows.filter(f => f.kind === 'pnl').map(f => f.date).sort().pop() || S.settings.startDate;
}
// Date de la photo du compte : dernière séance close à l'édition du rapport (heure du serveur MT5, clôture US vers 23 h).
const mt5SnapDate = rep => !rep.gen ? rep.to : lastWeekday(wdOf(rep.gen.date) >= 1 && wdOf(rep.gen.date) <= 5 && rep.gen.time < '23:00' ? addDays(rep.gen.date, -1) : rep.gen.date);
// Écarts entre le rapport et le carnet. Chaque ligne : { g (groupe), txt, on (cochée par défaut), fix (st => void) } ; sans fix : information.
function mt5Diff(rep, since) {
  const real = S.lots.filter(l => !l.demo), have = new Set(real.map(l => l.ticker));
  const tk = sym => { if (have.has(sym)) return sym; const b = Core.mt5Ticker(sym); return b; };
  const out = [], ign = new Set(), used = new Set(), pend = {}, lotSw = new Map(), simRem = {}, cnt = { sellOk: 0, buyOk: 0, divOk: 0, opOk: 0, openOk: 0 };
  const dd = (a, b) => Math.abs(Core.days(a, b)), px = (a, b) => Math.abs(a - b) <= Math.max(0.011, b * 0.005);
  const L = id => (st => st.lots.find(l => l.id === id));
  const deals = rep.deals.filter(d => d.date > since);
  // Ventes de positions longues
  for (const d of deals.filter(d => d.dir === 'out')) {
    const t = tk(d.sym); if (!t || d.type !== 'sell') { ign.add(d.sym); continue; }
    const cand = [];
    for (const l of real.filter(l => l.ticker === t)) for (const e of l.events) if (e.type === 'sell' && !used.has(e.id) && dd(e.date, d.date) <= 1 && px(e.price, d.price)) cand.push([l, e]);
    const one = cand.find(([, e]) => Math.abs(e.qty - d.vol) < 1e-6), sum = cand.reduce((a, [, e]) => a + e.qty, 0);
    const hit = one ? [one] : cand.length && Math.abs(sum - d.vol) < 1e-6 ? cand : null;
    const realFee = Core.roundTo(-(d.comm + d.fee), 2);
    if (hit) {
      cnt.sellOk++; hit.forEach(([l, e]) => { used.add(e.id); (lotSw.get(l.id) || lotSw.set(l.id, []).get(l.id)).push([e.date, d.swap * e.qty / d.vol]); });
      const appFee = hit.reduce((a, [, e]) => a + (e.fee || 0), 0);
      if (Math.abs(appFee - realFee) > 0.005) { const ids = hit.map(([l, e]) => [l.id, e.id, e.qty]);
        out.push({ g: 'fee', txt: `${esc(t)} vente du ${fmtDate(d.date)} : frais ${usd(appFee)} → <b>${usd(realFee)}</b>`, on: true,
          fix: st => { for (const [li, ei, q] of ids) { const e = st.lots.find(l => l.id === li).events.find(x => x.id === ei); e.fee = Core.roundTo(realFee * q / d.vol, 4); } } }); }
      continue;
    }
    const rem = real.filter(l => l.ticker === t && l.date <= d.date).reduce((a, l) => a + Core.lotState(l).rem, 0);
    if (rem < d.vol - 1e-6) { out.push({ g: 'sell', txt: `<b>${esc(t)}</b> ${fmtDate(d.date)} · ${qty(d.vol)} à ${usd(d.price)} : ${rem > 0 ? `seulement ${qty(rem)} ouverte(s) dans l’app` : 'aucune position ouverte dans l’app'}` }); continue; }
    pend[t] = (pend[t] || 0) + d.vol;
    { let q = d.vol; for (const l of real.filter(l => l.ticker === t && l.date <= d.date).sort((a, b) => a.date < b.date ? -1 : 1)) {   // même répartition que l'application de la vente
      if (simRem[l.id] == null) simRem[l.id] = Core.lotState(l).rem; const k = Math.min(q, simRem[l.id]); if (q <= 1e-9 || k <= 1e-9) continue;
      simRem[l.id] -= k; q -= k; (lotSw.get(l.id) || lotSw.set(l.id, []).get(l.id)).push([d.date, d.swap * k / d.vol]); } }
    out.push({ g: 'sell', txt: `<b>${esc(t)}</b> ${fmtDate(d.date)} · ${qty(d.vol)} à ${usd(d.price)} · résultat MT5 ${usd(d.profit, true)}`, on: true,
      fix: st => { let q = d.vol; for (const l of st.lots.filter(l => l.ticker === t && !l.demo && l.date <= d.date).sort((a, b) => a.date < b.date ? -1 : 1)) {
        const r = Core.lotState(l).rem; if (q <= 1e-9 || r <= 1e-9) continue; const k = Math.min(q, r);
        l.events.push({ id: uid(), type: 'sell', date: d.date, qty: k, price: d.price, fee: Core.roundTo(realFee * k / d.vol, 4), mt5: d.id }); q -= k; } } });
  }
  // Swap réel des positions clôturées : MT5 prend tout le swap à la vente. Seulement si toutes les ventes du lot sont dans le rapport, après la date de comparaison.
  const swFix = [];
  for (const l of real) {
    const sh = lotSw.get(l.id); if (!sh) continue;
    const sells = l.events.filter(e => e.type === 'sell');
    if (sells.some(e => !used.has(e.id))) continue;
    const rem = simRem[l.id] != null ? simRem[l.id] : Core.lotState(l).rem; if (rem > 1e-9) continue;
    const realSw = Core.roundTo(-sh.reduce((a, x) => a + x[1], 0), 2), man = l.events.filter(e => e.type === 'funding').reduce((a, e) => a + e.amount, 0);
    const end = sh.map(x => x[0]).concat(sells.map(e => e.date)).sort().pop(), est = Core.lotState(l).funding;
    if (Math.abs(realSw - man) < 0.005 && Math.abs(realSw - est) < 0.005) continue;
    swFix.push({ id: l.id, t: l.ticker, realSw, man, end, est: simRem[l.id] != null ? null : est });
  }
  if (swFix.length) { const known = swFix.filter(f => f.est != null);
    out.push({ g: 'swap', txt: `${swFix.length} trade(s) clôturé(s) : swap ${known.length ? `estimé ${usd(known.reduce((a, f) => a + f.est, 0))}${known.length < swFix.length ? ' (+ ventes à ajouter)' : ''} → ` : ''}réel <b>${usd(swFix.reduce((a, f) => a + f.realSw, 0))}</b> <small>(${swFix.slice(0, 6).map(f => esc(f.t)).join(', ')}${swFix.length > 6 ? '…' : ''})</small>`, on: true,
      fix: st => { for (const f of swFix) { const amt = Core.roundTo(f.realSw - f.man, 2); if (Math.abs(amt) >= 0.005) st.lots.find(l => l.id === f.id).events.push({ id: uid(), type: 'funding', date: f.end, amount: amt, note: 'Swap réel MT5 (vente)' }); } } }); }
  for (const l of real) for (const e of l.events) if (e.type === 'sell' && e.date > since && e.date <= rep.to && !used.has(e.id))
    out.push({ g: 'sell', txt: `<b>${esc(l.ticker)}</b> vente du ${fmtDate(e.date)} · ${qty(e.qty)} à ${usd(e.price)} : dans l’app, pas dans MT5`, lot: l.id });
  // Achats
  const usedL = new Set();
  for (const d of deals.filter(d => d.dir === 'in')) {
    const t = tk(d.sym); if (!t || d.type !== 'buy') { ign.add(d.sym); continue; }
    const l = real.find(l => l.ticker === t && !usedL.has(l.id) && dd(l.date, d.date) <= 1 && Math.abs(l.qty - d.vol) < 1e-6 && px(l.price, d.price));
    if (!l) { out.push({ g: 'buy', txt: `<b>${esc(t)}</b> ${fmtDate(d.date)} · ${qty(d.vol)} à ${usd(d.price)} : absent de l’app, à saisir avec son stop (Calculateur)` }); continue; }
    cnt.buyOk++; usedL.add(l.id);
    const realFee = Core.roundTo(-(d.comm + d.fee), 2);
    if (Math.abs((l.entryFee || 0) - realFee) > 0.005) out.push({ g: 'fee', txt: `${esc(t)} achat du ${fmtDate(d.date)} : frais ${usd(l.entryFee || 0)} → <b>${usd(realFee)}</b>`, on: true, fix: st => { L(l.id)(st).entryFee = realFee; } });
  }
  for (const l of real) if (l.date > since && l.date <= rep.to && !usedL.has(l.id)) out.push({ g: 'buy', txt: `<b>${esc(l.ticker)}</b> achat du ${fmtDate(l.date)} · ${qty(l.qty)} à ${usd(l.price)} : dans l’app, pas dans MT5`, lot: l.id });
  // Dividendes et opérations de solde
  for (const o of rep.ops.filter(o => o.date > since)) {
    if (o.kind === 'dividend') {
      const t = o.sym ? tk(o.sym) : null;
      if (!t) { out.push({ g: 'div', txt: `Dividende ${usd(o.amount, true)} du ${fmtDate(o.date)} : action non reconnue (${esc(o.comment)})` }); continue; }
      const ex = real.some(l => l.ticker === t && l.events.some(e => (e.type === 'dividend' || e.type === 'adjust') && !used.has(e.id) && dd(e.date, o.date) <= 5 && Math.abs(e.amount - o.amount) < 0.011 && used.add(e.id)));
      if (ex) { cnt.divOk++; continue; }
      const ls = real.filter(l => l.ticker === t && l.date < o.date), lot = ls.find(l => Core.lotState(l, addDays(o.date, -1)).rem > 0) || ls.sort((a, b) => a.date < b.date ? 1 : -1)[0];
      if (!lot) { out.push({ g: 'div', txt: `<b>${esc(t)}</b> dividende ${usd(o.amount, true)} du ${fmtDate(o.date)} : action absente du carnet` }); continue; }
      out.push({ g: 'div', txt: `<b>${esc(t)}</b> ${fmtDate(o.date)} · ${usd(o.amount, true)}`, on: true, fix: st => { L(lot.id)(st).events.push({ id: uid(), type: 'dividend', date: o.date, amount: o.amount, note: 'MT5', mt5: o.id }); } });
    } else {
      if (S.flows.some(f => dd(f.date, o.date) <= 2 && Math.abs(f.amount - o.amount) < 0.011)) { cnt.opOk++; continue; }
      const ext = /d[ée]p[oô]t|deposit|withdraw|retrait|virement|transfer|wire/i.test(o.comment);
      out.push({ g: 'op', txt: `${fmtDate(o.date)} · ${usd(o.amount, true)} · ${esc(o.comment || o.kind)} <small>(${ext ? 'versement ou retrait' : 'rattrapage'})</small>`, on: true,
        fix: st => { st.flows.push(Object.assign({ id: uid(), date: o.date, amount: o.amount, note: 'MT5 : ' + (o.comment || o.kind), mt5: o.id }, ext ? {} : { kind: 'pnl' })); } });
    }
  }
  // Positions ouvertes : quantités, prix d'entrée, swap réel
  const D = mt5SnapDate(rep), mt = {};
  for (const p of rep.open) { const t = tk(p.sym); if (!t || p.type !== 'buy') { ign.add(p.sym); continue; } (mt[t] = mt[t] || []).push(p); }
  const appOpen = {}; for (const l of real) { const ls = Core.lotState(l); if (!ls.closed) (appOpen[l.ticker] = appOpen[l.ticker] || []).push([l, ls]); }
  for (const t of [...new Set(Object.keys(mt).concat(Object.keys(appOpen)))].sort()) {
    const P = mt[t] || [], A = appOpen[t] || [];
    if (!A.length) { out.push({ g: 'open', txt: `<b>${esc(t)}</b> : ouverte dans MT5 (${qty(P.reduce((a, p) => a + p.vol, 0))}), absente de l’app` }); continue; }
    if (!P.length) { if (rep.open.length && A.reduce((a, [, ls]) => a + ls.rem, 0) - (pend[t] || 0) > 1e-6) out.push({ g: 'open', txt: `<b>${esc(t)}</b> : ouverte dans l’app, fermée dans MT5 (vente à saisir ?)`, lot: A[0][0].id }); continue; }
    const qm = P.reduce((a, p) => a + p.vol, 0), qa = A.reduce((a, [, ls]) => a + ls.rem, 0) - (pend[t] || 0);
    if (Math.abs(qm - qa) > 1e-6) { out.push({ g: 'open', txt: `<b>${esc(t)}</b> : ${qty(qa)} dans l’app, ${qty(qm)} dans MT5`, lot: A[0][0].id }); continue; }
    if (A.length === 1 && P.length === 1 && Math.abs(A[0][0].price - P[0].price) > Math.max(0.005, P[0].price * 0.0005)) {
      const id = A[0][0].id, v = P[0].price;
      out.push({ g: 'open', txt: `<b>${esc(t)}</b> : prix d’entrée ${usd(A[0][0].price)} → <b>${usd(v)}</b> (MT5)`, on: false, fix: st => { L(id)(st).price = v; } });
    } else cnt.openOk++;
  }
  // Swap réel des positions ouvertes : swap de la position + swap déjà pris sur ses ventes partielles.
  if (rep.open.length) {
    const bk = swapBook(D), fix = [];
    for (const t of Object.keys(mt)) {
      const rows = bk.rows.filter(r => r.lot.ticker === t); if (!rows.length) continue;
      const first = mt[t].map(p => p.date).sort()[0];
      const realSw = -mt[t].reduce((a, p) => a + p.swap, 0) - rep.deals.filter(d => d.dir === 'out' && tk(d.sym) === t && d.date >= first).reduce((a, d) => a + d.swap, 0);
      const cur = rows.reduce((a, r) => a + r.cur, 0);
      if (Math.abs(realSw - cur) < 0.05) continue;
      fix.push({ t, realSw, cur, rows: rows.map(r => ({ id: r.lot.id, w: cur > 0 ? r.cur / cur : r.expo / rows.reduce((a, x) => a + x.expo, 0), man: r.man })) });
    }
    if (fix.length) out.push({ g: 'swap', txt: `${fix.length} position(s) : swap estimé ${usd(fix.reduce((a, f) => a + f.cur, 0))} → réel <b>${usd(fix.reduce((a, f) => a + f.realSw, 0))}</b> <small>(${fix.slice(0, 6).map(f => esc(f.t)).join(', ')}${fix.length > 6 ? '…' : ''})</small>`, on: true,
      fix: st => { for (const f of fix) for (const r of f.rows) { const amt = Core.roundTo(f.realSw * r.w - r.man, 2); if (Math.abs(amt) >= 0.005) st.lots.find(l => l.id === r.id).events.push({ id: uid(), type: 'funding', date: D, amount: amt, note: 'Swap réel MT5 (import)' }); } } });
  }
  // Photo du compte : devient le rapprochement MT5 du jour.
  if (rep.sum.equity > 0) out.push({ g: 'acct', txt: `Rapprochement du ${fmtDate(D)} : valeur nette ${usd(rep.sum.equity)}${rep.sum.margin != null ? ' · marge ' + usd(rep.sum.margin) : ''}`, on: true,
    fix: st => { st.snapshots = st.snapshots.filter(s => s.date !== D); const mu = rep.sum.margin; st.snapshots.push({ id: uid(), date: D, netValue: rep.sum.equity, marginUsed: mu, marginAvail: mu == null ? null : Core.roundTo(rep.sum.equity - mu, 2), swap: Core.roundTo(rep.open.reduce((a, p) => a + p.swap, 0), 2), src: 'mt5' }); } });
  return { out, cnt, ign: [...ign].sort(), D };
}
// Solde et valeur nette de l'app, comparables à MT5 : cours du rapport pour les positions ouvertes ;
// le swap des positions ouvertes est dans le flottant MT5, pas dans le solde.
function mt5AppAcct(st, D, rep) {
  for (const p of rep.open) { const t = st.lots.some(l => l.ticker === p.sym) ? p.sym : Core.mt5Ticker(p.sym); if (!t || !(p.mkt > 0)) continue;
    const h = st.prices[t] = (st.prices[t] || []).filter(x => x.date < D); h.push({ date: D, price: p.mkt }); }
  const a = Core.accountState(st, D, 'last');
  return { bal: a.equity - a.unreal - rep.open.reduce((x, p) => x + p.swap, 0), eq: a.equity, margin: a.margin };
}
let mt5Cur = null;
const MT5_G = [['sell', 'Ventes absentes de l’app'], ['buy', 'Achats absents de l’app'], ['div', 'Dividendes'], ['op', 'Autres opérations du compte'], ['fee', 'Commissions réelles'], ['swap', 'Swap réel'], ['open', 'Positions ouvertes'], ['acct', 'Compte']];
function mt5Render(form) {
  const box = $('#mt5Diff'); if (!box || !mt5Cur) return;
  const since = F(form, 'since') || mt5Since();
  if (mt5Cur.since !== since) { mt5Cur.since = since; mt5Cur.d = mt5Diff(mt5Cur.rep, since); mt5Cur.off = new Set(mt5Cur.d.out.map((x, i) => x.fix && !x.on ? i : -1).filter(i => i >= 0)); }
  else form.querySelectorAll('input[name="mt5i"]').forEach(c => { if (c.checked) mt5Cur.off.delete(+c.value); else mt5Cur.off.add(+c.value); });
  if (form.elements.mt5gap) mt5Cur.gap = form.elements.mt5gap.checked;
  const { d, rep } = mt5Cur;
  const pick = d.out.map((x, i) => x.fix && !mt5Cur.off.has(i) ? i : -1).filter(i => i >= 0);
  const st = JSON.parse(JSON.stringify({ lots: S.lots, flows: S.flows, snapshots: S.snapshots, prices: S.prices, settings: S.settings }));
  for (const i of pick) d.out[i].fix(st);
  const A = mt5AppAcct(st, d.D, rep), c = d.cnt;
  const ok = { sell: c.sellOk && `${c.sellOk} déjà dans l’app`, buy: c.buyOk && `${c.buyOk} déjà dans l’app`, div: c.divOk && `${c.divOk} déjà dans l’app`, op: c.opOk && `${c.opOk} déjà dans l’app`, open: c.openOk && `${c.openOk} identiques` };
  const row = (x, i) => `<div class="tnr"><span>${x.txt}</span>${x.fix ? `<input type="checkbox" name="mt5i" value="${i}" ${mt5Cur.off.has(i) ? '' : 'checked'} aria-label="Appliquer">` : x.lot ? `<button type="button" class="btn sm" data-act="open-lot" data-lot="${x.lot}">Voir</button>` : '<small>à vérifier</small>'}</div>`;
  const gap = (a, b) => Math.abs(a - b) < 0.015 ? '<span class="pill win">ok</span>' : `<span class="pill warn">écart ${usd(a - b, true)}</span>`;
  box.innerHTML = MT5_G.map(([g, lab]) => { const xs = d.out.map((x, i) => [x, i]).filter(([x]) => x.g === g); if (!xs.length && !ok[g]) return '';
      return `<h3>${lab} <small>· ${xs.length ? xs.length + ' à voir' : 'rien à faire'}</small></h3>${ok[g] ? `<div class="tnr"><span>${ok[g]}</span><span class="pill win">ok</span></div>` : ''}${xs.map(([x, i]) => row(x, i)).join('')}`; }).join('')
    + `<h3>Après import</h3>
      <div class="tnr"><span>Solde MT5 ${usd(rep.sum.balance)} · app ${usd(A.bal)}</span>${rep.sum.balance != null ? gap(A.bal, rep.sum.balance) : ''}</div>
      ${rep.sum.balance != null && Math.abs(rep.sum.balance - A.bal) >= 0.015 ? `<label class="check"><input type="checkbox" name="mt5gap" ${mt5Cur.gap ? 'checked' : ''}> Ajouter une ligne de rattrapage de ${usd(rep.sum.balance - A.bal, true)} au ${fmtDate(d.D)} pour aligner le solde sur MT5</label>` : ''}
      <div class="tnr"><span>Valeur nette MT5 ${usd(rep.sum.equity)} · app ${usd(A.eq)}</span>${rep.sum.equity ? (Math.abs(A.eq / rep.sum.equity - 1) < 0.01 ? '<span class="pill win">ok</span>' : `<span class="pill warn">écart ${usd(A.eq - rep.sum.equity, true)}</span>`) : ''}</div>
      ${rep.sum.level != null ? `<div class="tnr"><span>Niveau de marge MT5 ${fmtNum(rep.sum.level, 0)} %</span>${rep.sum.level < (S.settings.marginMin || 150) ? `<span class="pill warn">sous ${fmtNum(S.settings.marginMin || 150, 0)} %</span>` : '<span class="pill win">ok</span>'}</div>` : ''}
      <p class="hint">Un écart de solde restant vient d’une opération d’avant le ${fmtDate(since)} : ligne de rattrapage dans Réglages › Versements. Valeur nette de l’app calculée avec les cours du rapport.${d.ign.length ? ` Ignoré (hors carnet : forex, or, ventes à découvert) : ${d.ign.slice(0, 8).map(esc).join(', ')}${d.ign.length > 8 ? '…' : ''}.` : ''}</p>`;
  $('#sheetOk').textContent = pick.length ? `Appliquer ${pick.length} ligne(s)` : 'Terminer';
}
function sheetMt5() {
  openSheet({ title: 'Importer l’historique MT5', ok: 'Lire le rapport',
    body: `<p class="lead">Dans MT5 : Historique › Rapport, puis partagez le PDF vers l’app. Lu sur cet appareil, rien n’est envoyé, aucun identifiant.</p><div class="fields">
      <div class="fld wide"><label for="f-file">Rapport d’historique de trading (PDF)</label><input type="file" id="f-file" name="file" accept="application/pdf,.pdf,.txt,.htm,.html"></div>
      <div class="fld wide"><label for="f-paste">ou coller le texte du rapport</label><textarea id="f-paste" name="paste" rows="3"></textarea></div></div>`,
    onSubmit: async form => {
      const file = form.elements.file.files[0];
      const text = file ? (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) ? await pdfText(file) : await file.text()) : F(form, 'paste');
      need(String(text).trim(), 'Choisissez le PDF ou collez le texte.');
      const rep = Core.parseMt5(text);
      need(rep.deals.length || rep.open.length, 'Rapport non reconnu : choisissez le « Rapport d’historique de trading » de MT5 (Historique › Rapport).');
      sheetMt5Diff(rep);
    } });
}
function sheetMt5Diff(rep) {
  const prev = S.settings.mt5, br = mt5Breaks(rep);
  mt5Cur = { rep, since: null };
  openSheet({ title: 'Historique MT5 · ' + fmtDate(rep.to), ok: 'Appliquer', noFocus: true,
    body: `<p class="lead">Compte ${esc(rep.acct || '?')} · ${fmtDate(rep.from)} → ${fmtDate(rep.to)} · ${rep.deals.length} transaction(s), ${rep.open.length} position(s) ouverte(s).</p>
      ${br ? `<div class="banner warn"><span>${br} ligne(s) mal lue(s) : le solde ne suit pas. Vérifiez les lignes proposées.</span></div>` : '<p class="hint">Rapport lu en entier : chaque solde suit le précédent.</p>'}
      ${prev && prev.acct && rep.acct && prev.acct !== rep.acct ? `<div class="banner warn"><span>Autre compte que le dernier import (${esc(prev.acct)}).</span></div>` : ''}
      <div class="fields">${dateInp('since', 'Comparer après le', mt5Since())}</div>
      <p class="hint">Avant cette date, tout a déjà été rapproché (dernier import ou ligne de rattrapage).</p>
      <div id="mt5Diff" class="tn"></div>`,
    onInput: mt5Render,
    onSubmit: form => {
      mt5Render(form);
      const pick = mt5Cur.d.out.map((x, i) => x.fix && !mt5Cur.off.has(i) ? i : -1).filter(i => i >= 0);
      for (const i of pick) mt5Cur.d.out[i].fix(S);
      let g = 0;
      if (mt5Cur.gap && rep.sum.balance != null) {
        const A = mt5AppAcct(JSON.parse(JSON.stringify({ lots: S.lots, flows: S.flows, snapshots: S.snapshots, prices: S.prices, settings: S.settings })), mt5Cur.d.D, rep);
        g = Core.roundTo(rep.sum.balance - A.bal, 2);
        if (Math.abs(g) >= 0.01) S.flows.push({ id: uid(), kind: 'pnl', date: mt5Cur.d.D, amount: g, note: 'Alignement du solde sur MT5 (import du ' + fmtDate(rep.to) + ')' });
      }
      S.settings.mt5 = { upTo: rep.to, acct: rep.acct, at: todayISO() };
      try { localStorage.removeItem(MT5_SNOOZE); } catch (e) {}
      mt5Cur = null;
      save((pick.length ? `Import MT5 : ${pick.length} ligne(s) appliquée(s)` : 'Import MT5 : tout était déjà à jour') + (Math.abs(g) >= 0.01 ? ` · rattrapage ${usd(g, true)}` : ''));
    } });
}
function mt5Due() {
  if (!S.lots.some(l => !l.demo && !Core.lotState(l).closed)) return null;
  const t = todayISO(); try { if (localStorage.getItem(MT5_SNOOZE) === t) return null; } catch (e) {}
  let fri = t; while (wdOf(fri) !== 5) fri = addDays(fri, -1);
  const lb = latestBroker();
  return lb && lb.date >= fri ? null : (lb || true);
}
function mt5Remind() {
  const due = mt5Due(); if (!due) return '';
  return `<div class="banner warn"><span><strong>Rapprochement MT5</strong> : ${due === true ? 'jamais fait' : 'dernier le ' + fmtDate(due.date)}. Importez le rapport d’historique de MT5, ou recopiez les fonds propres et la marge, pour vérifier les calculs de l’app.</span><span class="row"><button class="btn sm primary" data-act="mt5-import">Importer le PDF</button><button class="btn sm" data-act="add-snap">Saisir</button><button class="btn sm" data-act="mt5-snooze">Plus tard</button></span></div>`;
}
function mt5Compare(form) {
  const box = $('#mt5Out'); if (!box) return;
  const v = num(F(form, 'netValue')), mu = numOr(F(form, 'marginUsed'), null), swv = F(form, 'swap').trim(), sw = swv === '' ? null : num(swv), D = F(form, 'date');
  if (!D || !(v > 0)) { box.innerHTML = '<p class="hint">Saisissez au moins les fonds propres pour voir la comparaison.</p>'; return; }
  const a = Core.accountState(S, D, 'last'), bk = swapBook(D), appSw = -bk.tot, mtSw = sw == null || !isNum(sw) ? null : -Math.abs(sw);
  const gEq = v - a.equity, gPct = a.equity > 0 ? gEq / a.equity * 100 : 0, gM = mu == null ? null : mu - a.margin, gSw = mtSw == null ? null : mtSw - appSw;
  const td = (x, c) => `<td class="n ${c || ''}">${x}</td>`;
  const row = (l, app, mt, g, est) => `<tr><td>${l}</td>${td(usd(app) + (est ? ' <small class="muted">est.</small>' : ''))}${td(mt == null ? '—' : usd(mt))}${td(g == null ? '—' : usd(g, true), g == null || Math.abs(g) < 0.005 ? '' : cls(g))}</tr>`;
  const causes = [];
  if (gSw != null && Math.abs(gEq) >= 0.01) {
    const share = gEq !== 0 ? gSw / gEq * 100 : 0;
    causes.push(`Swap ${gSw < 0 ? 'sous-estimé' : 'surestimé'} de ${usd(Math.abs(gSw))}${share > 0 ? ` : explique ${fmtNum(Math.min(100, share), 0)} % de l’écart` : ''}.${bk.allEst && bk.tot > 0 && (S.settings.swap || {}).pct > 0 ? ` <small>Taux de swap annuel équivalent : environ ${fmtNum(S.settings.swap.pct * Math.abs(mtSw) / bk.tot, 2)} % (réglé à ${fmtNum(S.settings.swap.pct, 2)} %).</small>` : ''}`);
  } else if (gSw == null) causes.push('Saisissez le swap total des positions (colonne Swap de MT5, somme) pour savoir quelle part de l’écart il explique.');
  causes.push(`Cours : l’app valorise à la clôture${a.minPriceDate ? ` (cours au ${fmtDate(a.minPriceDate)} au plus ancien)` : ''}, MT5 au dernier prix CFD. Petit écart normal hors séance.`);
  const rest = gEq - (gSw || 0);
  if (a.equity > 0 && Math.abs(rest / a.equity * 100) >= 0.5) causes.push(`Reste ${usd(rest, true)} sans explication : vérifiez ventes, commissions et dividendes ou ajustements CFD non saisis.`);
  if (gM != null && a.margin > 0 && Math.abs(gM / a.margin * 100) >= 5) causes.push(`Marge différente de ${fmtNum(gM / a.margin * 100, 0)} % : vérifiez le levier enregistré pour vos positions.`);
  box.innerHTML = `<div class="sec-head" style="margin-top:8px"><h3 class="chart-t" style="margin:0">App vs MT5</h3><span class="pill ${Math.abs(gPct) < 0.5 ? 'win' : 'warn'}">écart ${fmtNum(Math.abs(gPct), 2)} %</span></div>
    <div class="tbl"><table><thead><tr><th></th><th class="n">App</th><th class="n">MT5</th><th class="n">Écart</th></tr></thead><tbody>
    ${row('Valeur nette', a.equity, v, gEq)}${row('Marge', a.margin, mu, gM)}${row('Swap des positions', appSw, mtSw, gSw, !bk.allEst ? false : true)}</tbody></table></div>
    <ul class="mt5c">${causes.map(c => `<li>${c}</li>`).join('')}</ul>`;
}
function sheetSnap() {
  const D0 = lastWeekday(todayISO());
  openSheet({ title: 'Rapprochement MT5', ok: 'Enregistrer',
    body: `<p class="lead">Recopiez les chiffres de MT5, onglet Trade (en bas). La valeur MT5 devient une observation exacte de la performance à cette date.</p><div class="fields">
      ${dateInp('date', 'Date (dernière séance)', D0)}${dec('netValue', 'Fonds propres MT5 (Equity, $)', '')}
      ${dec('marginUsed', 'Marge MT5 (Margin, $)', '', 'placeholder="facultatif"')}${dec('swap', 'Swap total des positions ($)', '', 'placeholder="facultatif"', 'somme de la colonne Swap')}</div>
      <label class="check"><input type="checkbox" name="fixSwap"> Remplacer le swap estimé par le swap réel (réparti sur les positions ouvertes, au prorata de leur swap estimé)</label>
      <div id="mt5Out"></div>`,
    onInput: mt5Compare,
    onSubmit: form => {
      const v = num(F(form, 'netValue')), mu = numOr(F(form, 'marginUsed'), null), swv = F(form, 'swap').trim(), sw = swv === '' ? null : num(swv), date = F(form, 'date');
      need(date, 'Date requise.'); need(date <= todayISO(), 'Date dans le futur.'); need(v > 0, 'Fonds propres positifs requis.');
      need(mu === null || mu >= 0, 'Marge invalide.'); need(sw === null || isNum(sw), 'Swap invalide.');
      const fix = form.elements.fixSwap.checked; need(!fix || sw !== null, 'Saisissez le swap total pour le remplacer.');
      let n = 0;
      if (fix) {
        const bk = swapBook(date), T = Math.abs(sw), base = bk.tot > 0 ? bk.tot : bk.rows.reduce((a, r) => a + r.expo, 0);
        need(bk.rows.length && base > 0, 'Aucune position ouverte à cette date.');
        for (const r of bk.rows) {
          const amt = Core.roundTo(T * (bk.tot > 0 ? r.cur : r.expo) / base - r.man, 2);
          if (Math.abs(amt) < 0.005) continue;
          r.lot.events.push({ id: uid(), type: 'funding', date, amount: amt, note: 'Swap réel MT5 (rapprochement)' }); n++;
        }
      }
      S.snapshots = S.snapshots.filter(s => s.date !== date);
      S.snapshots.push({ id: uid(), date, netValue: v, marginUsed: mu, marginAvail: mu === null ? null : Core.roundTo(v - mu, 2), swap: sw });
      if (calcDraft && mu !== null) calcDraft.marginAvail = String(Core.roundTo(v - mu, 2));
      try { localStorage.removeItem(MT5_SNOOZE); } catch (e) {}
      save('Rapprochement enregistré' + (n ? ` · swap réel réparti sur ${n} position(s)` : ''));
    } });
}

// ---------- Exports et restauration ----------
const csvCell = v => { const s = typeof v === 'number' ? String(Core.roundTo(v, 6)).replace('.', ',') : String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function buildCSV() {
  const head = ['id_position', 'ticker', 'mouvement', 'date', 'quantite', 'prix', 'frais', 'montant', 'levier', 'stop_initial', 'stop_actuel', 'capital_reference', 'risque_initial', 'risque_initial_pct', 'motif', 'plan_respecte', 'commentaire_plan', 'note', 'resultat_net_position', 'R_plan', 'statut'];
  const rows = [head];
  for (const lot of S.lots.slice().sort((a, b) => a.date < b.date ? -1 : 1)) {
    const ls = Core.lotState(lot), R = lotR(lot, ls) == null ? '' : lotR(lot, ls);
    const plan = lot.planOk === true ? 'oui' : lot.planOk === false ? 'non' : '';
    rows.push([lot.id, lot.ticker, 'achat', lot.date, lot.qty, lot.price, lot.entryFee, -lot.qty * lot.price, lot.leverage, lot.stopInitial, lot.stopCurrent == null ? '' : lot.stopCurrent, lot.refCapital, lot.riskInitial, lot.riskInitialPct, MOTIFS[lot.motif] || '', plan, lot.planComment || '', lot.note || '', ls.netRealized, R, ls.closed ? 'clôturée' : 'ouverte']);
    for (const e of lot.events.slice().sort((a, b) => a.date < b.date ? -1 : 1)) {
      const lab = { sell: 'vente', funding: 'financement', dividend: 'dividende', adjust: 'ajustement', stop: 'stop' }[e.type];
      if (e.type === 'sell') rows.push([lot.id, lot.ticker, lab, e.date, e.qty, e.price, e.fee || 0, e.qty * e.price, '', '', '', '', '', '', '', '', '', '', '', '', '']);
      else if (e.type === 'stop') rows.push([lot.id, lot.ticker, lab, e.date, '', e.to == null ? '' : e.to, '', '', '', '', '', '', '', '', '', '', '', 'ancien stop ' + (e.from == null ? 'aucun' : e.from), '', '', '']);
      else rows.push([lot.id, lot.ticker, lab, e.date, '', '', e.type === 'funding' ? e.amount : '', e.type === 'funding' ? -e.amount : e.amount, '', '', '', '', '', '', '', '', '', e.note || '', '', '', '']);
    }
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}
async function buildJSON() {
  const images = {};
  for (const l of S.lots) for (const id of lotImgIds(l)) { const d = await getImage(id); if (d) images[id] = d; }
  return JSON.stringify({ app: 'carnet-positions', format: 1, exportedAt: new Date().toISOString(), state: S, images }, null, 1);
}
async function offerFile(filename, text) {
  try {
    const dl = Store.caps.downloads ? await withTimeout(Store.caps.downloads, 3000) : null;
    if (dl) { await dl.save({ filename, data: text }); toast('Fichier prêt : ' + filename); return; }
  } catch (e) { if (e && e.code === 'declined') { toast('Téléchargement annulé'); return; } }
  const url = URL.createObjectURL(new Blob([text], { type: filename.endsWith('.csv') ? 'text/csv' : 'application/json' }));
  openSheet({ title: 'Export ' + filename, noFocus: true,
    body: `<p class="lead">Si le lien ne télécharge rien dans cette vue, copiez le contenu et collez-le dans un fichier.</p>
      <div class="row"><a class="btn primary" href="${url}" download="${esc(filename)}">Télécharger</a><button type="button" class="btn" data-act="copy-ta">Copier le contenu</button></div>
      <textarea id="exportTa" readonly rows="8" style="margin-top:10px">${esc(text.length > 400000 ? text.slice(0, 400000) + '\n… (tronqué à l’affichage, utilisez Copier)' : text)}</textarea>` });
  window.__exportText = text;
}
function parseBackup(text) {
  let o; try { o = JSON.parse(text); } catch (e) { throw new Error('Fichier JSON illisible.'); }
  const st = o && o.state ? o.state : o;
  if (!st || !st.settings || !Array.isArray(st.lots) || !Array.isArray(st.flows)) throw new Error('Ce JSON ne provient pas du Carnet de positions.');
  return { state: normalize(st), images: (o && o.images) || {} };
}
function sheetImport() {
  openSheet({
    title: 'Restaurer une sauvegarde JSON', ok: 'Remplacer toutes les données', danger: true,
    body: `<p class="lead">La restauration remplace toutes les données actuelles, captures comprises.</p><div class="fields">
      <div class="fld wide"><label for="f-file">Fichier .json</label><input type="file" id="f-file" name="file" accept="application/json,.json"></div>
      <div class="fld wide"><label for="f-paste">ou coller le contenu</label><textarea id="f-paste" name="paste" rows="4"></textarea></div></div>`,
    onSubmit: async form => {
      const file = form.elements.file.files[0];
      const text = file ? await file.text() : F(form, 'paste').trim();
      need(text, 'Choisissez un fichier ou collez un contenu.');
      const b = parseBackup(text);
      for (const id in b.images) await putImage(id, b.images[id]);
      S = b.state; calcDraft = null;
      save(`Restauration terminée : ${S.lots.length} position(s), ${Object.keys(b.images).length} capture(s)`);
    }
  });
}

// ---------- Démonstration ----------
function buildDemo() {
  const T = todayISO(), d = n => addDays(T, -n);
  const anchors = { MSFT: [[112, 418], [80, 455], [60, 470], [0, 478]], COST: [[112, 905], [95, 900], [72, 870], [70, 852], [30, 960], [0, 1004]],
    LLY: [[112, 760], [50, 800], [20, 866], [0, 884]], AMD: [[112, 146], [40, 150], [25, 141], [0, 139]] };
  const px = (t, n) => { const a = anchors[t]; for (let i = 0; i < a.length - 1; i++) { const [n0, p0] = a[i], [n1, p1] = a[i + 1]; if (n <= n0 && n >= n1) return Core.roundTo(p0 + (p1 - p0) * (n0 - n) / (n0 - n1), 2); } return a[a.length - 1][1]; };
  const fz = { inFixed: 0.5, inPct: 0, outFixed: 0.5, outPct: 0 };
  const size = (e, s, eq) => Core.sizePosition({ equity: eq, riskPct: 1, entry: e, stop: s, leverage: 5, cap: 100, fractional: true, decimals: 4, fees: fz });
  const mkLot = (t, n, e, s, eq, extra) => {
    const r = size(e, s, eq);
    return Object.assign({ id: 'demo-' + uid(), demo: true, ticker: t, date: d(n), price: e, qty: r.q, leverage: 5, entryFee: 0.5, estExitFee: 0.5,
      stopInitial: s, stopCurrent: s, refCapital: eq, refDate: d(n), riskInitial: r.totalRisk, riskInitialPct: r.riskPctAccount,
      motif: 'cassure', note: '', imgId: null, planOk: null, planComment: '', events: [] }, extra);
  };
  const L1 = mkLot('MSFT', 110, 420, 378, 1000, { motif: 'cassure', note: 'Cassure du plus haut 52 semaines, weekly haussier.', planOk: true, stopCurrent: 440 });
  const h = Core.roundTo(L1.qty / 2, 4);
  L1.events.push({ id: uid(), type: 'sell', date: d(80), qty: h, price: 455, fee: 0.5 }, { id: uid(), type: 'sell', date: d(60), qty: Core.roundTo(L1.qty - h, 4), price: 470, fee: 0.5 });
  const L2 = mkLot('COST', 95, 900, 855, 1000, { motif: 'pullback', planOk: true, planComment: 'Gap sous le stop, sortie à l’ouverture.' });
  L2.events.push({ id: uid(), type: 'sell', date: d(70), qty: L2.qty, price: 852, fee: 0.5 });
  const L3 = mkLot('AMD', 40, 150, 135, 1500, { motif: 'continuation', planOk: false, planComment: 'Sortie avant le stop sans signal de sortie.' });
  L3.events.push({ id: uid(), type: 'sell', date: d(25), qty: L3.qty, price: 141, fee: 0.5 });
  const L4 = mkLot('LLY', 50, 800, 720, 1500, { motif: 'cassure', stopCurrent: 820 });
  L4.events.push({ id: uid(), type: 'stop', date: d(15), from: 720, to: 820 }, { id: uid(), type: 'funding', date: d(20), amount: 0.35, note: 'Financement mensuel' }, { id: uid(), type: 'funding', date: d(5), amount: 0.3, note: 'Financement mensuel' });
  const L5 = mkLot('COST', 30, 960, 900, 1500, { motif: 'continuation', stopCurrent: 930 });
  const lots = [L1, L2, L3, L4, L5];
  const flows = [{ id: 'demo-' + uid(), demo: true, date: d(45), amount: 500, note: 'Versement' }];
  const tmp = { settings: Object.assign({}, S.settings, { startDate: d(120) }), lots, flows, prices: {}, snapshots: [] };
  const add = (t, date, p) => { const hh = tmp.prices[t] = tmp.prices[t] || []; if (!hh.some(x => x.date === date)) hh.push({ date, price: p, demo: true }); };
  for (const l of lots) add(l.ticker, l.date, l.price);
  for (let n = 112; n >= 0; n -= 7) for (const l of lots) {
    const ls = Core.lotState(l, d(n));
    if (l.date <= d(n) && !ls.closed) add(l.ticker, d(n), px(l.ticker, n));
  }
  for (const t in tmp.prices) tmp.prices[t].sort((a, b) => a.date < b.date ? -1 : 1);
  const at = Core.accountState(tmp, d(7), 'exact');
  const snaps = at.missing.length ? [] : [{ id: 'demo-' + uid(), demo: true, date: d(7), netValue: Core.roundTo(at.equity + 1.15, 2), marginAvail: 410 }];
  return { lots, flows, prices: tmp.prices, snapshots: snaps, startDate: d(120) };
}
function loadDemo() {
  const D = buildDemo();
  const hasReal = S.lots.some(l => !l.demo) || S.flows.some(f => !f.demo);
  if (!hasReal) S.settings.startDate = D.startDate;
  S.lots.push(...D.lots); S.flows.push(...D.flows); S.snapshots.push(...D.snapshots);
  for (const t in D.prices) for (const x of D.prices[t]) { const h = S.prices[t] = S.prices[t] || []; if (!h.some(y => y.date === x.date)) h.push(x); h.sort((a, b) => a.date < b.date ? -1 : 1); }
}
function clearDemo() {
  S.lots = S.lots.filter(l => !l.demo); S.flows = S.flows.filter(f => !f.demo); S.snapshots = S.snapshots.filter(s => !s.demo);
  for (const t in S.prices) { S.prices[t] = S.prices[t].filter(x => !x.demo); if (!S.prices[t].length) delete S.prices[t]; }
  if (!S.lots.length && !S.flows.length) S.settings.startDate = todayISO();
  calcDraft = null;
}

// ---------- Événements ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tab],[data-act]'); if (!b) return;
  if (b.closest('summary')) e.preventDefault();   // un bouton posé sur une ligne repliable ne la déplie pas
  if (b.dataset.tab) { tab = b.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const a = b.dataset.act, lot = b.dataset.lot ? findLot(b.dataset.lot) : null;
  switch (a) {
    case 'close-sheet': closeSheet(); break;
    case 'go-calc': tab = 'calc'; render(); break;
    case 'reset-calc': calcDraft = freshDraft(); render(); break;
    case 'record-buy': sheetBuy(); break;
    case 'prices': sheetPrices(); break;
    case 'jfilter': journalFilter = b.dataset.f; render(); break;
    case 'psort': posSort = b.dataset.f; render(); break;
    case 'perf-range': perfRange = b.dataset.f; render(); break;
    case 'trade-year': tradeYear = b.dataset.f; tradeMonth = 'all'; render(); break;
    case 'trade-month': tradeMonth = b.dataset.f; render(); break;
    case 'go-radar': tab = 'radar'; render(); window.scrollTo(0, 0); break;
    case 'radar-add': sheetWatch(); break;
    case 'radar-add-sma': sheetWatch(null, b.dataset.t); break;
    case 'radar-filter': radarFilter = b.dataset.f; render(); break;
    case 'radar-sect': radarSector = radarSector === b.dataset.s ? '' : b.dataset.s; render(); break;
    case 'radar-sect-tog': rsectOpen = !rsectOpen; try { localStorage.setItem(RSECT_KEY, rsectOpen ? '1' : '0'); } catch (e) {} render(); break;
    case 'radar-import': sheetWatchImport(); break;
    case 'idx-detail': sheetIdxDetail(b.dataset.t); break;
    case 'idx-edit': sheetIdxEdit(); break;
    case 'sect-mode': sectMode = b.dataset.m; render(); break;
    case 'sect-detail': sheetSector(b.dataset.s); break;
    case 'sect-fix': sheetSectorFix(b.dataset.t); break;
    case 'sect-set': sheetSectSet(); break;
    case 'risk-set': sheetRiskLim(); break;
    case 'stop-raises': sheetStopRaises(); break;
    case 'pos-sma': sheetPosSma(b.dataset.t); break;
    case 'sma-add': {
      const box = b.closest('.smabox'), tf = box.querySelector('[name=smaTf]').value, pi = box.querySelector('[name=smaP]'), p = parseInt(pi.value, 10);
      if (!(p >= 2 && p <= 2000)) { toast('Période entre 2 et 2000'); break; }
      const k = tf + '|' + p, ex = box.querySelector(`input[name=sma][value="${k}"]`);
      if (ex) ex.checked = true; else box.querySelector('.smach').insertAdjacentHTML('beforeend', smaChip(k, true));
      const none = box.querySelector('.smanone'); if (none) none.remove();
      pi.value = ''; break;
    }
    case 'lab-go': labGo(); break;
    case 'lab-del': S.settings.labQueue = labQueue().filter(t => t !== b.dataset.t); save(b.dataset.t + ' retiré du Labo'); break;
    case 'lab-clear': confirmSheet('Vider le Labo', 'Retirer toutes les actions de la liste ? Leurs résultats disparaîtront au prochain passage du robot.', 'Tout retirer', () => { S.settings.labQueue = []; save('Labo vidé'); }); break;
    case 'lab-fee': labFee = b.dataset.f; try { localStorage.setItem(LAB_FEE_KEY, labFee); } catch (e) {} render(); break;
    case 'earn-f': earnF = b.dataset.f; try { localStorage.setItem(EARN_F_KEY, earnF); } catch (e) {} render(); break;
    case 'lab-open': { const t = b.dataset.t; if (labOpen.has(t)) labOpen.delete(t); else labOpen.add(t); render(); break; }
    case 'lab-cell': labSel[b.dataset.t] = [b.dataset.tf, +b.dataset.i]; (labPick[b.dataset.t] = labPick[b.dataset.t] || {})[b.dataset.tf] = +b.dataset.i; render(); break;
    case 'lab-combo': { const t = b.dataset.t; labPick[t] = { D: +b.dataset.i, W: LAB_P.indexOf(+b.dataset.w), M: LAB_P.indexOf(+b.dataset.m) }; labChk[t] = { D: true, W: true, M: true }; render(); toast('Les 3 SMA sont cochées dans « Ajouter au radar » : vérifiez puis ajoutez'); break; }
    case 'lab-chk': (labChk[b.dataset.t] = labChk[b.dataset.t] || {})[b.dataset.tf] = b.checked; render(); break;
    case 'lab-add3': {
      const t = b.dataset.t, r = Lab.res[t]; if (!r) break;
      const U = ['D', 'W', 'M'].filter(tf => r[tf]), best = Object.fromEntries(U.map(tf => [tf, labBest(r[tf][labFee].sma, tf)]));
      const add = labAddPlan(t, r, U, best).filter(p => p.on && !S.watch.some(w => w.ticker === t && w.tf === p.tf && w.period === LAB_P[p.i]));
      if (!add.length) break;
      add.forEach(p => S.watch.push({ id: uid(), ticker: t, period: LAB_P[p.i], tf: p.tf, sym: '', note: 'Labo SMA' }));
      delete labChk[t];
      save(`${t} : ${add.map(p => TF_SHORT[p.tf] + ' ' + LAB_P[p.i]).join(' · ')} ajoutée(s) au radar`); refreshRadar(); break;
    }
    case 'lab-add': {
      const t = b.dataset.t, tf = b.dataset.tf, n = LAB_P[+b.dataset.i];
      if (S.watch.some(w => w.ticker === t && w.tf === tf && w.period === n)) break;
      S.watch.push({ id: uid(), ticker: t, period: n, tf, sym: '', note: 'Labo SMA' });
      save(`${t} : SMA ${n} ${TF_SHORT[tf]} ajoutée au radar`); refreshRadar(); break;
    }
    case 'stop-skip': { const m = stopSkip(); m[b.dataset.k] = todayISO(); try { localStorage.setItem(SKIP_KEY, JSON.stringify(m)); } catch (e) {} sheetStopRaises(); render(); break; }
    case 'edge-dim': edgeDim = b.dataset.f; render(); break;
    case 'radar-settings': sheetRadarSettings(); break;
    case 'acct': sheetAcct(); break;
    case 'preset-icm': { const fm = b.form; fm.elements.perShare.value = '0.02'; fm.elements.minComm.value = '0.02'; fm.elements.swapPct.value = '5.93'; fm.elements.swapTriple.value = '5'; toast('Valeurs IC Markets remplies : touchez « Enregistrer les réglages »'); break; }
    case 'acct-off': delete S.settings.acct; closeSheet(); save('Bilan depuis l’ouverture retiré'); break;
    case 'radar-refresh': refreshQuotes(); refreshRadar(true); break;
    case 'radar-edit': sheetWatch(S.watch.find(x => x.id === b.dataset.id)); break;
    case 'radar-del': { const w = S.watch.find(x => x.id === b.dataset.id);
      confirmSheet('Retirer ' + esc(w.ticker) + ' du radar ?', `SMA ${w.period} ${TF_LONG[w.tf]}. Vos positions ne sont pas touchées.`, 'Retirer', () => { S.watch = S.watch.filter(x => x !== w); save('Retirée du radar'); }); break; }
    case 'radar-seen': markSeen([b.dataset.k]); render(); break;
    case 'radar-gone': markSeen(['x:' + b.dataset.k]); render(); toast('Alerte supprimée'); break;
    case 'radar-gone-all': markSeen(radarAlerts().filter(x => x.lvl !== 'near' && x.seen).map(x => 'x:' + x.key)); render(); toast('Alertes déjà vues supprimées'); break;
    case 'radar-seen-all': markSeen(radarAlerts().filter(x => x.lvl !== 'near').map(x => x.key)); render(); break;
    case 'tn-stop': {
      const t = b.dataset.t, v = +b.dataset.v, lots = S.lots.filter(l => l.ticker === t && !Core.lotState(l).closed);
      for (const l of lots) { l.events.push({ id: uid(), type: 'stop', date: todayISO(), from: isNum(l.stopCurrent) ? l.stopCurrent : null, to: v }); l.stopCurrent = v; }
      tnMark('stop|' + t); save(`Stop ${t} : ${usd(v)} enregistré · changez-le aussi dans MT5`); break;
    }
    case 'chart': sheetChart(b.dataset.t, b.dataset.w); break;
    case 'ch-range': if (chartSt) { chartSt.n = +b.dataset.n; document.querySelectorAll('.chr .btn').forEach(x => x.classList.toggle('on', x === b)); $('#chWrap').innerHTML = chartSvg(); chartBind(); } break;
    case 'tn-hit': tnMark('hit|' + b.dataset.k); render(); break;
    case 'tn-skip': markSeen([b.dataset.k]); tnMark('x|' + b.dataset.k); render(); break;
    case 'tn-calc': tnMark('c|' + b.dataset.k); markSeen([b.dataset.k]); /* falls through */
    case 'radar-calc': {
      const w = S.watch.find(x => x.id === b.dataset.id), a = analyzeWatch(w);
      calcDraft = Object.assign(freshDraft(), { ticker: w.ticker, entry: String(Core.roundTo(a.p, 2)), stop: String(Core.roundTo(a.smaNow, 2)), example: false });
      tab = 'calc'; render(); window.scrollTo(0, 0); toast('Entrée au cours actuel, stop sur la SMA : ajustez si besoin'); break;
    }
    case 'radar-stop': {
      const w = S.watch.find(x => x.id === b.dataset.id), a = analyzeWatch(w), l = S.lots.find(x => x.ticker === w.ticker && !Core.lotState(x).closed);
      sheetStop(l); const el = document.querySelector('#sheetForm [name="stop"]'); if (el) el.value = String(Core.roundTo(a.sma, 2)).replace('.', ',');
      break;
    }
    case 'td-on': {
      const k = ($('#td-key').value || '').trim();
      if (!/^[A-Za-z0-9]{16,}$/.test(k)) { toast('Collez la clé API Twelve Data (lettres et chiffres).'); break; }
      b.disabled = true;
      tdSeries('AAPL', 5, k).then(v => {
        if (!v.length) throw new Error('réponse vide');
        try { localStorage.setItem(TD_KEY, k); } catch (e) {}
        toast('Clé Twelve Data enregistrée'); render(); refreshRadar(true);
      }).catch(e => { b.disabled = false; toast('Clé non valide : ' + (e instanceof TypeError ? 'pas de réseau' : e.message)); });
      break;
    }
    case 'td-off': closeSheet(); confirmSheet('Retirer la clé Twelve Data ?', 'Le radar ne mettra plus son historique à jour sur cet appareil. Votre liste reste.', 'Retirer', () => {
      try { localStorage.removeItem(TD_KEY); } catch (e) {} render(); toast('Clé retirée'); }); break;
    case 'quotes-now': refreshQuotes(true); break;
    case 'quotes-manual': {
      const list = [...new Set(($('#q-manual').value || '').toUpperCase().split(/[\s,;]+/).filter(Boolean))];
      if (list.some(t => !/^[A-Z0-9.\-]{1,12}$/.test(t))) { toast('Tickers invalides : séparez-les par des virgules.'); break; }
      setManual(list, list.length ? 'Saisie manuelle : ' + list.join(', ') : 'Toutes les actions passent par Finnhub');
      break;
    }
    case 'quote-toggle': {
      const t = b.dataset.t, cur = manualSet();
      if (cur.has(t)) { cur.delete(t); setManual([...cur], t + ' : cours Finnhub'); refreshQuotes(); }
      else { cur.add(t); setManual([...cur], t + ' : cours saisi à la main'); }
      break;
    }
    case 'quotes-on': {
      const k = ($('#q-key').value || '').trim();
      if (!/^[A-Za-z0-9]{12,}$/.test(k)) { toast('Collez la clé API Finnhub (lettres et chiffres).'); break; }
      b.disabled = true;
      fetchQuote('AAPL', k).then(q => {
        if (!(q && q.c > 0)) throw new Error('réponse vide');
        try { localStorage.setItem(QUOTE_KEY, k); } catch (e) {}
        toast('Clé enregistrée : cours automatiques actifs'); render(); refreshQuotes(true);
      }).catch(e => { b.disabled = false; toast('Clé non valide : ' + (e instanceof TypeError ? 'pas de réseau' : e.message)); });
      break;
    }
    case 'quotes-off': confirmSheet('Retirer la clé Finnhub ?', 'Les cours ne seront plus récupérés sur cet appareil. Les clôtures déjà enregistrées restent.', 'Retirer', () => {
      try { localStorage.removeItem(QUOTE_KEY); } catch (e) {} Live.prices = {}; Live.at = 0; Live.miss = []; Live.err = ''; render(); toast('Clé retirée'); }); break;
    case 'open-lot': {
      tab = 'pos'; openLots.add('p-' + b.dataset.lot); render();
      const d = document.querySelector(`details.lot[data-key="p-${b.dataset.lot}"]`);
      if (d) { d.open = true; d.closest('.pcard, details').scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      break;
    }
    case 'sell': sheetSell(lot); break;
    case 'sell-img': sheetSellImg(lot, lot.events.find(x => x.id === b.dataset.ev)); break;
    case 'stop': sheetStop(lot); break;
    case 'funding': sheetAmount(lot, 'funding'); break;
    case 'dividend': sheetAmount(lot, 'dividend'); break;
    case 'plan': sheetPlan(lot); break;
    case 'edit-lot': sheetEdit(lot); break;
    case 'del-lot': confirmSheet('Supprimer cette position ?', `${esc(lot.ticker)} du ${fmtDate(lot.date)}, avec ses ${lot.events.length} mouvement(s). Cette suppression est définitive.`, 'Supprimer', async () => {
      for (const id of lotImgIds(lot)) await delImage(id); S.lots = S.lots.filter(l => l !== lot); save('Position supprimée'); }); break;
    case 'del-event': {
      const ev = lot.events.find(x => x.id === b.dataset.ev);
      confirmSheet('Supprimer ce mouvement ?', `Mouvement du ${fmtDate(ev.date)} sur ${esc(lot.ticker)}.`, 'Supprimer', () => {
        if (ev.imgId) delImage(ev.imgId);
        lot.events = lot.events.filter(x => x !== ev);
        if (ev.type === 'stop') { const prev = lot.events.filter(x => x.type === 'stop').sort((p, q) => p.date < q.date ? -1 : 1).pop(); lot.stopCurrent = prev ? prev.to : lot.stopInitial; }
        save('Mouvement supprimé');
      }); break;
    }
    case 'add-flow': sheetFlow(); break;
    case 'add-catchup': sheetCatchup(); break;
    case 'mt5-import': sheetMt5(); break;
    case 'add-snap': sheetSnap(); break;
    case 'go-health': tab = 'set'; render(); setTimeout(() => { const h = document.getElementById('health'); if (h) h.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 50); break;
    case 'go-tab': tab = b.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'health-radar': sheetWatch(null, b.dataset.t); break;
    case 'health-noradar': { const k = radarSkip(); k.add(b.dataset.t); S.settings.radarSkip = [...k].sort(); save(`${b.dataset.t} : plus proposée au radar`); break; }
    case 'health-noradar-reset': S.settings.radarSkip = []; save('Actions hors radar de nouveau signalées'); break;
    case 'health-px': confirmSheet('Corriger ce cours ?', `${esc(b.dataset.t)} au ${fmtDate(b.dataset.d)} : le cours enregistré devient ${usd(+b.dataset.p)}, le prix de vente.`, 'Corriger', () => { addPrice(b.dataset.t, b.dataset.d, +b.dataset.p); save('Cours corrigé'); }); break;
    case 'motif-sort': sheetMotifSort(); break;
    case 'motif-list': sheetMotifs(); break;
    case 'motif-accept': {
      const sug = window.__msortSug || new Map(); let n = 0;
      for (const [id, sg] of sug) { if (!sg) continue; const f = document.querySelector('#sheetForm'); if (f.querySelector(`input[name="m_${id}"]:checked`)) continue; const r = f.querySelector(`input[name="m_${id}"][value="${sg.k}"]`); if (r) { r.checked = true; n++; } }
      if (sheetCfg && sheetCfg.onInput) sheetCfg.onInput($('#sheetForm')); toast(n ? `${n} suggestion(s) acceptée(s) : vérifiez puis enregistrez` : 'Aucune suggestion à accepter'); break;
    }
    case 'mt5-snooze': try { localStorage.setItem(MT5_SNOOZE, todayISO()); } catch (e) {} render(); break;
    case 'del-flow': confirmSheet('Supprimer ce flux ?', 'La ligne sera retirée des calculs.', 'Supprimer', () => { S.flows = S.flows.filter(x => x.id !== b.dataset.id); save('Flux supprimé'); }); break;
    case 'del-snap': confirmSheet('Supprimer cette valeur courtier ?', 'Elle ne servira plus d’observation.', 'Supprimer', () => { S.snapshots = S.snapshots.filter(x => x.id !== b.dataset.id); save('Valeur supprimée'); }); break;
    case 'export-csv': offerFile('journal-trading-' + todayISO() + '.csv', buildCSV()); break;
    case 'export-json': buildJSON().then(t => offerFile('carnet-positions-' + todayISO() + '.json', t)); break;
    case 'import-json': sheetImport(); break;
    case 'load-demo': loadDemo(); save('Données de démonstration chargées'); break;
    case 'clear-demo': confirmSheet('Effacer la démonstration ?', 'Seules les données marquées « Démo » sont supprimées. Vos propres saisies restent.', 'Effacer la démo', () => { clearDemo(); save('Démonstration effacée'); }); break;
    case 'wipe': confirmSheet('Effacer toutes les données ?', 'Positions, flux, valeurs courtier, cours, réglages et captures seront supprimés. Exportez d’abord en JSON si besoin.', 'Tout effacer', async () => {
      for (const l of S.lots) for (const id of lotImgIds(l)) await delImage(id); S = defaultState(); calcDraft = null; save('Toutes les données ont été effacées'); }); break;
    case 'copy-ta': {
      const ta = $('#exportTa'), text = window.__exportText || ta.value;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Contenu copié'), () => { ta.select(); toast('Sélectionné : copiez avec ⌘C / Ctrl+C'); });
      else { ta.select(); toast('Sélectionné : copiez avec ⌘C / Ctrl+C'); }
      break;
    }
  }
});
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('details.lot')) return;
  if (d.open) { openLots.add(d.dataset.key); loadThumbs(); } else openLots.delete(d.dataset.key);
}, true);
document.addEventListener('input', e => {
  if (e.target.id === 'pos-q') { posQuery = e.target.value; applyPosQuery(); return; }
  if (e.target.id === 'radar-q') { radarQuery = e.target.value; applyRadarQuery(); return; }
  if (e.target.id === 'price-q') {
    const q = e.target.value.trim().toLowerCase();
    for (const r of document.querySelectorAll('#sheet .pr')) r.hidden = !!q && !r.dataset.t.includes(q);
    if (q) for (const d of document.querySelectorAll('#sheet details.more')) d.open = true;
    return;
  }
  const f = e.target.form;
  if (f && f.id === 'calcForm') {
    const el = e.target;
    calcDraft[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.name !== 'ticker') calcDraft.example = false;
    if (el.name === 'fractional') $('#c-decimals').disabled = !el.checked;
    updateCalc();
  } else if (f && f.id === 'sheetForm' && sheetCfg && sheetCfg.onInput) {
    if (e.target.name === 'fee') e.target.dataset.touched = '1';
    sheetCfg.onInput(f);
  }
});
document.addEventListener('change', e => { if (e.target.form && e.target.form.id === 'calcForm' && e.target.type === 'checkbox') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
document.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'setForm') {
    const g = n => form.elements[n].value, s = S.settings;
    const v = { initialCapital: num(g('initialCapital')), riskPct: num(g('riskPct')), cap: num(g('cap')), leverage: num(g('leverage')), staleDays: num(g('staleDays')), decimals: num(g('decimals')), marginMin: num(g('marginMin')), overshoot: numOr(g('overshoot'), 3) };
    const fz = { inFixed: numOr(g('inFixed'), 0), inPct: numOr(g('inPct'), 0), outFixed: numOr(g('outFixed'), 0), outPct: numOr(g('outPct'), 0), perShare: numOr(g('perShare'), 0), minComm: numOr(g('minComm'), 0) };
    const sw = { pct: numOr(g('swapPct'), 0), triple: +g('swapTriple') || 5 };
    const errs = [];
    if (!(v.initialCapital > 0)) errs.push('capital initial');
    if (!(v.riskPct > 0 && v.riskPct <= 100)) errs.push('risque');
    if (!(v.cap > 0)) errs.push('plafond');
    if (!(v.leverage >= 1)) errs.push('levier');
    if (!(v.staleDays >= 0)) errs.push('alerte');
    if (!(v.marginMin >= 50 && v.marginMin <= 1000)) errs.push('seuil de marge (50 à 1000 %)');
    if (!(v.overshoot >= 0 && v.overshoot <= 50)) errs.push('dépassement prévu (0 à 50 %)');
    if (!(Number.isInteger(v.decimals) && v.decimals >= 0 && v.decimals <= 8)) errs.push('précision (entier 0 à 8)');
    if (Object.values(fz).some(x => !(x >= 0))) errs.push('frais');
    if (!(sw.pct >= 0 && sw.pct <= 100)) errs.push('swap (0 à 100 % par an)');
    if (!g('startDate')) errs.push('date de départ');
    if (errs.length) { toast('Valeurs invalides : ' + errs.join(', ')); return; }
    Object.assign(s, v, { fees: fz, swap: sw, fractional: form.elements.fractional.checked, startDate: g('startDate'), refSource: g('refSource') });
    calcDraft = null; save('Réglages enregistrés');
    return;
  }
  if (form.id === 'sheetForm' && sheetCfg && sheetCfg.onSubmit) {
    const btn = $('#sheetOk'); btn.disabled = true;
    try { const cfg = sheetCfg; await cfg.onSubmit(form); if (sheetCfg === cfg) closeSheet(); }
    catch (err) { $('#sheetErr').textContent = err.message || String(err); }
    finally { btn.disabled = false; }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// ---------- Démarrage ----------
(async function boot() {
  const local = readLocal();
  if (local) S = normalize(local);
  try { const h = location.hash.slice(1); if (['dash', 'calc', 'pos', 'radar', 'set'].includes(h)) tab = h; } catch (e) {}
  render();
  setSync('local'); $('#syncText').textContent = 'Connexion à la sauvegarde…';
  const remote = await withTimeout(initRemote(), 11000);
  let seeded = !!local;
  if (remote) {
    try {
      const snap = await Store.ref.get();
      const rd = snap.exists ? snap.data() : null;
      if (rd && (!local || rd.updatedAt > (local.updatedAt || 0))) { S = normalize(JSON.parse(JSON.stringify(rd))); writeLocal(); seeded = true; }
      else if (local) { scheduleRemote(); }
      if (rd) seeded = true;
      setSync('synced');
      subscribeRemote();
    } catch (e) { setSync('error', e && e.code); }
  } else setSync('local');
  if (!seeded) { loadDemo(); save(); }
  else render();
})();
