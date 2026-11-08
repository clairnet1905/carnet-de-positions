import re, sys, os
SRC = sys.argv[1]; OUT = sys.argv[2]; HERE = os.path.dirname(os.path.abspath(__file__))
s = open(SRC, encoding='utf-8').read()
storage = open(os.path.join(HERE, 'storage.js'), encoding='utf-8').read()

def cut(a, b, new):
    global s
    i = s.index(a); j = s.index(b, i)
    s = s[:i] + new + s[j:]

# 1. Module de stockage
cut('// ---------- Stockage : copie locale', 'function readImageFile(file)', storage)

# 2. Export : partage sur iPhone, téléchargement sur Mac
cut('async function offerFile(filename, text) {', 'function parseBackup(text)', '''async function offerFile(filename, text) {
  const type = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
  const file = new File([text], filename, { type });
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e && e.name === 'AbortError') { toast('Export annulé'); return false; } }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Fichier enregistré : ' + filename);
  return true;
}
''')

# 3. Section Sauvegarde des réglages
cut('''    <div class="banner ${Store.ref ? 'info' : 'warn'}">''', '''    <div class="row">
      <button class="btn" data-act="export-csv">''', '''    ${syncPanel()}
''')
s = s.replace('''  <section class="card">
    <div class="sec-head"><h2>Sauvegarde et données</h2></div>''', '''  <section class="card">
    <div class="sec-head"><h2>Synchronisation et sauvegarde</h2></div>''')
s = s.replace("n’utilise aucune API de cotation : les cours se saisissent à la main.</p>",
              "n’utilise aucune API de cotation : les cours se saisissent à la main. Code open source (licence MIT).</p>")

panel = r'''
function syncPanel() {
  const conflict = readJSON(CONFLICT_KEY, null);
  const lastExp = readJSON(EXPORT_KEY, null);
  const conf = conflict ? `<div class="banner warn"><span>Une version mise de côté (${esc(conflict.from)}, ${new Date(conflict.at).toLocaleString('fr-FR')}) peut être restaurée si la synchronisation a gardé la mauvaise.</span><button class="btn sm" data-act="restore-conflict">Restaurer</button><button class="btn sm" data-act="drop-conflict">Oublier</button></div>` : '';
  const nSym = new Set(S.watch.map(symOf)), nHave = [...nSym].filter(x => Radar.hist[x]).length;
  const exp = `<p class="hint">Dernier export JSON sur cet appareil : ${lastExp ? new Date(lastExp).toLocaleDateString('fr-FR') : 'jamais'}.</p>
    <p class="hint"><strong>Cet appareil</strong> : version __APP_VERSION__ · ${S.lots.length} position(s) · ${S.watch.length} SMA · historique radar ${nHave}/${nSym.size} · données modifiées le ${S.updatedAt ? new Date(S.updatedAt).toLocaleString('fr-FR') : '—'}. Comparez cette ligne sur vos deux appareils : elle doit être identique, sauf l’historique radar.</p>`;
  if (Store.cfg) return `<div class="banner info"><span><strong>Synchronisation active</strong> avec votre Gist GitHub secret. Chaque appareil garde aussi sa copie : l’app fonctionne hors ligne et renvoie les changements au retour du réseau.
      ${Store.lastOk ? 'Dernière synchronisation à ' + fmtTime(Store.lastOk) + '.' : ''}</span></div>
    <div class="row"><button class="btn primary" data-act="sync-now">Synchroniser maintenant</button>
      <a class="btn" href="https://gist.github.com/${esc(Store.cfg.gistId)}/revisions" target="_blank" rel="noopener">Historique des versions</a>
      <button class="btn danger" data-act="sync-off">Déconnecter cet appareil</button></div>
    <div class="banner info"><span><strong>Sauvegarde automatique</strong> chaque semaine dans un second Gist secret, les ${BACKUP_KEEP} dernières gardées (positions, flux, cours, radar ; les captures restent dans le Gist principal).
      ${Store.cfg.lastBackup ? 'Dernière : ' + new Date(Store.cfg.lastBackup).toLocaleDateString('fr-FR') + '.' : 'Première sauvegarde à la prochaine synchronisation.'}</span></div>
    <div class="row"><button class="btn" data-act="backup-now">Sauvegarder maintenant</button><button class="btn" data-act="backup-list">Restaurer une sauvegarde…</button></div>${conf}${exp}${notifPanel()}`;
  return `<div class="banner warn"><span><strong>Données conservées uniquement sur cet appareil.</strong> Connectez GitHub pour synchroniser Mac et iPhone, ou exportez régulièrement en JSON.</span></div>
    <details class="lot"><summary><span><span class="tk">Activer la synchronisation</span><br><small>Gratuit, avec votre compte GitHub. Environ 2 minutes, une fois par appareil.</small></span><span class="pill open">Guide</span></summary>
    <div class="body">
      <ol class="lead" style="padding-left:18px;margin:0;display:grid;gap:6px">
        <li>Ouvrez <a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Carnet%20de%20positions" target="_blank" rel="noopener">GitHub › nouveau jeton (classic)</a>, connecté à votre compte.</li>
        <li>Laissez cochée uniquement la case <strong>gist</strong>, choisissez une expiration (par exemple « No expiration »), puis <strong>Generate token</strong>.</li>
        <li>Copiez le jeton (il commence par <code>ghp_</code>) et collez-le ci-dessous. Gardez-le dans vos mots de passe pour l’autre appareil.</li>
      </ol>
      <div class="fields"><div class="fld wide"><label for="sync-token">Jeton GitHub (droit gist uniquement)</label><input id="sync-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_…"></div></div>
      <div class="row"><button class="btn primary" data-act="sync-on">Connecter</button></div>
      <p class="hint">Vos données vont dans un Gist <strong>secret</strong> de votre compte : invisible dans votre profil, mais lisible par quiconque obtiendrait son adresse. Le jeton reste sur cet appareil et ne permet que de lire et écrire vos gists.</p>
    </div></details>${conf}${exp}`;
}
'''
s = s.replace('// ---------- Feuilles de saisie ----------', panel + '\n// ---------- Feuilles de saisie ----------', 1)

# 4. Rappel d'export si pas de synchronisation
s = s.replace('''function demoBanner() {
  return hasDemo()''', '''function demoBanner() {
  const lastExp = readJSON(EXPORT_KEY, null);
  const remind = !Store.cfg && hasRealData(S) && (!lastExp || Date.now() - lastExp > 7 * 864e5)
    ? `<div class="banner warn"><span>Vos données ne sont que sur cet appareil et n’ont pas été exportées depuis ${lastExp ? 'plus de 7 jours' : 'le début'}.</span><button class="btn sm" data-act="go-set">Sauvegarder</button></div>` : '';
  return remind + (hasDemo()''')
s = s.replace('''<button class="btn sm" data-act="clear-demo">Effacer la démo</button></div>` : '';
}''', '''<button class="btn sm" data-act="clear-demo">Effacer la démo</button></div>` : '');
}''', 1)

# 5. Actions
s = s.replace("    case 'export-json': buildJSON().then(t => offerFile('carnet-positions-' + todayISO() + '.json', t)); break;",
"""    case 'export-json': buildJSON().then(t => offerFile('carnet-positions-' + todayISO() + '.json', t)).then(ok => { if (ok) { writeJSON(EXPORT_KEY, Date.now()); if (tab === 'set') render(); } }); break;
    case 'go-set': tab = 'set'; render(); window.scrollTo(0, 0); break;
    case 'sync-now': syncNow(); break;
    case 'sync-on': {
      const tk = ($('#sync-token').value || '').trim();
      if (!/^(ghp_|github_pat_|gho_)[A-Za-z0-9_]{20,}$/.test(tk)) { toast('Collez un jeton GitHub valide (ghp_…).'); break; }
      if (tk.startsWith('github_pat_')) toast('Les jetons « fine-grained » ne gèrent pas les gists : créez un jeton classic.');
      b.disabled = true; setSync('saving');
      connectGist(tk).then(res => {
        if (res && res.choose) {
          const remote = res.choose;
          openSheet({ title: 'Quelles données garder ?', ok: 'Valider',
            body: `<p class="lead">Cet appareil et votre compte contiennent chacun des données. Choisissez celles à garder sur tous vos appareils. L’autre version est mise de côté et reste restaurable.</p>
              <div class="fields"><div class="fld wide"><label for="f-keep">Garder</label><select id="f-keep" name="keep">
              <option value="remote">Données du compte : ${remote.lots.length} position(s), modifiées le ${new Date(remote.updatedAt).toLocaleString('fr-FR')}</option>
              <option value="local">Données de cet appareil : ${S.lots.length} position(s), modifiées le ${new Date(S.updatedAt).toLocaleString('fr-FR')}</option></select></div></div>`,
            onSubmit: async form => {
              if (F(form, 'keep') === 'remote') { writeJSON(CONFLICT_KEY, { at: Date.now(), from: 'cet appareil', state: S }); adoptRemote(remote); }
              else { writeJSON(CONFLICT_KEY, { at: Date.now(), from: 'en ligne', state: remote }); S.updatedAt = Date.now(); writeLocal(); await pushRemote(); }
              Store.lastOk = Date.now(); setSync('synced'); render(); toast('Synchronisation activée');
            } });
        } else toast(res === 'pulled' ? 'Synchronisation activée : données récupérées' : 'Synchronisation activée');
      }, e => { setSync('error', e.message); toast('Connexion impossible : ' + (e instanceof TypeError ? 'pas de réseau' : e.message)); b.disabled = false; });
      break;
    }
    case 'sync-off': confirmSheet('Déconnecter cet appareil ?', 'Les données restent sur cet appareil et dans votre Gist. Cet appareil ne se synchronisera plus et le jeton y sera effacé.', 'Déconnecter', () => {
      Store.cfg = null; writeJSON(SYNC_KEY, null); setSync('local'); render(); toast('Appareil déconnecté'); }); break;
    case 'restore-conflict': confirmSheet('Restaurer la version mise de côté ?', 'Elle remplacera les données actuelles sur tous vos appareils. La version actuelle sera mise de côté à son tour.', 'Restaurer', () => {
      const c = readJSON(CONFLICT_KEY, null); if (!c) return;
      writeJSON(CONFLICT_KEY, { at: Date.now(), from: 'avant restauration', state: S });
      S = normalize(c.state); calcDraft = null; save('Version restaurée'); }); break;
    case 'drop-conflict': writeJSON(CONFLICT_KEY, null); render(); break;
    case 'push-keys': {
      const go = () => makeVapid().then(k => { writeJSON(VAPID_PRIV, k.priv); S.push.vapid = k.pub; S.push.subs = []; save('Clés de notification créées'); showPrivKey(); }, e => toast('Création impossible : ' + e.message));
      if (S.push.subs.length) confirmSheet('Recréer les clés ?', 'Les appareils déjà abonnés devront réactiver les notifications, et le secret VAPID_PRIVATE_KEY devra être remplacé.', 'Recréer', go); else go();
      break;
    }
    case 'push-showkey': showPrivKey(); break;
    case 'push-copy': { const k = readJSON(VAPID_PRIV, null); if (k && navigator.clipboard) navigator.clipboard.writeText(k).then(() => toast('Clé copiée'), () => toast('Copie impossible : sélectionnez la clé à la main')); break; }
    case 'push-on': b.disabled = true; pushOn().catch(e => { toast(e.message); b.disabled = false; }); break;
    case 'push-off': pushOff(b.dataset.id); break;
    case 'push-near': S.settings.pushNear = b.checked; save(b.checked ? 'Notifications « proche » activées' : 'Notifications « proche » désactivées'); break;
    case 'push-opt': S.settings[b.dataset.k] = b.checked; save(b.checked ? 'Notification activée' : 'Notification désactivée'); break;
    case 'backup-now': b.disabled = true; toast('Sauvegarde en cours…');
      backupNow(true).then(ok => toast(ok ? 'Sauvegarde du ' + fmtDate(todayISO()) + ' enregistrée' : 'Rien à sauvegarder'), e => { toast('Sauvegarde impossible : ' + (e instanceof TypeError ? 'pas de réseau' : e.message)); b.disabled = false; }); break;
    case 'backup-list': b.disabled = true;
      listBackups().then(async list => {
        b.disabled = false;
        if (!list.length) { toast('Aucune sauvegarde pour le moment'); return; }
        const data = await Promise.all(list.map(x => readBackup(x).catch(() => null)));
        const opts = list.map((x, i) => data[i] ? `<option value="${i}">${fmtDate(x.date)} · ${data[i].lots.length} position(s), ${data[i].watch.length} SMA</option>` : '').join('');
        openSheet({ title: 'Restaurer une sauvegarde', ok: 'Restaurer',
          body: `<p class="lead">Les données choisies remplaceront les données actuelles sur tous vos appareils. Les données actuelles sont mises de côté et restent restaurables (Réglages).</p>
            <p class="lead">Actuellement : ${S.lots.length} position(s), ${S.watch.length} SMA.</p>
            <div class="fields"><div class="fld wide"><label for="f-bk">Sauvegarde</label><select id="f-bk" name="bk">${opts}</select></div></div>`,
          onSubmit: form => {
            const i = +F(form, 'bk'), st = data[i];
            need(st, 'Sauvegarde illisible.');
            writeJSON(CONFLICT_KEY, { at: Date.now(), from: 'avant restauration de la sauvegarde du ' + fmtDate(list[i].date), state: S });
            S = normalize(JSON.parse(JSON.stringify(st))); calcDraft = null; save('Sauvegarde du ' + fmtDate(list[i].date) + ' restaurée');
          } });
      }, e => { b.disabled = false; toast('Lecture impossible : ' + (e instanceof TypeError ? 'pas de réseau' : e.message)); }); break;""")

# 6. Démarrage
cut('// ---------- Démarrage ----------', '\x00' if False else '})();\n', '''// ---------- Démarrage ----------
(function boot() {
  const local = readLocal();
  if (local) S = normalize(local);
  try { const h = location.hash.slice(1); if (['dash', 'calc', 'pos', 'radar', 'ana', 'set', 'lab', 'earn'].includes(h)) tab = h; } catch (e) {}
  Store.cfg = readJSON(SYNC_KEY, null);
  if (!local) { loadDemo(); S.updatedAt = 0; writeLocal(); }
  migrateSeen();
  migrateFees();
  migrateIdx();
  render();
  if (Store.cfg) { setSync('saving'); syncNow(); } else setSync('local');
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (['dash', 'calc', 'pos', 'radar', 'ana', 'set', 'lab', 'earn'].includes(h) && h !== tab) { tab = h; render(); window.scrollTo(0, 0); } });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Cours automatiques : à l'ouverture, au retour sur l'app, puis toutes les 2 minutes pendant la séance.
  refreshQuotes();
  // Historique du radar : d'abord celui du robot (Gist), puis Twelve Data seulement pour ce qui manque.
  const radarUp = throttle => (Store.cfg ? pullSharedRadar(throttle).catch(() => {}) : Promise.resolve()).then(() => refreshRadar());
  loadRadarCache().then(() => { render(); radarUp(false); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { badgeN = -1; badgeSoon(); if (Date.now() - Live.at > 60000) refreshQuotes(); radarUp(true); } });
  setInterval(() => { if (document.visibilityState === 'visible' && tab !== 'calc' && marketOpen(Date.now())) refreshQuotes(false, Date.now() - (Live.fullAt || 0) < 600000); }, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Store.cfg) scheduleSync(200); });
  window.addEventListener('online', () => { if (Store.cfg) scheduleSync(200); });
  window.addEventListener('pageshow', e => { if (e.persisted && Store.cfg) scheduleSync(200); });
  setInterval(() => { if (Store.cfg && document.visibilityState === 'visible') syncNow(); }, 30000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadCtrl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtrl && $('#sheet').hidden) location.reload(); });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); }); }).catch(() => {});
  }
''')
assert 'Store.caps' not in s and 'Store.ref' not in s and 'window.claude' not in s, 'reste claude'
open(OUT, 'w', encoding='utf-8').write(s)
print('ok', len(s))
