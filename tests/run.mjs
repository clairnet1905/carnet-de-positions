// Lance tous les tests sur l'app assemblée (dossier passé en argument, _site par défaut) et écrit build.json.
// Sort en erreur si un test échoue : GitHub Actions ne met alors rien en ligne.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';

const site = process.argv[2] || '_site';
const results = [];

// 1. Moteur de calcul, sans navigateur.
const ctx = vm.createContext({});
vm.runInContext(readFileSync('src/carnet/core.js', 'utf8') + '\n' + readFileSync('tests/core-tests.js', 'utf8') + '\nglobalThis.__r = coreTests(Core);', ctx);
results.push(...ctx.__r.map(r => ({ ...r, name: 'Moteur · ' + r.name })));

// 2. Application assemblée, dans Chromium.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  results.push({ name: 'Application · chargement sans erreur JavaScript', ok: !errors.length, msg: errors.join(' | ') });
  await page.addScriptTag({ content: readFileSync('tests/app-tests.js', 'utf8') });
  const app = await page.evaluate(() => window.__appTests());
  results.push(...app.map(r => ({ ...r, name: 'Application · ' + r.name })));
} catch (e) {
  results.push({ name: 'Application · lancement des tests', ok: false, msg: e.message });
} finally { await browser.close(); server.close(); }

// 3. Résultat.
const failed = results.filter(r => !r.ok);
for (const r of results) console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.ok ? '' : ' — ' + r.msg));
console.log(`\n${results.length - failed.length} / ${results.length} tests réussis`);
const version = (readFileSync(join(site, 'index.html'), 'utf8').match(/Carnet de positions v([\d.]+)/) || [])[1] || '?';
writeFileSync(join(site, 'build.json'), JSON.stringify({ version, date: new Date().toISOString(), passed: results.length - failed.length, total: results.length, failed: failed.map(r => r.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
