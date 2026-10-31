// Page : réseau d'abord (sans cache HTTP) pour voir chaque mise à jour dès l'ouverture, copie locale si hors ligne.
// Icônes et polices : cache d'abord, mises à jour en arrière-plan.
const CACHE = 'carnet-v1.13.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Notifications du robot radar (GitHub Actions) : affichées même app fermée ; un toucher ouvre le radar.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Carnet de positions', { body: d.body || '', tag: d.tag || 'radar', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './#radar' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './#radar', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { if ('navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname === 'api.github.com' || url.hostname.endsWith('githubusercontent.com')) return;
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return;
  const page = sameOrigin && (e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
  if (page) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const cached = () => c.match('./index.html').then(h => h || c.match('./'));
      const net = fetch(url.origin + url.pathname, { cache: 'no-cache' }).then(r => { if (r.ok) c.put('./index.html', r.clone()); return r; });
      const slow = new Promise(res => setTimeout(res, 4000)).then(cached);
      try { return await Promise.race([net, slow.then(h => h || net)]); } catch (err) { return (await cached()) || Response.error(); }
    })());
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: sameOrigin });
    const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
