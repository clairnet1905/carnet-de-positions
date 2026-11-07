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

// 1 bis. Robot : notification des limites de risque (même calcul que l'app).
{
  const { riskCheck } = await import('../robot/risk.mjs');
  const C = ctx.Core || vm.runInContext('Core', ctx);
  const lot = o => Object.assign({ id: 'l' + Math.random(), ticker: 'AAA', date: '2026-10-01', price: 100, qty: 10, leverage: 5, entryFee: 0, stopCurrent: 90, events: [] }, o);
  const S = { lots: [lot(), lot({ ticker: 'BBB', qty: 5, price: 200, stopCurrent: 180 })], flows: [{ date: '2026-09-30', amount: 1000 }], snapshots: [],
    prices: { AAA: [{ date: '2026-11-05', price: 105 }], BBB: [{ date: '2026-11-05', price: 210 }] },
    settings: { startDate: '2026-09-30', initialCapital: 0, riskLim: { heat: 20, pos: 1 }, marginMin: 150 } };
  const closeOf = t => t === 'AAA' ? { date: '2026-11-06', price: 110 } : null;
  const t1 = (name, fn) => { try { const r = fn(); results.push({ name: 'Robot · ' + name, ok: r === true, msg: r === true ? '' : String(r) }); } catch (e) { results.push({ name: 'Robot · ' + name, ok: false, msg: 'erreur : ' + e.message }); } };
  let a;
  t1('limite franchie : une notification, avec la clôture du soir', () => { a = riskCheck(S, C, closeOf, '2026-11-06', null);
    return a.payload && /2 limites/.test(a.payload.title) && /350 \$/.test(a.payload.body) && S.prices.AAA.length === 1 ? true : JSON.stringify(a); });
  t1('limite toujours dépassée : pas de nouvelle notification', () => { const b = riskCheck(S, C, closeOf, '2026-11-09', a.state); return b.payload === null ? true : b.payload.title; });
  t1('niveau de marge sous le seuil compté, notification désactivable', () => {
    const s2 = Object.assign({}, S, { settings: Object.assign({}, S.settings, { riskLim: {}, marginMin: 300 }) });
    const c = riskCheck(s2, C, closeOf, '2026-11-06', null), d = riskCheck(Object.assign({}, s2, { settings: Object.assign({}, s2.settings, { pushRisk: false }) }), C, closeOf, '2026-11-06', null);
    return c.state.over.join() === 'level' && c.payload && !d.payload ? true : JSON.stringify([c.state, d.payload]); });
}

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
