// VIX et taux à 10 ans pendant la séance (CBOE, différé 15 min, sans clé), lancé toutes les 15 minutes par .github/workflows/macro.yml.
// Écrit dans un petit Gist à part (« carnet-macro.json ») pour que l'app ne retélécharge pas le gros fichier du radar à chaque fois.
const { GIST_TOKEN, FORCE } = typeof process === "undefined" ? {} : process.env;
export const MACRO_FILE = 'carnet-macro.json';
const log = (...a) => console.log(...a);

// Heure de New York : séance 9 h 30 – 16 h, on écrit de 9 h 25 à 16 h 45 (pour avoir la clôture), du lundi au vendredi.
export function nyWindow(ms) {
  const P = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) P[x.type] = x.value;
  const m = +P.hour * 60 + +P.minute;
  return !['Sat', 'Sun'].includes(P.weekday) && m >= 9 * 60 + 25 && m <= 16 * 60 + 45;
}
// Une cotation CBOE → [heure UTC ISO, dernier, clôture de la veille]. Le TNX vaut 10 × le taux (51,21 → 5,121 %).
export function cboeQuote(j, div = 1) {
  const d = j && j.data; if (!d || !(d.current_price > 0)) return null;
  const at = /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(j.timestamp || '') ? j.timestamp.replace(' ', 'T') + 'Z' : new Date().toISOString();
  const prev = d.prev_day_close > 0 ? d.prev_day_close : d.close > 0 && d.price_change != null ? d.current_price - d.price_change : null;
  const r = v => v == null ? null : Math.round(v / div * 1000) / 1000;
  return [at, r(d.current_price), r(prev)];
}

async function main() {
  if (!GIST_TOKEN) { console.error('Secret GIST_TOKEN manquant.'); process.exit(1); }
  if (FORCE !== 'true' && !nyWindow(Date.now())) { log('Hors séance à New York : rien à faire.'); return; }
  const get = async s => { const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${s}.json`, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 carnet-macro' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(s + ' HTTP ' + r.status); return r.json(); };
  let vix = null, tnx = null;
  try { vix = cboeQuote(await get('_VIX')); } catch (e) { log('VIX : ' + e.message); }
  try { tnx = cboeQuote(await get('_TNX'), 10); } catch (e) { log('Taux 10 ans : ' + e.message); }
  if (!vix && !tnx) { log('CBOE : rien reçu.'); process.exit(1); }
  log(`CBOE : VIX ${vix ? vix[1] + ' (veille ' + vix[2] + ')' : '-'} · taux 10 ans ${tnx ? tnx[1] + ' %' : '-'} · ${(vix || tnx)[0]}`);
  const gh = async (path, opts = {}) => {
    const r = await fetch('https://api.github.com' + path, { ...opts, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GIST_TOKEN, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'carnet-macro', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!r.ok) throw new Error('GitHub ' + r.status); return r.json();
  };
  let id = null;
  for (let page = 1; page <= 10 && !id; page++) { const list = await gh('/gists?per_page=100&page=' + page); const g = list.find(x => x.files && x.files[MACRO_FILE]); if (g) id = g.id; if (list.length < 100) break; }
  const body = { description: 'Carnet de positions : VIX et taux 10 ans en séance (robot)', files: { [MACRO_FILE]: { content: JSON.stringify({ v: 1, at: Date.now(), src: 'CBOE', vix, tnx }) } } };
  if (id) await gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify(body) });
  else { await gh('/gists', { method: 'POST', body: JSON.stringify({ ...body, public: false }) }); log('Gist secret « carnet-macro.json » créé.'); }
  log('Enregistré.');
}
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith('macro.mjs')) main().catch(e => { console.error(e.message); process.exit(1); });
