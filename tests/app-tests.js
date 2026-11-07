// Tests de l'application assemblée (index.html), exécutés dans un vrai navigateur (Chromium via Playwright sur GitHub Actions).
// Chaque test repart de données vides : rien n'est envoyé, aucune clé n'est utilisée.
window.__appTests = async function () {
  const out = [];
  const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const reset = () => {
    S = normalize(defaultState());
    S.settings.startDate = '2020-01-01'; S.settings.initialCapital = 1000; S.settings.swap = { pct: 0, triple: 5 };
    Radar.hist = {}; Radar.loaded = true; Live.prices = {}; calcDraft = null; tab = 'dash';
    if (typeof closeSheet === 'function') try { closeSheet(); } catch (e) {}
  };
  // Les n derniers jours de semaine avant aujourd'hui, du plus ancien au plus récent.
  const days = n => { const d = []; let x = addDays(todayISO(), -1); while (d.length < n) { if (wdOf(x) >= 1 && wdOf(x) <= 5) d.unshift(x); x = addDays(x, -1); } return d; };
  const lot = o => Object.assign({ id: 'l' + uid(), ticker: 'AAA', date: days(60)[0], price: 100, qty: 10, leverage: 5, entryFee: 0, estExitFee: 0,
    stopInitial: 90, stopCurrent: 90, refCapital: 1000, riskInitial: 100, riskInitialPct: 10, motif: '', note: '', planOk: null, events: [] }, o);
  const t = async (name, fn) => {
    reset();
    try { const r = await fn(); out.push({ name, ok: r === true, msg: r === true ? '' : String(r) }); }
    catch (e) { out.push({ name, ok: false, msg: 'erreur : ' + (e && e.message) }); }
  };

  await t('Tous les onglets s’affichent sans erreur', () => {
    loadDemo();
    for (const k of ['dash', 'calc', 'pos', 'radar', 'lab', 'earn', 'set']) { tab = k; render(); if ($('#view').innerHTML.length < 100) return 'onglet vide : ' + k; }
    return true;
  });

  await t('Stops à remonter : SMA rangées de la plus haute à la plus basse', () => {
    const D = days(60);
    Radar.hist.AAA = { bars: D.map((d, i) => [d, 100 + i]) };
    S.watch = [{ id: 'w20', ticker: 'AAA', period: 20, tf: 'D', sym: '' }, { id: 'w5', ticker: 'AAA', period: 5, tf: 'D', sym: '' }];
    S.lots = [lot()]; S.prices.AAA = [{ date: D[59], price: 160 }];
    const R = stopRaises();
    if (!R.length || R[0].opts.length !== 2) return 'propositions : ' + (R[0] ? R[0].opts.length : 0);
    return R[0].opts[0].w.period === 5 && R[0].opts[0].sma > R[0].opts[1].sma ? true : 'ordre : ' + R[0].opts.map(o => o.w.period).join(',');
  });

  await t('Performance : jours sans cours complétés par le radar (position saisie après coup)', () => {
    const D = days(30);
    S.settings.startDate = addDays(D[0], -1);
    S.lots = [lot({ ticker: 'AAA', date: D[0] }), lot({ ticker: 'BBB', date: D[0] })];
    S.prices.AAA = D.map((d, i) => ({ date: d, price: 100 + i * 0.5 }));
    S.watch = [{ id: 'wb', ticker: 'BBB', period: 20, tf: 'D', sym: '' }];
    Radar.hist.BBB = { bars: D.map((d, i) => [d, 100 - i * 0.2]) };
    const P = perf();
    return P.day && P.day.from === D[28] && P.day.to === D[29] ? true : 'Jour comparé à ' + (P.day && P.day.from);
  });

  await t('Calculateur : avertissement de risque global, taille calculée sur le stop', () => {
    S.lots = [lot({ stopCurrent: 80 })]; S.prices.AAA = [{ date: days(1)[0], price: 100 }];
    S.settings.riskLim = { heat: 1, margin: null, pos: null };
    calcDraft = Object.assign(freshDraft(), { ticker: 'ZZZ', entry: '50', stop: '45', example: false }); tab = 'calc'; render();
    const want = Core.sizePosition(calcInput()).q, box = $('#calcResult');
    const warn = box.querySelector('.banner.warn');
    if (!warn || !/La taille reste calculée sur votre stop/.test(warn.textContent)) return 'avertissement absent';
    return box.querySelector('.qty-big').textContent.includes(Core.qty(want)) ? true : 'quantité affichée différente de ' + want;
  });

  await t('Risque du portefeuille : perte si tous les stops sautent', () => {
    S.lots = [lot({ stopCurrent: 90 }), lot({ ticker: 'BBB', qty: 5, price: 200, stopCurrent: 180 })];
    S.prices.AAA = [{ date: days(1)[0], price: 110 }]; S.prices.BBB = [{ date: days(1)[0], price: 210 }];
    const P = portfolioRisk();
    return near(P.heat, 10 * (110 - 90) + 5 * (210 - 180), 0.01) && P.pos === 2 ? true : 'perte ' + P.heat;
  });

  await t('Rapprochement MT5 : le swap réel est réparti et l’app retombe sur MT5', async () => {
    const D = days(20); S.settings.swap = { pct: 6, triple: 5 }; syncSwap();
    S.lots = [lot({ date: D[0] }), lot({ ticker: 'BBB', date: D[5], qty: 4, price: 50, stopCurrent: 45 })];
    S.prices.AAA = D.map(d => ({ date: d, price: 105 })); S.prices.BBB = D.map(d => ({ date: d, price: 52 }));
    const date = lastWeekday(todayISO()), bk = swapBook(date), app0 = Core.accountState(S, date, 'last').equity, mt5 = Core.roundTo(app0 - 7.5, 2);
    sheetSnap(); await wait(50);
    const f = $('#sheetForm'); f.elements.netValue.value = String(mt5); f.elements.swap.value = String(-(bk.tot + 7.5).toFixed(2)); f.elements.fixSwap.checked = true;
    $('#sheetOk').click(); await wait(300); syncSwap();
    const app1 = Core.accountState(S, date, 'last').equity;
    return near(app1, mt5, 0.02) && S.snapshots.length === 1 ? true : `app ${app1} contre MT5 ${mt5}`;
  });

  await t('Corriger une position clôturée : la vente est modifiable', async () => {
    const l = lot({ events: [{ id: 'e1', type: 'sell', date: days(5)[0], qty: 10, price: 110, fee: 0 }] }); S.lots = [l];
    sheetEdit(l); await wait(50);
    const f = $('#sheetForm'); if (!f.elements.s0_price) return 'champ de vente absent';
    f.elements.s0_price.value = '105'; $('#sheetOk').click(); await wait(300);
    return l.events[0].price === 105 && Core.lotState(l).closed ? true : 'prix ' + l.events[0].price;
  });

  await t('Alertes du radar : une alerte vue peut être supprimée', () => {
    const D = days(40); S.watch = [{ id: 'wc', ticker: 'CCC', period: 5, tf: 'D', sym: '' }];
    Radar.hist.CCC = { bars: D.map((d, i) => [d, i < 37 ? 100 : 120]) };
    const a = radarAlerts().find(x => x.lvl === 'up'); if (!a) return 'aucun croisement détecté';
    markSeen([a.key]); if (!radarAlerts().find(x => x.key === a.key).seen) return 'pas marquée vue';
    markSeen(['x:' + a.key]); return radarAlerts().some(x => x.key === a.key) ? 'toujours affichée' : true;
  });

  await t('Qualité des sorties : gain et recul maximaux en R', () => {
    const D = days(30), px = { 10: 100, 11: 105, 12: 98, 13: 110, 14: 104 };
    Radar.hist.DDD = { bars: D.map((d, i) => [d, px[i] || 100]) };
    S.watch = [{ id: 'wd', ticker: 'DDD', period: 5, tf: 'D', sym: '' }];
    const l = lot({ ticker: 'DDD', date: D[10], events: [{ id: 's', type: 'sell', date: D[14], qty: 10, price: 104, fee: 0 }] }); S.lots = [l];
    const x = exitStats(l);   // 1 R = 1 % de 1 000 $ = 10 $
    return x && !x.none && near(x.mfe, 10) && near(x.mae, -2) && near(x.R, 4) && near(x.given, 6) ? true : JSON.stringify(x && { mfe: x.mfe, mae: x.mae, R: x.R });
  });

  await t('Motif : croisement de SMA suggéré d’après le radar', () => {
    const D = days(50); Radar.hist.EEE = { bars: D.map((d, i) => [d, i === 47 ? 99 : i === 48 ? 110 : 100]) };
    S.watch = [{ id: 'we', ticker: 'EEE', period: 10, tf: 'D', sym: '' }];
    const s = motifSuggest('EEE', D[49]);
    return s && s.k === 'xsma' ? true : JSON.stringify(s);
  });

  await t('Santé des données : position sans stop et cours faux repérés', () => {
    const d = days(3)[0];
    S.lots = [lot({ stopCurrent: null }), lot({ ticker: 'FFF', events: [{ id: 's', type: 'sell', date: d, qty: 10, price: 110 }] })];
    S.prices.FFF = [{ date: d, price: 100 }];
    const H = healthChecks().map(x => x.title).join(' | ');
    return /sans stop/.test(H) && /FFF : cours du/.test(H) ? true : H;
  });

  await t('S&P 500 : rendement de SPY aux dates du compte', () => {
    const D = days(20); S.settings.startDate = addDays(D[0], -1);
    S.lots = [lot({ date: D[0] })]; S.prices.AAA = D.map((d, i) => ({ date: d, price: 100 + i }));
    const D2 = days(25); Radar.hist.SPY = { bars: D2.map((d, i) => [d, 500 * (1 + i / 100)]) };
    const P = perf(), sel = P.itd, rp = P.pts.filter(p => p.date >= sel.from && p.date <= sel.to);
    const B = benchBlock(P, sel, rp); if (!B.at) return 'pas de comparaison';
    const want = (B.at(sel.to) / B.at(sel.from) - 1) * 100, got = 500 * (1 + D2.indexOf(sel.to) / 100) / B.at(sel.from) * 100 - 100;
    return near(want, got, 1e-9) && /S&amp;P 500/.test(B.tiles) ? true : `${want} / ${got}`;
  });

  await t('Limites de risque : choix de notification enregistrés, panneau inchangé', async () => {
    S.lots = [lot({ stopCurrent: 90 })]; S.prices.AAA = [{ date: days(1)[0], price: 110 }];
    const before = portfolioRisk().heat;
    sheetRiskLim(); await wait(50);
    const f = $('#sheetForm'); if (!f.elements.pushRisk || !f.elements.riskLevel) return 'cases absentes';
    f.elements.heat.value = '5'; f.elements.pushRisk.checked = false; f.elements.riskBack.checked = true;
    $('#sheetOk').click(); await wait(300);
    const o = riskPushOpt();
    return S.settings.pushRisk === false && o.back === true && o.level === true && S.settings.riskLim.heat === 5 && near(portfolioRisk().heat, before) && near(before, 200) ? true : JSON.stringify({ p: S.settings.pushRisk, o, before });
  });

  reset(); tab = 'dash';
  return out;
};
