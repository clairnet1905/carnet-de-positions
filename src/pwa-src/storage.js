// ---------- Stockage : copie sur l'appareil, synchronisée avec un Gist GitHub secret si connecté ----------
const SYNC_KEY = 'carnet-positions:sync', PENDING_KEY = 'carnet-positions:img-pending', CONFLICT_KEY = 'carnet-positions:conflit', EXPORT_KEY = 'carnet-positions:dernier-export', BASE_KEY = 'carnet-positions:base';
const STATE_FILE = 'carnet-positions.json';
const Store = { cfg: null, busy: false, again: false, timer: null, files: {}, lastOk: 0 };
function readLocal() { try { const t = localStorage.getItem(LS_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
function writeLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); return true; } catch (e) { return false; } }
function readJSON(k, d) { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : d; } catch (e) { return d; } }
function writeJSON(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
const fmtTime = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function setSync(s, extra) {
  const el = $('#sync'); el.dataset.s = s === 'saving' ? 'local' : s;
  $('#syncText').textContent = {
    local: 'Données conservées uniquement sur cet appareil',
    synced: 'Synchronisé · ' + fmtTime(Store.lastOk || Date.now()),
    saving: 'Synchronisation…',
    offline: 'Hors ligne · enregistré sur l’appareil, envoi au retour du réseau',
    error: 'Synchronisation impossible' + (extra ? ' (' + extra + ')' : '') + ' · enregistré sur l’appareil'
  }[s];
}
function save(msg) {
  S.updatedAt = Math.max(Date.now(), (S.updatedAt || 0) + 1);
  const okLocal = writeLocal();
  if (Store.cfg) { Store.cfg.dirty = true; writeJSON(SYNC_KEY, Store.cfg); scheduleSync(1500); } else setSync('local');
  if (!okLocal) toast('Attention : le navigateur refuse la sauvegarde locale. Exportez vos données.');
  render();
  if (msg) toast(msg);
}

// Images : IndexedDB (plus de place que localStorage).
const IDB = {
  p: null,
  open() {
    if (!this.p) this.p = new Promise((res, rej) => {
      const r = indexedDB.open('carnet-positions', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('img');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.p;
  },
  async run(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise(res => { const tx = db.transaction('img', mode); const q = fn(tx.objectStore('img')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => res(null); });
    } catch (e) { return null; }
  },
  get(k) { return this.run('readonly', s => s.get(k)); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
  del(k) { return this.run('readwrite', s => s.delete(k)); }
};
function queueImg(id, op) {
  const p = readJSON(PENDING_KEY, {}); p[id] = op; writeJSON(PENDING_KEY, p);
  if (Store.cfg) scheduleSync(1500);
}
async function putImage(id, dataUrl) { await IDB.set(id, dataUrl); queueImg(id, 'put'); }
async function getImage(id) {
  const v = await IDB.get(id);
  if (v) return v;
  const f = Store.files['img-' + id + '.txt'];
  if (f) { try { const t = f.content && !f.truncated ? f.content : await (await fetch(f.raw_url)).text(); await IDB.set(id, t); return t; } catch (e) {} }
  return null;
}
async function delImage(id) { await IDB.del(id); queueImg(id, 'del'); }

// ----- GitHub Gist -----
async function gh(path, opts) {
  opts = opts || {};
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + Store.cfg.token, 'X-GitHub-Api-Version': '2022-11-28' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('https://api.github.com' + path, Object.assign({}, opts, { headers, cache: 'no-store' }));
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'jeton refusé ou expiré' : r.status === 404 ? 'gist introuvable ou jeton sans droit « gist »' : r.status === 403 ? 'accès refusé ou limite atteinte' : 'erreur ' + r.status);
    e.status = r.status; throw e;
  }
  return r.status === 204 ? null : r.json();
}
async function findGist() {
  for (let page = 1; page <= 10; page++) {
    const list = await gh('/gists?per_page=100&page=' + page);
    const g = list.find(x => x.files && x.files[STATE_FILE]);
    if (g) return g.id;
    if (list.length < 100) break;
  }
  return null;
}
async function fetchRemote() {
  const g = await gh('/gists/' + Store.cfg.gistId);
  Store.files = g.files || {};
  const f = Store.files[STATE_FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return normalize(JSON.parse(text));
}
async function pushRemote() {
  const sent = S.updatedAt, body = JSON.stringify(S);
  const files = { [STATE_FILE]: { content: body } };
  const pend = readJSON(PENDING_KEY, {});
  for (const id in pend) {
    if (pend[id] === 'del') { if (Store.files['img-' + id + '.txt']) files['img-' + id + '.txt'] = null; }
    else { const d = await IDB.get(id); if (d) files['img-' + id + '.txt'] = { content: d }; }
  }
  const g = await gh('/gists/' + Store.cfg.gistId, { method: 'PATCH', body: JSON.stringify({ files }) });
  Store.files = g.files || Store.files;
  const now = readJSON(PENDING_KEY, {});
  for (const id in pend) if (now[id] === pend[id]) delete now[id];
  writeJSON(PENDING_KEY, now);
  Store.cfg.syncedRev = sent; Store.cfg.dirty = S.updatedAt !== sent; writeJSON(SYNC_KEY, Store.cfg);
  writeBase(body);
}
// Dernière version commune aux deux appareils : sert à savoir qui a ajouté, modifié ou supprimé quoi.
function writeBase(text) { try { localStorage.setItem(BASE_KEY, text); } catch (e) {} }
function readBase() { try { const t = localStorage.getItem(BASE_KEY); return t ? normalize(JSON.parse(t)) : null; } catch (e) { return null; } }
// Fusion à trois : chaque élément (position, flux, valeur courtier, SMA suivie, cours, réglage) garde le changement fait d'un côté ;
// seul un élément modifié des deux côtés prend la version de l'appareil modifié le plus récemment.
function mergeState(base, loc, rem) {
  const J = JSON.stringify, locWins = loc.updatedAt > rem.updatedAt;
  const pick = (b, l, r) => J(l) === J(r) ? r : b !== undefined && J(b) === J(l) ? r : b !== undefined && J(b) === J(r) ? l : locWins ? l : r;
  const list = (B, L, R, key) => {
    const mb = new Map((B || []).map(x => [key(x), x])), ml = new Map(L.map(x => [key(x), x])), mr = new Map(R.map(x => [key(x), x])), out = [];
    for (const k of new Set([...mr.keys(), ...ml.keys()])) {
      const b = mb.get(k), l = ml.get(k), r = mr.get(k);
      if (l && r) out.push(pick(b, l, r));
      else if (l || r) { const x = l || r; if (!b || J(b) !== J(x)) out.push(x); }  // ajouté d'un côté (gardé), ou supprimé de l'autre sans y avoir été modifié (retiré)
    }
    return out;
  };
  const out = Object.assign({}, locWins ? loc : rem), id = x => x.id;
  for (const k of ['lots', 'flows', 'snapshots', 'watch']) out[k] = list(base && base[k], loc[k], rem[k], id);
  out.prices = {};
  for (const t of new Set([...Object.keys(rem.prices), ...Object.keys(loc.prices)])) {
    const v = list(base && base.prices[t], loc.prices[t] || [], rem.prices[t] || [], x => x.date).sort((a, b) => a.date < b.date ? -1 : 1);
    if (v.length) out.prices[t] = v;
  }
  out.settings = {};
  for (const k of new Set([...Object.keys(rem.settings), ...Object.keys(loc.settings)])) out.settings[k] = pick(base ? base.settings[k] : undefined, loc.settings[k], rem.settings[k]);
  out.push = { vapid: pick(base ? base.push.vapid : undefined, loc.push.vapid, rem.push.vapid), subs: list(base && base.push.subs, loc.push.subs, rem.push.subs, id) };
  out.seen = Object.assign({}, rem.seen);
  for (const k in loc.seen) if (!out.seen[k] || loc.seen[k] > out.seen[k]) out.seen[k] = loc.seen[k];
  out.updatedAt = Math.max(loc.updatedAt, rem.updatedAt) + 1;
  return normalize(out);
}
const hasRealData = st => st && (st.lots.some(l => !l.demo) || st.flows.some(f => !f.demo) || st.snapshots.some(s => !s.demo));
function scheduleSync(ms) { clearTimeout(Store.timer); Store.timer = setTimeout(syncNow, ms || 0); }
// Synchronisation : la version modifiée depuis la dernière synchro gagne ; si les deux ont changé, les deux sont fusionnées (voir mergeState).
// « Modifié » se lit avec un indicateur et un numéro de version, jamais en comparant les horloges des appareils.
async function syncNow() {
  if (!Store.cfg) return;
  if (Store.busy) { Store.again = true; return; }
  Store.busy = true; setSync('saving');
  try {
    const remote = await fetchRemote();
    const localChanged = !!Store.cfg.dirty, remoteChanged = !!remote && remote.updatedAt !== Store.cfg.syncedRev;
    const pend = Object.keys(readJSON(PENDING_KEY, {})).length > 0;
    if (!remote) await pushRemote();
    else if (remoteChanged && !localChanged) adoptRemote(remote);
    else if (remoteChanged && localChanged) {
      if (remote.updatedAt === S.updatedAt) { Store.cfg.syncedRev = S.updatedAt; Store.cfg.dirty = false; writeJSON(SYNC_KEY, Store.cfg); }
      else {
        writeJSON(CONFLICT_KEY, { at: Date.now(), from: 'cet appareil, avant fusion', state: S });
        S = mergeState(readBase(), S, remote); writeLocal(); calcDraft = null; render();
        await pushRemote();
      }
    } else if (localChanged || pend) await pushRemote();
    Store.lastOk = Date.now(); setSync('synced');
    if (tab === 'set') render();
    if (!Store.backupTried) { Store.backupTried = true; setTimeout(() => backupNow().catch(() => {}), 3000); }
  } catch (e) {
    if (e instanceof TypeError || !navigator.onLine) setSync('offline'); else setSync('error', e.message);
  } finally {
    Store.busy = false;
    if (Store.again) { Store.again = false; scheduleSync(300); }
  }
}
function adoptRemote(remote) {
  S = remote; writeLocal(); writeBase(JSON.stringify(remote));
  Store.cfg.syncedRev = remote.updatedAt; Store.cfg.dirty = false; writeJSON(SYNC_KEY, Store.cfg);
  calcDraft = null; render();
}
async function connectGist(token) {
  Store.cfg = { token, gistId: null, syncedRev: null, dirty: false };
  try {
    let id = await findGist();
    if (!id) {
      const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Carnet de positions : données (gist secret, ne pas rendre public)', public: false, files: { [STATE_FILE]: { content: JSON.stringify(S) } } }) });
      id = g.id; Store.files = g.files || {};
      Store.cfg.gistId = id; Store.cfg.syncedRev = S.updatedAt; writeJSON(SYNC_KEY, Store.cfg);
      const p = {}; for (const l of S.lots) for (const i of lotImgIds(l)) p[i] = 'put'; writeJSON(PENDING_KEY, p);
      if (Object.keys(p).length) await pushRemote();
      Store.lastOk = Date.now(); setSync('synced'); render();
      return 'created';
    }
    Store.cfg.gistId = id;
    const remote = await fetchRemote();
    writeJSON(SYNC_KEY, Store.cfg);
    if (!remote || !hasRealData(remote)) { await pushRemote(); Store.lastOk = Date.now(); setSync('synced'); render(); return 'pushed'; }
    if (!hasRealData(S)) { adoptRemote(remote); Store.lastOk = Date.now(); setSync('synced'); return 'pulled'; }
    return { choose: remote };
  } catch (e) { Store.cfg = null; writeJSON(SYNC_KEY, null); throw e; }
}

// ----- Sauvegardes automatiques : une copie datée par semaine, dans un second Gist secret (les 8 dernières) -----
// Gist séparé : la synchronisation, qui lit son Gist toutes les 30 secondes, ne télécharge pas les sauvegardes.
const BACKUP_README = 'carnet-sauvegardes-lisezmoi.md', BACKUP_KEEP = 8, BACKUP_EVERY = 7 * 864e5;
const isBackup = n => /^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(n);
async function backupGist(create) {
  if (Store.cfg.backupId) return Store.cfg.backupId;
  for (let page = 1; page <= 10; page++) {
    const list = await gh('/gists?per_page=100&page=' + page);
    const g = list.find(x => x.files && x.files[BACKUP_README]);
    if (g) { Store.cfg.backupId = g.id; writeJSON(SYNC_KEY, Store.cfg); return g.id; }
    if (list.length < 100) break;
  }
  if (!create) return null;
  const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'Carnet de positions : sauvegardes hebdomadaires (gist secret, ne pas rendre public)', public: false,
    files: { [BACKUP_README]: { content: 'Sauvegardes automatiques du Carnet de positions : une par semaine, les ' + BACKUP_KEEP + ' dernières. Restauration depuis l’app, Réglages › Synchronisation et sauvegarde.' } } }) });
  Store.cfg.backupId = g.id; writeJSON(SYNC_KEY, Store.cfg);
  return g.id;
}
async function listBackups() {
  const id = await backupGist(false);
  if (!id) return [];
  const g = await gh('/gists/' + id);
  return Object.keys(g.files || {}).filter(isBackup).sort().reverse().map(n => ({ name: n, date: n.slice(11, 21), file: g.files[n] }));
}
async function readBackup(b) {
  const f = b.file, text = f.truncated || f.content == null ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return normalize(JSON.parse(text));
}
// force : bouton « Sauvegarder maintenant ». Sinon, au plus une fois par semaine (toutes appareils confondus).
async function backupNow(force) {
  if (!Store.cfg || !hasRealData(S)) return false;
  if (!force && Date.now() - (Store.cfg.lastBackup || 0) < BACKUP_EVERY) return false;
  const id = await backupGist(true);
  const names = Object.keys((await gh('/gists/' + id)).files || {}).filter(isBackup).sort();
  const latest = names.length ? Date.parse(names[names.length - 1].slice(11, 21) + 'T12:00:00') : 0;
  if (!force && Date.now() - latest < BACKUP_EVERY) { Store.cfg.lastBackup = latest; writeJSON(SYNC_KEY, Store.cfg); return false; }
  const name = 'sauvegarde-' + todayISO() + '.json', files = { [name]: { content: JSON.stringify(S) } };
  const all = [...new Set(names.concat(name))].sort();
  for (const n of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) files[n] = null;
  await gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify({ files }) });
  Store.cfg.lastBackup = Date.now(); writeJSON(SYNC_KEY, Store.cfg);
  if (tab === 'set') render();
  return true;
}

// ----- Historique du radar tenu par le robot GitHub (Gist « carnet-radar.json ») -----
// Le robot télécharge une fois par soir l'historique de toutes les actions suivies ; chaque appareil le récupère
// en un seul fichier au lieu d'interroger Twelve Data action par action.
const RADAR_FILE = 'carnet-radar.json', RADAR_META = 'carnet-positions:radar-robot';
function unpackHist(p) {
  const bars = []; let d = p.s;
  for (let i = 0; i < p.c.length; i++) { if (i) d = addDays(d, p.o[i]); bars.push([d, p.c[i]]); }
  return { bars, n: p.n, full: p.full || 0, last: bars.length ? bars[bars.length - 1][0] : '' };
}
function robotFresh(meta) { return !!meta && meta.ls >= prevWeekday(lastSession(Date.now())); }
// throttle : au plus une vérification toutes les 10 minutes (une petite requête ; le fichier n'est téléchargé que s'il a changé).
async function pullSharedRadar(throttle) {
  if (!Store.cfg || Store.radarBusy) return;
  if (!Radar.robot) { Radar.robot = readJSON(RADAR_META, null); Radar.shared = robotFresh(Radar.robot); }
  if (throttle && Date.now() - (Store.radarCheck || 0) < 600000) return;
  Store.radarBusy = true; Store.radarCheck = Date.now();
  try {
    if (!Store.cfg.radarId) {
      for (let page = 1; page <= 10 && !Store.cfg.radarId; page++) {
        const list = await gh('/gists?per_page=100&page=' + page);
        const g = list.find(x => x.files && x.files[RADAR_FILE]);
        if (g) { Store.cfg.radarId = g.id; writeJSON(SYNC_KEY, Store.cfg); }
        if (list.length < 100) break;
      }
      if (!Store.cfg.radarId) return;
    }
    const c = await gh('/gists/' + Store.cfg.radarId + '/commits?per_page=1');
    const ver = c && c[0] && c[0].version;
    if (Radar.robot && Radar.robot.ver === ver && Lab.ver === ver) return;
    const g = await gh('/gists/' + Store.cfg.radarId), f = g.files[RADAR_FILE], lf = g.files['carnet-lab.json'];
    if (Lab.ver !== ver) {
      try { setLab(lf ? JSON.parse(lf.truncated || lf.content == null ? await (await fetch(lf.raw_url, { cache: 'no-store' })).text() : lf.content) : null, ver); } catch (e) {}
      if (tab === 'lab') render();
    }
    if (Radar.robot && Radar.robot.ver === ver) return;
    const R = JSON.parse(f.truncated || f.content == null ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content);
    await loadRadarCache();
    const upd = {};
    for (const s in R.hist) {
      const h = unpackHist(R.hist[s]), loc = Radar.hist[s];
      h.adj = R.adj || 'splits';
      if (!h.bars.length || loc && histOk(loc) && !histOk(h)) continue;   // garder l'historique de l'appareil s'il est seul au bon réglage
      if (!loc || histOk(loc) !== histOk(h) || h.last > loc.last || (h.last === loc.last && (h.full || 0) >= (loc.full || 0)) || h.n > (loc.n || 0)) upd[s] = Object.assign(h, { ls: R.ls, at: R.at });
    }
    Object.assign(Radar.hist, upd);
    await HDB.run('readwrite', st => { for (const s in upd) st.put(upd[s], s); return null; });
    Radar.robot = { ver, ls: R.ls, at: R.at, n: Object.keys(R.hist).length, run: (R.log || [])[0] || null, dead: R.deadSubs || [], errors: Object.keys(R.errors || {}).length, adj: R.adj || 'splits', divfix: R.divfix || {} };
    writeJSON(RADAR_META, Radar.robot);
    Radar.shared = robotFresh(Radar.robot);
    if (tab !== 'calc') render();
  } finally { Store.radarBusy = false; }
}

// ----- Notifications push -----
const VAPID_PRIV = 'carnet-positions:vapid-prive', PUSH_ID = 'carnet-positions:push-id';
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)), ch => ch.charCodeAt(0));
function repoInfo() {
  const own = /\.github\.io$/.test(location.hostname) ? location.hostname.split('.')[0] : 'clairnet1905';
  const rep = /\.github\.io$/.test(location.hostname) ? location.pathname.split('/')[1] : 'carnet-de-positions';
  return 'https://github.com/' + own + '/' + rep;
}
async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), priv: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d };
}
const deviceLabel = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC Windows' : 'Appareil'; };
async function pushOn() {
  if (!S.push.vapid) throw new Error('Créez d’abord les clés de notification.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications refusées. Autorisez-les dans les réglages de l’appareil, puis réessayez.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey && b64u(sub.options.applicationServerKey) !== S.push.vapid) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(S.push.vapid) });
  const j = sub.toJSON(), id = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(j.endpoint))).slice(0, 16);
  writeJSON(PUSH_ID, id);
  S.push.subs = S.push.subs.filter(x => x.id !== id).concat([{ id, endpoint: j.endpoint, keys: j.keys, label: deviceLabel(), at: todayISO() }]);
  save('Notifications activées sur cet appareil');
}
async function pushOff(id) {
  if (id === readJSON(PUSH_ID, null)) {
    try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
    writeJSON(PUSH_ID, null);
  }
  S.push.subs = S.push.subs.filter(x => x.id !== id);
  save('Appareil retiré des notifications');
}
function showPrivKey() {
  const k = readJSON(VAPID_PRIV, null); if (!k) return;
  openSheet({ title: 'Clé privée de notification', body: `<p class="lead">Copiez cette clé dans un secret du dépôt GitHub nommé <strong>VAPID_PRIVATE_KEY</strong> (Settings › Secrets and variables › Actions › New repository secret). Ne la partagez pas : elle permet d’envoyer des notifications à vos appareils.</p>
    <div class="fields"><div class="fld wide"><label for="f-vk">Clé privée</label><input id="f-vk" readonly value="${esc(k)}" autocomplete="off" spellcheck="false"></div></div>
    <div class="row"><button type="button" class="btn primary" data-act="push-copy">Copier la clé</button><a class="btn" href="${repoInfo()}/settings/secrets/actions/new" target="_blank" rel="noopener">Ouvrir les secrets GitHub</a></div>` });
}
function notifPanel() {
  const P = S.push, rb = Radar.robot, repo = repoInfo(), myId = readJSON(PUSH_ID, null);
  const ios = /iPhone|iPad/.test(navigator.userAgent), standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  const can = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const mine = myId && P.subs.some(x => x.id === myId);
  const ok = b => b ? '<b class="ok-tick">✓</b> ' : '';
  const dev = !can ? (ios && !standalone ? 'Sur iPhone, ouvrez l’app depuis son icône sur l’écran d’accueil (iOS 16.4 ou plus), puis revenez ici.' : 'Ce navigateur ne gère pas les notifications web.')
    : Notification.permission === 'denied' ? 'Notifications refusées pour cette app : autorisez-les dans les réglages de l’appareil (sur iPhone : Réglages › Notifications › Carnet).'
    : mine ? 'Cet appareil reçoit les notifications.' : `<button class="btn sm primary" data-act="push-on" ${P.vapid ? '' : 'disabled'}>Activer sur cet appareil</button>`;
  const run = rb && rb.run;
  const robot = rb ? `Robot : dernier passage le ${new Date(rb.at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} (séance du ${fmtDate(rb.ls)}) · ${rb.n} action(s) à jour${run ? ` · ${run.signals} signal(aux), ${run.sent} notification(s) envoyée(s)` : ''}${rb.errors ? ` · ${rb.errors} action(s) en erreur` : ''}.`
    : 'Robot : pas encore passé. Après l’étape 4, l’historique commun apparaît ici.';
  const subs = P.subs.map(x => `<li>${esc(x.label || 'Appareil')}${x.id === myId ? ' (cet appareil)' : ''} · depuis le ${fmtDate(x.at)}${rb && rb.dead.includes(x.id) ? ' · <strong>expiré, réactivez-le</strong>' : ''} <button class="btn sm" data-act="push-off" data-id="${esc(x.id)}">Retirer</button></li>`).join('');
  return `<div class="sec-head" style="margin-top:18px"><h2>Notifications et historique commun</h2></div>
    <p class="lead">Chaque soir de bourse, un robot GitHub gratuit met à jour l’historique de toutes vos actions suivies, une fois pour tous vos appareils, et vous envoie une notification pour chaque nouveau croisement de SMA, même app fermée.</p>
    <ol class="lead" style="padding-left:18px;margin:0;display:grid;gap:8px">
      <li>${ok(P.vapid)}${P.vapid ? `Clés de notification créées.${readJSON(VAPID_PRIV, null) ? ' <button class="btn sm" data-act="push-showkey">Voir la clé privée</button>' : ''}` : 'Créez les clés de notification (une seule fois, sur un seul appareil). <button class="btn sm primary" data-act="push-keys">Créer les clés</button>'}</li>
      <li>${ok(rb)}Dans <a href="${repo}/settings/secrets/actions" target="_blank" rel="noopener">GitHub › Settings › Secrets › Actions</a>, ajoutez ces secrets (« New repository secret ») : <strong>GIST_TOKEN</strong> (votre jeton <code>ghp_</code> de la synchronisation), <strong>TWELVEDATA_KEY</strong>, <strong>FINNHUB_KEY</strong> (facultatif, plus rapide) et <strong>VAPID_PRIVATE_KEY</strong> (la clé privée de l’étape 1).</li>
      <li>${ok(mine)}${dev}</li>
      <li>${ok(rb && run)}Lancez un essai : <a href="${repo}/actions/workflows/radar.yml" target="_blank" rel="noopener">GitHub › Actions › Radar SMA</a> › « Run workflow ». Une notification de test arrive en 1 à 2 minutes ; le premier passage télécharge l’historique de toutes les actions (environ 25 minutes). Ensuite, le robot passe seul chaque soir vers 22 h 20 (heure de Paris).</li>
    </ol>
    <p class="hint">${robot}</p>
    ${subs ? `<ul class="hint" style="padding-left:18px">${subs}</ul>` : ''}
    <label class="check" style="margin-top:6px"><input type="checkbox" data-act="push-near" ${S.settings.pushNear ? 'checked' : ''}> Notifier aussi les actions proches de leur SMA (plus de notifications)</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" data-act="push-opt" data-k="pushStops" ${S.settings.pushStops !== false ? 'checked' : ''}> Stops à remonter sur une de vos SMA</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" data-act="push-opt" data-k="pushEarn" ${S.settings.pushEarn !== false ? 'checked' : ''}> Résultats d’une position le jour de bourse suivant</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" data-act="push-opt" data-k="pushWeekly" ${S.settings.pushWeekly !== false ? 'checked' : ''}> Bilan de la semaine, le vendredi soir</label>
    <label class="check" style="margin-top:6px"><input type="checkbox" data-act="push-opt" data-k="pushWeak" ${S.settings.pushWeak !== false ? 'checked' : ''}> Labo : une de mes SMA du radar jugée faible</label>
    <p class="hint">Une alerte déjà vue dans l’app n’est jamais notifiée. Le jeton et les clés restent dans les secrets GitHub : ni dans le code, ni dans le Gist.</p>`;
}
