// Tests du moteur de calcul (src/carnet/core.js) : données fixes, résultat connu d'avance.
// Sans dépendance : tourne avec Node (GitHub Actions) comme avec n'importe quel moteur JavaScript.
// coreTests(Core) renvoie [{ name, ok, msg }].
function coreTests(Core) {
  const out = [];
  const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
  const t = (name, fn) => {
    try { const r = fn(); out.push({ name, ok: r === true, msg: r === true ? '' : String(r) }); }
    catch (e) { out.push({ name, ok: false, msg: 'erreur : ' + (e && e.message) }); }
  };
  const eq = (got, want, eps) => near(got, want, eps) ? true : `attendu ${want}, obtenu ${got}`;
  const noFees = { inFixed: 0, inPct: 0, outFixed: 0, outPct: 0, perShare: 0, minComm: 0 };
  const base = { equity: 1000, riskPct: 1, entry: 100, stop: 90, leverage: 5, cap: 2000, fractional: false, decimals: 0, marginAvail: '', fees: noFees };
  const lot = (o) => Object.assign({ id: 'l' + Math.random(), ticker: 'AAA', date: '2026-11-02', price: 100, qty: 10, leverage: 5, entryFee: 0, estExitFee: 0,
    stopInitial: 90, stopCurrent: 90, refCapital: 1000, events: [] }, o);
  Core.setSwap(null);

  // ---- Calculateur : la taille vient du stop ----
  t('Calculateur : 1 % de 1 000 $ avec un stop à 10 $ donne 1 action', () => {
    const r = Core.sizePosition(base); return r.ok ? eq(r.q, 1) : r.errors.join(' ');
  });
  t('Calculateur : le risque total ne dépasse jamais le budget (frais compris, fractions)', () => {
    const r = Core.sizePosition(Object.assign({}, base, { fractional: true, decimals: 4, fees: Object.assign({}, noFees, { perShare: 0.02, minComm: 0.02 }) }));
    if (!r.ok) return r.errors.join(' ');
    return r.totalRisk <= 10 + 1e-9 && r.q > 0.99 ? true : `q ${r.q}, risque ${r.totalRisk}`;
  });
  t('Calculateur : le plafond d’exposition limite la taille', () => {
    const r = Core.sizePosition(Object.assign({}, base, { equity: 100000, stop: 99, cap: 500 }));
    return r.ok && r.binding === 'cap' ? eq(r.q, 5) : `binding ${r.binding}, q ${r.q}`;
  });
  t('Calculateur : la marge disponible limite la taille', () => {
    const r = Core.sizePosition(Object.assign({}, base, { equity: 100000, marginAvail: 100 }));
    return r.ok && r.binding === 'margin' ? eq(r.q, 5) : `binding ${r.binding}, q ${r.q}`;
  });
  t('Calculateur : un stop au-dessus de l’entrée est refusé', () => {
    const r = Core.sizePosition(Object.assign({}, base, { stop: 105 })); return !r.ok && r.errors.length ? true : 'accepté';
  });
  t('Calculateur : quantité nulle bloquée avec un message', () => {
    const r = Core.sizePosition(Object.assign({}, base, { stop: 50 })); return !r.ok && r.blocked ? true : `q ${r.q}`;
  });
  t('Commission : minimum appliqué', () => eq(Core.commission(1, { perShare: 0.02, minComm: 1 }), 1));

  // ---- Positions ----
  t('Vente partielle : reste, brut et réalisé net (frais déduits)', () => {
    const ls = Core.lotState(lot({ entryFee: 1, events: [{ id: 'e', type: 'sell', date: '2026-11-04', qty: 4, price: 110, fee: 0.5 }] }));
    return near(ls.rem, 6) && near(ls.gross, 40) && near(ls.netRealized, 38.5) && !ls.closed ? true : JSON.stringify(ls);
  });
  t('Vente totale : position clôturée à la date de la dernière vente', () => {
    const ls = Core.lotState(lot({ events: [{ id: 'a', type: 'sell', date: '2026-11-04', qty: 4, price: 110 }, { id: 'b', type: 'sell', date: '2026-11-06', qty: 6, price: 95 }] }));
    return ls.closed && ls.closeDate === '2026-11-06' ? eq(ls.gross, 40 - 30) : JSON.stringify(ls);
  });
  t('Financement saisi : retiré du réalisé', () => eq(Core.lotState(lot({ events: [{ id: 'f', type: 'funding', date: '2026-11-03', amount: 2.5 }] })).netRealized, -2.5));
  t('Dividende : ajouté au réalisé', () => eq(Core.lotState(lot({ events: [{ id: 'd', type: 'dividend', date: '2026-11-03', amount: 1.2 }] })).netRealized, 1.2));
  t('Swap estimé : une nuit par jour de semaine détenu', () => {
    Core.setSwap({ pct: 3.6, triple: 5, prices: {}, today: '2026-11-05' });
    const r = eq(Core.lotState(lot({ id: 'sw1' })).fundingEst, 0.3, 1e-9);   // lun, mar, mer : 10 × 100 × 3,6 % / 360 = 0,10 par nuit
    Core.setSwap(null); return r;
  });
  t('Swap estimé : le vendredi compte triple', () => {
    Core.setSwap({ pct: 3.6, triple: 5, prices: {}, today: '2026-11-09' });
    const r = eq(Core.lotState(lot({ id: 'sw2', date: '2026-11-06' })).fundingEst, 0.3, 1e-9);
    Core.setSwap(null); return r;
  });
  t('Swap réel saisi : remplace l’estimation jusqu’à sa date', () => {
    Core.setSwap({ pct: 3.6, triple: 5, prices: {}, today: '2026-11-05' });
    const ls = Core.lotState(lot({ id: 'sw3', events: [{ id: 'f', type: 'funding', date: '2026-11-03', amount: 1 }] }));
    Core.setSwap(null); return near(ls.fundingEst, 0.1, 1e-9) && near(ls.funding, 1.1, 1e-9) ? true : `estimé ${ls.fundingEst}, total ${ls.funding}`;
  });
  t('Analyse du stop : recul du cours au stop, frais de sortie compris', () => {
    const l = lot({ stopCurrent: 95 }), ls = Core.lotState(l);
    const sa = Core.stopAnalysis(l, ls, { price: 105, date: '2026-11-05' }, Core.normFees({ outFixed: 1 }));
    return eq(sa.pullback, 10 * 10 + 1);
  });

  // ---- Compte et performance ----
  const st = (o) => Object.assign({ settings: { initialCapital: 1000, startDate: '2026-11-01' }, flows: [], lots: [], prices: {}, snapshots: [] }, o);
  t('Valeur nette : capital + latent, marge selon le levier', () => {
    const a = Core.accountState(st({ lots: [lot()], prices: { AAA: [{ date: '2026-11-05', price: 110 }] } }), '2026-11-05', 'last');
    return near(a.equity, 1100) && near(a.margin, 220) && near(a.exposure, 1100) ? true : JSON.stringify(a);
  });
  t('Observation : écartée si une position ouverte n’a pas de cours ce jour-là', () => {
    const s = st({ lots: [lot(), lot({ ticker: 'BBB' })], prices: { AAA: [{ date: '2026-11-04', price: 105 }, { date: '2026-11-05', price: 110 }], BBB: [{ date: '2026-11-05', price: 100 }] } });
    const d = Core.observations(s, '2026-11-06').map(o => o.date);
    return d.includes('2026-11-05') && !d.includes('2026-11-04') ? true : d.join(',');
  });
  t('Observation : la valeur saisie depuis le courtier passe avant le calcul', () => {
    const s = st({ lots: [lot()], prices: { AAA: [{ date: '2026-11-05', price: 110 }] }, snapshots: [{ date: '2026-11-05', netValue: 1090 }] });
    const o = Core.observations(s, '2026-11-06').find(x => x.date === '2026-11-05');
    return o && o.source === 'courtier' ? eq(o.value, 1090) : JSON.stringify(o);
  });
  t('Rendement pondéré : un dépôt n’est pas compté comme un gain', () => {
    const tw = Core.twr([{ date: '2026-11-02', value: 1000 }, { date: '2026-11-03', value: 1100 }], [{ date: '2026-11-03', amount: 50 }]);
    return eq(tw.points[1].r, 0.05);
  });
  t('Période : la base est la dernière observation avant le début', () => {
    const pts = [{ date: '2026-10-30', index: 1 }, { date: '2026-11-02', index: 1.1 }, { date: '2026-11-03', index: 1.21 }];
    const r = Core.periodReturn(pts, '2026-11-03', '2026-11-03');
    return r && r.from === '2026-11-02' ? eq(r.r, 10, 1e-9) : JSON.stringify(r);
  });
  t('Drawdown maximal : du plus haut au plus bas suivant', () => {
    const d = Core.maxDrawdown([{ date: 'a', index: 1 }, { date: 'b', index: 1.2 }, { date: 'c', index: 0.9 }, { date: 'd', index: 1.3 }]);
    return d.peak === 'b' && d.trough === 'c' ? eq(d.dd, -25, 1e-9) : JSON.stringify(d);
  });
  t('Statistiques : taux de réussite, R moyen, profit factor', () => {
    const s = st({ lots: [lot({ events: [{ id: 'a', type: 'sell', date: '2026-11-04', qty: 10, price: 102 }] }), lot({ events: [{ id: 'b', type: 'sell', date: '2026-11-04', qty: 10, price: 99 }] })] });
    const T = Core.tradeStats(s, () => 10);
    return near(T.winRate, 50) && near(T.avgR, 0.5) && near(T.profitFactor, 2) ? true : JSON.stringify({ w: T.winRate, r: T.avgR, pf: T.profitFactor });
  });
  t('Rattrapage : compté dans la valeur et le résultat, pas comme un retrait, et dans la performance', () => {
    const s = st({ flows: [{ id: 'c', kind: 'pnl', date: '2026-11-03', amount: -100 }] });
    const A = Core.accountState(s, null, 'last');
    const tw = Core.twr([{ date: '2026-11-02', value: 1000 }, { date: '2026-11-03', value: 900 }], s.flows);
    return near(A.equity, s.settings.initialCapital - 100) && A.withdrawals === 0 && near(A.catchup, -100) && near(tw.points[1].r, -0.1) ? true : JSON.stringify({ e: A.equity, w: A.withdrawals, r: tw.points[1].r });
  });
  t('Risque : perte si tous les stops sautent, frais de sortie compris ; position sans stop à part', () => {
    const s = st({ lots: [lot({ stopCurrent: 90 }), lot({ ticker: 'BBB', qty: 5, price: 200, stopCurrent: 180 }), lot({ ticker: 'CCC', stopCurrent: null })],
      prices: { AAA: [{ date: '2026-11-05', price: 110 }], BBB: [{ date: '2026-11-05', price: 210 }], CCC: [{ date: '2026-11-05', price: 50 }] } });
    const R = Core.riskSummary(s, Core.normFees({ outFixed: 1 }));
    return near(R.heat, 10 * 20 + 1 + 5 * 30 + 1) && R.noStop === 1 && R.pos === 3 ? true : JSON.stringify(R);
  });
  return out;
}
if (typeof module !== 'undefined') module.exports = coreTests;
