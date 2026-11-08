// Limites de risque du portefeuille, vérifiées chaque soir sur la clôture.
// Même calcul que le panneau Risque de l'app (Core.riskSummary, Core.accountState, capital de référence).
// Information seulement : rien n'est vendu ni modifié.
const fr = (x, d = 0) => x == null ? '—' : x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd0 = x => fr(Math.round(x)) + ' $';

// closeOf(ticker) -> { date, price } : dernière clôture connue du robot, ou null.
// prev : état mémorisé au passage précédent ({ over: [...] }).
export function riskCheck(S, Core, closeOf, ls, prev) {
  const set = S.settings || {};
  const L = Object.assign({ heat: null, margin: null, pos: null }, set.riskLim || {});
  const O = Object.assign({ level: true, back: false }, set.riskPush || {});
  const on = set.pushRisk !== false, minLvl = set.marginMin || 150;
  const st = Object.assign({}, S, { lots: S.lots || [], flows: S.flows || [], snapshots: S.snapshots || [], prices: Object.assign({}, S.prices || {}), settings: set });

  // Cours du soir pour chaque action ouverte (sans toucher aux données de l'app).
  const open = [...new Set(st.lots.filter(l => !Core.lotState(l).closed).map(l => l.ticker))], noPx = [];
  for (const t of open) {
    const c = closeOf(t), had = Core.lastPrice(st.prices, t);
    if (c && (!had || c.date >= had.date)) st.prices[t] = (st.prices[t] || []).filter(x => x.date !== c.date).concat([{ date: c.date, price: c.price }]);
    else if (!c && (!had || had.date < ls)) noPx.push(t);
  }

  // Capital de référence, comme referenceCapital() dans l'app.
  const acc = Core.accountState(st, null, 'last');
  let led = null; const up = d => { if (d && (!led || d > led)) led = d; };
  for (const l of st.lots) { up(l.date); for (const e of l.events || []) up(e.date); }
  for (const f of st.flows) up(f.date);
  const appDate = acc.openCount ? acc.minPriceDate : (led && led > ls ? led : ls);
  const lb = [...st.snapshots].sort((a, b) => a.date < b.date ? 1 : -1)[0];
  let eq = acc.equity;
  if (lb && (set.refSource === 'broker' || (set.refSource === 'auto' && lb.date > appDate && (!led || lb.date >= led)))) eq = lb.netValue;

  const R = Core.riskSummary(st, Core.normFees(set.fees));
  const heatPct = eq > 0 ? R.heat / eq * 100 : null, marginPct = eq > 0 ? acc.margin / eq * 100 : null;
  const level = acc.margin > 0 ? eq / acc.margin * 100 : null;
  const over = [];
  if (L.heat != null && heatPct != null && heatPct > L.heat) over.push('heat');
  if (L.margin != null && marginPct != null && marginPct > L.margin) over.push('margin');
  if (L.pos != null && R.pos > L.pos) over.push('pos');
  if (O.level && level != null && level < minLvl) over.push('level');

  const text = {   // textes construits seulement pour les limites dépassées
    heat: () => `Perte si tous les stops sautent : ${usd0(R.heat)} · ${fr(heatPct, 1)} % (limite ${L.heat.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %)`,
    margin: () => `Marge utilisée : ${fr(marginPct)} % de la valeur nette (limite ${fr(L.margin)} %)`,
    pos: () => `Positions ouvertes : ${R.pos} (limite ${L.pos})`,
    level: () => `Niveau de marge : ${fr(level)} % (alerte sous ${fr(minLvl)} %)`
  };
  const was = (prev && prev.over) || [], fresh = over.filter(k => !was.includes(k));
  let payload = null;
  if (on && fresh.length) {
    const top = Object.entries(R.by).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const lines = over.map(k => text[k]());
    if (top.length) lines.push('Plus gros risques : ' + top.map(([t, r]) => `${t} −${usd0(r)}`).join(', '));
    if (R.noStop) lines.push(`${R.noStop} position(s) sans stop : risque non compté`);
    if (noPx.length) lines.push('Sans cours du jour : ' + noPx.slice(0, 5).join(', ') + ' (dernier cours connu)');
    lines.push('Rien n’est vendu ni changé : à vous de voir.');
    // Version sans montant du compte (ntfy) : pourcentages et tickers seulement.
    const safe = over.map(k => k === 'heat' ? `Perte si tous les stops sautent : ${fr(heatPct, 1)} % de la valeur nette (limite ${fr(L.heat, 1)} %)` : text[k]());
    if (top.length) safe.push('Plus gros risques : ' + top.map(([t]) => t).join(', '));
    safe.push(...lines.filter(l => /sans stop|Sans cours du jour|Rien n’est vendu/.test(l)));
    payload = { nb: safe.join('\n'), title: `Risque · ${over.length} limite${over.length > 1 ? 's' : ''} dépassée${over.length > 1 ? 's' : ''}`, body: lines.join('\n'), tag: 'risk-' + ls, url: './#dash', badge: over.length };
  } else if (on && O.back && was.length && !over.length) {
    payload = { title: 'Risque · revenu sous vos limites', body: `Perte au stop ${heatPct != null ? fr(heatPct, 1) : '—'} %${level != null ? ` · niveau de marge ${fr(level)} %` : ''}`, tag: 'risk-' + ls, url: './#dash' };
  }
  // Notification désactivée : rien n'est mémorisé, pour prévenir dès qu'elle est réactivée.
  return { state: { over: on ? over : [], at: ls, heatPct, level, marginPct, pos: R.pos, eq, noPx }, payload };
}
