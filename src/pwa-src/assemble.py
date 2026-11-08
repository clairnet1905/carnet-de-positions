import os, sys, shutil, json
from PIL import Image, ImageDraw

B = sys.argv[1]; OUT = sys.argv[2]
VERSION = '1.53.0'
os.makedirs(OUT, exist_ok=True)
shell = open(os.path.join(B, 'carnet', 'shell.html'), encoding='utf-8').read()
shell = shell.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
core = open(os.path.join(B, 'carnet', 'core.js'), encoding='utf-8').read()
app = open(os.path.join(B, 'pwa-src', 'app.js'), encoding='utf-8').read().replace('__APP_VERSION__', VERSION)
head = f'''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Calculateur de taille de position, journal et performance de trading. Open source, données sur vos appareils.">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151D25" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Carnet">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}img{{max-width:100%}}</style>
'''
body = shell.replace('<header class="top">', '</head>\n<body>\n<header class="top">', 1)
html = head + body + '<script>\n/* Carnet de positions v' + VERSION + ' · licence MIT */\n' + core + '\n' + app + '</script>\n</body>\n</html>\n'
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(html)

manifest = {
    'name': 'Carnet de positions', 'short_name': 'Carnet', 'lang': 'fr',
    'description': 'Taille de position à 1 % de risque, journal et performance de trading.',
    'start_url': './', 'scope': './', 'display': 'standalone', 'background_color': '#F2F4F7', 'theme_color': '#1E3A5F',
    'icons': [
        {'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
        {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
        {'src': 'icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}]}
json.dump(manifest, open(os.path.join(OUT, 'manifest.webmanifest'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

sw = f'''// Page : réseau d'abord (sans cache HTTP) pour voir chaque mise à jour dès l'ouverture, copie locale si hors ligne.
// Icônes et polices : cache d'abord, mises à jour en arrière-plan.
const CACHE = 'carnet-v{VERSION}';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png'];
self.addEventListener('install', e => {{ e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {{ cache: 'reload' }})))).then(() => self.skipWaiting())); }});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'carnet-badge').map(k => caches.delete(k)))).then(() => self.clients.claim()));
}});
// Notifications du robot radar (GitHub Actions) : affichées même app fermée ; un toucher ouvre le radar.
self.addEventListener('push', e => {{
  let d = {{}};
  try {{ d = e.data ? e.data.json() : {{}}; }} catch (err) {{ d = {{ body: e.data ? e.data.text() : '' }}; }}
  // Pastille sur l'icône : compte gardé par l'app + éléments de cette notification (stops, croisements).
  const bump = d.badge > 0 && self.navigator.setAppBadge ? caches.open('carnet-badge').then(async c => {{
    const r = await c.match('./badge-n'), n = (r ? parseInt(await r.text(), 10) || 0 : 0) + d.badge;
    await c.put('./badge-n', new Response(String(n))); await self.navigator.setAppBadge(n);
  }}).catch(() => {{}}) : Promise.resolve();
  e.waitUntil(Promise.all([bump, self.registration.showNotification(d.title || 'Carnet de positions', {{ body: d.body || '', tag: d.tag || 'radar', icon: 'icon-192.png', badge: 'icon-192.png', data: {{ url: d.url || './#radar' }} }})]));
}});
self.addEventListener('notificationclick', e => {{
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './#radar', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({{ type: 'window', includeUncontrolled: true }}).then(list => {{
    for (const c of list) if ('focus' in c) {{ if ('navigate' in c) c.navigate(url).catch(() => {{}}); return c.focus(); }}
    return self.clients.openWindow(url);
  }}));
}});
self.addEventListener('fetch', e => {{
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname === 'api.github.com' || url.hostname.endsWith('githubusercontent.com')) return;
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) return;
  const page = sameOrigin && (e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
  if (page) {{
    e.respondWith((async () => {{
      const c = await caches.open(CACHE);
      const cached = () => c.match('./index.html').then(h => h || c.match('./'));
      const net = fetch(url.origin + url.pathname, {{ cache: 'no-cache' }}).then(r => {{ if (r.ok) c.put('./index.html', r.clone()); return r; }});
      const slow = new Promise(res => setTimeout(res, 4000)).then(cached);
      try {{ return await Promise.race([net, slow.then(h => h || net)]); }} catch (err) {{ return (await cached()) || Response.error(); }}
    }})());
    return;
  }}
  e.respondWith(caches.open(CACHE).then(async c => {{
    const hit = await c.match(e.request, {{ ignoreSearch: sameOrigin }});
    const net = fetch(e.request, {{ cache: 'no-cache' }}).then(r => {{ if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()); return r; }}).catch(() => hit);
    return hit || net;
  }}));
}});
'''
open(os.path.join(OUT, 'sw.js'), 'w', encoding='utf-8').write(sw)

# Icône : courbe de tendance ascendante au-dessus d'un stop en pointillés
def icon(size, pad=0.0):
    S = 1024
    im = Image.new('RGB', (S, S), (30, 58, 95))
    d = ImageDraw.Draw(im)
    m = int(S * (0.16 + pad))
    x0, x1, y0, y1 = m, S - m, m + 40, S - m - 40
    pts = [(0, .78), (.18, .62), (.32, .68), (.5, .42), (.64, .48), (.82, .2), (1, .12)]
    P = [(x0 + (x1 - x0) * a, y0 + (y1 - y0) * b) for a, b in pts]
    poly = P + [(x1, y1), (x0, y1)]
    d.polygon(poly, fill=(46, 84, 130))
    d.line(P, fill=(255, 255, 255), width=int(S * 0.045), joint='curve')
    for x, y in (P[0], P[-1]):
        r = S * 0.035; d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))
    ys = y0 + (y1 - y0) * .9
    seg, gap = S * 0.05, S * 0.035
    x = x0
    while x < x1:
        d.line([(x, ys), (min(x + seg, x1), ys)], fill=(242, 140, 128), width=int(S * 0.028))
        x += seg + gap
    return im.resize((size, size), Image.LANCZOS)
icon(180).save(os.path.join(OUT, 'apple-touch-icon.png'))
icon(192).save(os.path.join(OUT, 'icon-192.png'))
icon(512).save(os.path.join(OUT, 'icon-512.png'))
icon(512, pad=0.07).save(os.path.join(OUT, 'icon-maskable-512.png'))
icon(32).save(os.path.join(OUT, 'icon-32.png'))
print('assembled', OUT, len(html))
