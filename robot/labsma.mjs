// Labo SMA : backtest « achat long seulement » d'une SMA, comme le script TradingView de l'utilisateur
// (Trend Following SMA Selector, mode Buy Only, process_orders_on_close), avec 4 corrections :
// 100 % du capital (mesure du signal), même période pour toutes les SMA d'une unité, nombre minimal de trades
// adapté à l'unité, et ajout de « acheter et garder », du temps investi et de la période récente (30 %) non utilisée pour choisir.
// Sans dépendance : utilisé par le robot (Node) et testable dans un navigateur.

export const LAB_PERIODS = [5, 8, 13, 21, 34, 50, 55, 89, 100, 144, 200, 233, 377, 610, 987];
export const LAB_MIN_TRADES = { D: 20, W: 12, M: 8 };
// Historique minimal après la mise en route de la SMA (en bougies) : 2 ans en J, 2 ans en S, 3 ans en M.
const MIN_AFTER = { D: 500, W: 104, M: 36 };
// Frais : « tv » = script TradingView (0,10 % par ordre, 1 tick de glissement) ; « ic » = IC Markets CFD
// (0,02 $ par action, minimum 0,02 $, glissement 1 tick, swap acheteur chaque nuit en position).
export const LAB_FEES = { tv: { pct: 0.10, perShare: 0, min: 0, tick: 0.01, swap: 0 }, ic: { pct: 0, perShare: 0.02, min: 0.02, tick: 0.01, swap: 5.93 } };
const CAPITAL = 100000;
const dayNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;

function smaSeries(c, n) {
  const s = new Array(c.length).fill(null);
  let sum = 0;
  for (let i = 0; i < c.length; i++) { sum += c[i]; if (i >= n) sum -= c[i - n]; if (i >= n - 1) s[i] = sum / n; }
  return s;
}
const commission = (f, q, px) => f.pct ? q * px * f.pct / 100 : Math.max(f.min, q * f.perShare);

// Une simulation entre les bougies a et b (incluses), à plat au départ. sig(i) : 1 achat, -1 sortie, 0 rien.
// Achat et sortie à la clôture de la bougie du signal. Position encore ouverte à la fin : comptée dans le capital (comme strategy.equity).
function simulate(d, c, a, b, sig, f) {
  let cash = CAPITAL, q = 0, entryCost = 0, swapT = 0, peak = CAPITAL, mdd = 0, inDays = 0;
  let gp = 0, gl = 0, wins = 0, n = 0, sumRet = 0, ruined = false;
  for (let i = a; i <= b; i++) {
    if (q > 0 && i > a) {
      const nights = dayNum(d[i]) - dayNum(d[i - 1]);
      inDays += nights;
      if (f.swap) { const sw = q * c[i - 1] * f.swap / 100 / 360 * nights; cash -= sw; swapT += sw; }
    }
    const s = sig(i);
    if (q === 0 && s === 1 && i < b) {
      const px = c[i] + f.tick;
      q = f.pct ? cash / (px * (1 + f.pct / 100)) : (cash - f.min) / (px + f.perShare);
      const fee = commission(f, q, px);
      entryCost = q * px + fee; cash -= entryCost;
    } else if (q > 0 && s === -1) {
      const px = Math.max(0, c[i] - f.tick), fee = commission(f, q, px), out = q * px - fee;
      const pnl = out - entryCost - swapT;   // swap payé pendant le trade compris (frais « ic »)
      cash += out; n++; sumRet += pnl / entryCost;
      if (pnl > 0) { gp += pnl; wins++; } else gl -= pnl;
      q = 0; entryCost = 0; swapT = 0;
    }
    const eq = cash + q * c[i];
    if (eq <= 0) { ruined = true; mdd = 100; break; }   // capital épuisé (le swap a dépassé la valeur de la position)
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if (dd > mdd) mdd = dd;
  }
  const eq = ruined ? 0 : cash + q * c[b], years = (dayNum(d[b]) - dayNum(d[a])) / 365.25;
  const cagr = ruined ? -100 : years > 0 && eq > 0 ? (Math.pow(eq / CAPITAL, 1 / years) - 1) * 100 : null;
  return { cagr, dd: mdd, pf: gl > 0 ? gp / gl : gp > 0 ? 999 : null, tr: n, win: n ? wins / n * 100 : null, avg: n ? sumRet / n * 100 : null,
    expo: (dayNum(d[b]) - dayNum(d[a])) > 0 ? inDays / (dayNum(d[b]) - dayNum(d[a])) * 100 : 0, open: q > 0 ? 1 : 0 };
}

// Une unité (bougies [[date, clôture]] terminées, ordre chronologique). Renvoie les 15 SMA, « acheter et garder » et la période récente.
export function labUnit(bars, tf) {
  const N = bars.length, d = bars.map(b => b[0]), c = bars.map(b => b[1]);
  const ok = n => n <= N / 2 && N - n >= MIN_AFTER[tf];
  const testable = LAB_PERIODS.filter(ok);
  if (!testable.length) return null;
  const start = Math.max(...testable), end = N - 1;                 // même période pour toutes les SMA testables
  const split = start + Math.floor((end - start) * 0.7);           // 70 % pour choisir, 30 % les plus récents pour vérifier
  const out = { first: d[0], from: d[start], to: d[end], split: d[split], bars: N, sma: {}, bh: {} };
  for (const fk of ['tv', 'ic']) {
    const f = LAB_FEES[fk], rows = [];
    for (const n of LAB_PERIODS) {
      if (!ok(n)) { rows.push(null); continue; }
      const s = smaSeries(c, n);
      const sig = i => i < 1 || s[i - 1] == null ? 0 : c[i] > s[i] && c[i - 1] <= s[i - 1] ? 1 : c[i] < s[i] && c[i - 1] >= s[i - 1] ? -1 : 0;
      const all = simulate(d, c, start, end, sig, f), ins = simulate(d, c, start, split, sig, f), oos = simulate(d, c, split, end, sig, f);
      rows.push({ all, ins, oos });
    }
    out.sma[fk] = rows;
    const hold = i => i === start ? 1 : 0;
    out.bh[fk] = { all: simulate(d, c, start, end, hold, f), oos: simulate(d, c, split, end, i => i === split ? 1 : 0, f) };
  }
  return out;
}

// Meilleure SMA d'une unité (comme l'app) : meilleur CAGR ÷ drawdown parmi celles qui ont assez de trades, sinon parmi toutes.
function bestOf(rows, tf) {
  const sc = r => r.all.cagr == null || r.all.dd == null ? null : r.all.dd > 0 ? r.all.cagr / r.all.dd : r.all.cagr > 0 ? 99 : 0;
  const idx = rows.map((r, i) => [r, i]).filter(([r]) => r && (r.all.tr > 0 || r.all.open) && sc(r) != null);
  const pool = idx.filter(([r]) => r.all.tr >= LAB_MIN_TRADES[tf]).length ? idx.filter(([r]) => r.all.tr >= LAB_MIN_TRADES[tf]) : idx;
  return pool.length ? pool.reduce((a, b) => sc(b[0]) > sc(a[0]) ? b : a)[1] : -1;
}
// Test combiné J + S + M : achat quand la clôture passe au-dessus de la SMA journalière ET qu'elle est au-dessus de la meilleure SMA hebdo
// et de la meilleure SMA mensuelle (dernière semaine et dernier mois terminés, pas de regard vers l'avenir) ; sortie quand elle repasse sous la SMA journalière.
// Même période et mêmes frais que l'unité journalière. bars / units : { D, W, M } bougies terminées et résultats de labUnit.
export function labCombo(bars, units) {
  if (!units.D || !units.W || !units.M) return null;
  const d = bars.D.map(b => b[0]), c = bars.D.map(b => b[1]), a = d.indexOf(units.D.from), b = d.length - 1, split = d.indexOf(units.D.split);
  if (a < 0 || split < 0) return null;
  const monday = x => { const t = new Date(x + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7); return t.toISOString().slice(0, 10); };
  // Pour chaque séance : indice de la dernière semaine (et du dernier mois) terminés avant elle.
  const wI = [], mI = [];
  for (let i = 0, j = -1, k = -1; i < d.length; i++) {
    const mo = monday(d[i]), ym = d[i].slice(0, 7);
    while (j + 1 < bars.W.length && bars.W[j + 1][0] < mo) j++;
    while (k + 1 < bars.M.length && bars.M[k + 1][0].slice(0, 7) < ym) k++;
    wI.push(j); mI.push(k);
  }
  const out = { first: d[0], from: units.D.from, to: units.D.to, split: units.D.split, bars: d.length, sma: {}, pick: {}, bh: units.D.bh };
  for (const fk of ['tv', 'ic']) {
    const f = LAB_FEES[fk], bw = bestOf(units.W.sma[fk], 'W'), bm = bestOf(units.M.sma[fk], 'M');
    if (bw < 0 || bm < 0) return null;
    const sW = smaSeries(bars.W.map(x => x[1]), LAB_PERIODS[bw]), sM = smaSeries(bars.M.map(x => x[1]), LAB_PERIODS[bm]);
    const filt = i => { const w = wI[i] >= 0 ? sW[wI[i]] : null, m = mI[i] >= 0 ? sM[mI[i]] : null; return w != null && m != null && c[i] > w && c[i] > m; };
    out.pick[fk] = { w: LAB_PERIODS[bw], m: LAB_PERIODS[bm] };
    out.sma[fk] = LAB_PERIODS.map((n, pi) => {
      if (!units.D.sma[fk][pi]) return null;
      const s = smaSeries(c, n), cond = i => s[i] != null && c[i] > s[i] && filt(i);
      const sig = i => i < 1 || s[i - 1] == null ? 0 : cond(i) && !cond(i - 1) ? 1 : c[i] < s[i] && c[i - 1] >= s[i - 1] ? -1 : 0;
      return { all: simulate(d, c, a, b, sig, f), ins: simulate(d, c, a, split, sig, f), oos: simulate(d, c, split, b, sig, f) };
    });
  }
  return out;
}

// Bougies terminées seulement : la semaine ou le mois en cours (bougie datée du début de période) est retiré.
export function doneBars(bars, tf, ls) {
  if (!bars.length) return bars;
  const last = bars[bars.length - 1][0];
  if (tf === 'D') return bars.filter(b => b[0] <= ls);
  if (tf === 'W') { const dt = new Date(last + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + 4); return dt.toISOString().slice(0, 10) > ls ? bars.slice(0, -1) : bars; }
  const endM = new Date(Date.UTC(+last.slice(0, 4), +last.slice(5, 7), 0)).toISOString().slice(0, 10);   // dernier jour du mois
  return ls < endM && !lastWeekdayDone(endM, ls) ? bars.slice(0, -1) : bars;
}
// Le mois est terminé si la dernière séance terminée est son dernier jour de semaine.
function lastWeekdayDone(endM, ls) {
  let d = new Date(endM + 'T12:00:00Z');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return ls >= d.toISOString().slice(0, 10);
}

// Résultat compact pour le Gist : par unité et par frais, 15 lignes [cagr, dd, pf, trades, %gagnants, temps investi, trade moyen %, ouvert,
// cagr récent, dd récent, cagr 70 %, dd 70 %] arrondies, ou null.
const r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;
const row = x => x && [r1(x.all.cagr), r1(x.all.dd), x.all.pf == null ? null : Math.round(Math.min(x.all.pf, 999) * 100) / 100, x.all.tr, r1(x.all.win), r1(x.all.expo), r1(x.all.avg), x.all.open,
  r1(x.oos.cagr), r1(x.oos.dd), r1(x.ins.cagr), r1(x.ins.dd)];
export function packUnit(u) {
  if (!u) return null;
  const o = { first: u.first, from: u.from, to: u.to, split: u.split, bars: u.bars };
  for (const fk of ['tv', 'ic']) o[fk] = { sma: u.sma[fk].map(row), bh: [r1(u.bh[fk].all.cagr), r1(u.bh[fk].all.dd), r1(u.bh[fk].oos.cagr), r1(u.bh[fk].oos.dd), r1(u.bh[fk].all.expo)], ...(u.pick ? u.pick[fk] : {}) };
  return o;
}
