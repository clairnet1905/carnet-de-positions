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
    for (const k of ['dash', 'calc', 'pos', 'radar', 'ana', 'lab', 'earn', 'set']) { tab = k; render(); if ($('#view').innerHTML.length < 100) return 'onglet vide : ' + k; }
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

  await t('Rattrapage : perte enregistrée, valeur et performance baissent, statistiques inchangées', async () => {
    const D = days(10); S.settings.startDate = addDays(D[0], -1);
    S.lots = [lot({ date: D[0], events: [{ id: 's', type: 'sell', date: D[2], qty: 10, price: 110, fee: 0 }] })];
    const n0 = Core.tradeStats(S, planR).count, e0 = Core.accountState(S, null, 'last').equity;
    sheetCatchup(); await wait(50);
    const f = $('#sheetForm'); f.elements.date.value = D[5]; f.elements.sign.value = '-1'; f.elements.amount.value = '101,38';
    $('#sheetOk').click(); await wait(300);
    const fl = S.flows[0], e1 = Core.accountState(S, null, 'last').equity, P = perf();
    tab = 'set'; render(); const shown = /Rattrapage/.test($('#view').textContent);
    return fl && fl.kind === 'pnl' && fl.amount === -101.38 && near(e1, e0 - 101.38, 1e-6) && Core.tradeStats(S, planR).count === n0 && P.itd && P.itd.r < 0 && shown ? true : JSON.stringify({ fl, e0, e1, r: P.itd && P.itd.r, shown });
  });

  await t('Santé des données : une action hors radar peut ne plus être signalée', () => {
    S.lots = [lot({ ticker: 'WKL' }), lot({ ticker: 'NEM' })];
    const has = () => healthChecks().some(x => /absente\(s\) du radar/.test(x.title));
    if (!has()) return 'pas signalée au départ';
    S.settings.radarSkip = ['WKL', 'NEM']; tab = 'set'; render();
    return !has() && /Jamais proposées au radar : NEM, WKL/.test($('#view').textContent) ? true : 'toujours signalée';
  });

  await t('Ce soir : stop remonté en un geste, croisement d’une action non détenue proposé', async () => {
    const D = days(60);
    Radar.hist.AAA = { bars: D.map((d, i) => [d, 100 + i]) };
    Radar.hist.CCC = { bars: D.map((d, i) => [d, i < 58 ? 100 : 120]) };
    S.watch = [{ id: 'w5', ticker: 'AAA', period: 5, tf: 'D', sym: '' }, { id: 'wc', ticker: 'CCC', period: 5, tf: 'D', sym: '' }, { id: 'wa', ticker: 'AAA', period: 3, tf: 'D', sym: '' }];
    S.lots = [lot()]; S.prices.AAA = [{ date: D[59], price: 160 }];
    tab = 'dash'; render();
    const card = $('#tonight'); if (!card) return 'carte absente';
    const st = card.querySelector('[data-act="tn-stop"]'); if (!st || st.dataset.t !== 'AAA') return 'stop absent';
    if (!card.querySelector('[data-act="tn-calc"]') || card.querySelector('[data-act="tn-calc"]').closest('.tnr').textContent.indexOf('CCC') < 0) return 'croisement CCC absent';
    if (/\bAAA\b.*Calculer/.test(card.textContent.replace(/\s+/g, ' ').split('2. ')[1] || '')) return 'action détenue proposée';
    const v = +st.dataset.v; st.click(); await wait(300);
    return near(S.lots[0].stopCurrent, v) && S.lots[0].events.some(e => e.type === 'stop' && e.to === v) ? true : 'stop ' + S.lots[0].stopCurrent;
  });

  await t('Stop atteint : jugé à la clôture de l’unité d’entrée (J chaque soir, S jeudi/vendredi, M fin de mois)', async () => {
    if (!stopWindow('W', '2026-11-05') || !stopWindow('W', '2026-11-06') || stopWindow('W', '2026-11-04')) return 'fenêtre hebdo';
    if (stopWindow('M', '2026-11-06') || !stopWindow('M', '2026-11-24') || !stopWindow('M', '2026-11-30') || stopWindow('M', '2026-11-23')) return 'fenêtre mensuelle';
    if (stopDue('M', '2026-10-05') !== '2026-10-30' || stopDue('W', '2026-11-04') !== '2026-11-06') return 'clôture qui compte';
    try { localStorage.removeItem(TN_KEY); } catch (e) {}
    const d = '2026-11-06', m = '2026-11-25';
    S.lots = [lot({ ticker: 'MMM', smas: ['M|10'] }), lot({ ticker: 'DDD', smas: ['D|50'] }), lot({ ticker: 'WWW', smas: ['D|50', 'W|13'] })];
    S.prices.MMM = [{ date: d, price: 85 }]; S.prices.DDD = [{ date: d, price: 85 }]; S.prices.WWW = [{ date: '2026-11-04', price: 85 }];
    const al = alertsList().filter(x => x.hit).map(x => x.txt).join(' ');
    if (!/DDD/.test(al) || /MMM|WWW/.test(al)) return 'alertes : ' + al.replace(/<[^>]+>/g, '');
    tab = 'dash'; render();
    let card = $('#tonight'); if (!card) return 'carte absente';
    if (card.querySelectorAll('[data-act="tn-hit"]').length !== 1 || !/2 sous le stop/.test(card.textContent)) return 'Ce soir : ' + card.textContent.replace(/\s+/g, ' ').slice(0, 200);
    tab = 'pos'; render();
    if (!/sous le stop · fin /.test($('#view').textContent)) return 'ligne position MMM';
    S.prices.MMM = [{ date: m, price: 85 }]; tab = 'dash'; render(); card = $('#tonight');
    if (card.querySelectorAll('[data-act="tn-hit"]').length !== 2) return 'fin de mois : MMM absent';
    card.querySelector('[data-act="tn-hit"]').click(); await wait(100);
    return $('#tonight').querySelectorAll('[data-act="tn-hit"]').length === 1 ? true : '« Fait » sans effet';
  });

  await t('Import MT5 : vente et dividende manquants, frais et swap réels, rapprochement, forex ignoré', async () => {
    const TXT = "Rapport d'historique de trading\nCompte: 1234567 (USD, Demo-MT5, real, Hedge)\nDate: 2026.11.08 08:41\nPositions\nHeure Position Symbole Type Volume Prix S / L T / P Heure Prix Commission Echange Profit\n2026.10.01 16:35:00 8000001 AAA.NYSE buy 4 / 10 100.00 2026.10.05 16:35:00 110.00 -0.04 -0.10 40.00\nTransactions\nHeure Op\u00e9ration Symbole Type Direction Volume Prix Ordre Commission Frais Echange Profit Solde Commentaire\n2026.10.01 16:35:00 9000001 AAA.NYSE buy in 10 100.00 8000001 -0.02 0.00 0.00 0.00 999.98\n2026.10.02 00:20:00 9000002 dividend in 0 0.00 0.00 0.00 0.00 1.50 1 001.48 Dividend 8000001 AAA.NYSE\n2026.10.05 16:35:00 9000003 AAA.NYSE sell out 4 110.00 8000002 -0.02 0.00 -0.10 40.00 1 041.36\n2026.10.06 10:00:00 9000004 EURUSD sell in 0.01 1.15000 8000003 0.00 0.00 0.00 0.00 1 041.36\n2026.10.06 18:00:00 9000005 EURUSD buy out 0.01 1.14000 8000004 0.00 0.00 0.10 10.00 1 051.46 [tp 1.14000]\n2026.10.07 14:52:22 9000006 balance 0.00 0.00 0.00 0.15 1 051.61 SWAP adjustment\n-0.04 0.00 0.00 50.15 1 051.61\nPositions ouvertes\nHeure Position Symbole Type Volume Prix S / L T / P Prix du march\u00e9 Echange Profit Commentaire\n2026.10.01 16:35:00 8000001 AAA.NYSE buy 6 100.00 105.00 -0.30 30.00\nSolde: 1 051.61 Marge libre: 961.61\nFacilit\u00e9s de cr\u00e9dit : 0.00 Marge: 120.00\nP/L flottant: 29.70 Niveau de la marge: 901.34%\nAction: 1 081.31";
    S.lots = [lot({ id: 'm1', ticker: 'AAA', date: '2026-10-01', price: 100, qty: 10, entryFee: 0, stopInitial: 90, stopCurrent: 90 })];
    sheetMt5(); $('#f-paste').value = TXT; $('#sheetOk').click(); await wait(300);
    const box = $('#mt5Diff'); if (!box) return 'écran de comparaison absent : ' + $('#sheetErr').textContent;
    const tx = box.textContent.replace(/\s+/g, ' ');
    if (!/Ventes absentes/.test(tx) || !/Dividendes/.test(tx) || !/Swap réel/.test(tx) || !/EURUSD/.test(tx)) return 'comparaison : ' + tx.slice(0, 300);
    if (/Positions ouvertes · [1-9]/.test(tx)) return 'quantité ouverte signalée à tort : ' + tx;
    const n = box.querySelectorAll('input[name="mt5i"]:checked').length;
    $('#sheetOk').click(); await wait(300);
    const L = S.lots[0], sell = L.events.find(e => e.type === 'sell'), div = L.events.find(e => e.type === 'dividend'), fund = L.events.filter(e => e.type === 'funding').reduce((a, e) => a + e.amount, 0);
    if (!sell || sell.qty !== 4 || sell.price !== 110 || !near(sell.fee, 0.02)) return 'vente ' + JSON.stringify(sell);
    if (!div || div.amount !== 1.5 || !near(L.entryFee, 0.02) || !near(fund, 0.4)) return 'dividende/frais/swap ' + JSON.stringify([div, L.entryFee, fund]);
    if (!S.flows.some(f => f.kind === 'pnl' && f.amount === 0.15) || !S.snapshots.some(x => x.netValue === 1081.31 && x.marginUsed === 120)) return 'opération ou rapprochement';
    if (!S.settings.mt5 || S.settings.mt5.upTo !== '2026-10-07' || n !== 6) return 'suivi ' + JSON.stringify(S.settings.mt5) + ' lignes ' + n;
    sheetMt5(); $('#f-paste').value = TXT; $('#sheetOk').click(); await wait(300);
    const again = $('#mt5Diff').querySelectorAll('input[name="mt5i"]').length; closeSheet();
    return again === 1 ? true : 'réimport : ' + again + ' ligne(s) proposée(s) au lieu du seul rapprochement';
  });

  await t('Import MT5 : swap réel d’un trade clôturé repris de la vente, rattrapage du solde au choix', async () => {
    const TXT = "Rapport d'historique de trading\nCompte: 1234567 (USD, Demo-MT5, real, Hedge)\nDate: 2026.11.08 08:41\nPositions\nHeure Position Symbole Type Volume Prix S / L T / P Heure Prix Commission Echange Profit\n2026.10.01 16:35:00 8000001 AAA.NYSE buy 4 / 10 100.00 2026.10.05 16:35:00 110.00 -0.04 -0.10 40.00\nTransactions\nHeure Op\u00e9ration Symbole Type Direction Volume Prix Ordre Commission Frais Echange Profit Solde Commentaire\n2026.10.01 16:35:00 9000001 AAA.NYSE buy in 10 100.00 8000001 -0.02 0.00 0.00 0.00 999.98\n2026.10.02 00:20:00 9000002 dividend in 0 0.00 0.00 0.00 0.00 1.50 1 001.48 Dividend 8000001 AAA.NYSE\n2026.10.05 16:35:00 9000003 AAA.NYSE sell out 4 110.00 8000002 -0.02 0.00 -0.10 40.00 1 041.36\n2026.10.05 18:00:00 9000010 BBB.NAS sell out 2 50.00 8000011 -0.02 0.00 -0.30 4.00 1 045.04\n2026.10.06 10:00:00 9000004 EURUSD sell in 0.01 1.15000 8000003 0.00 0.00 0.00 0.00 1 045.04\n2026.10.06 18:00:00 9000005 EURUSD buy out 0.01 1.14000 8000004 0.00 0.00 0.10 10.00 1 055.14 [tp 1.14000]\n2026.10.07 14:52:22 9000006 balance 0.00 0.00 0.00 0.15 1 055.29 SWAP adjustment\n-0.04 0.00 0.00 50.15 1 051.61\nPositions ouvertes\nHeure Position Symbole Type Volume Prix S / L T / P Prix du march\u00e9 Echange Profit Commentaire\n2026.10.01 16:35:00 8000001 AAA.NYSE buy 6 100.00 105.00 -0.30 30.00\nSolde: 1 055.29 Marge libre: 961.61\nFacilit\u00e9s de cr\u00e9dit : 0.00 Marge: 120.00\nP/L flottant: 29.70 Niveau de la marge: 901.34%\nAction: 1 084.99";
    S.lots = [lot({ id: 'm1', ticker: 'AAA', date: '2026-10-01', price: 100, qty: 10, entryFee: 0.02 }),
      lot({ id: 'm2', ticker: 'BBB', date: '2026-09-28', price: 48, qty: 2, entryFee: 0, events: [{ id: 'sb', type: 'sell', date: '2026-10-05', qty: 2, price: 50, fee: 0.02 }] })];
    S.lots[0].events.push({ id: 'sa', type: 'sell', date: '2026-10-05', qty: 4, price: 110, fee: 0.02 }, { id: 'da', type: 'dividend', date: '2026-10-02', amount: 1.5 });
    sheetMt5(); $('#f-paste').value = TXT; $('#sheetOk').click(); await wait(300);
    const box = $('#mt5Diff'); if (!box) return 'écran absent : ' + $('#sheetErr').textContent;
    if (!/1 trade\(s\) clôturé\(s\).*BBB/.test(box.textContent)) return 'swap du trade clôturé absent : ' + box.textContent.replace(/\s+/g, ' ').slice(0, 400);
    const g = $('#sheetForm').elements.mt5gap; if (!g) return 'pas de proposition de rattrapage';
    g.checked = true; g.dispatchEvent(new Event('input', { bubbles: true })); await wait(50);
    $('#sheetOk').click(); await wait(300);
    const fb = S.lots[1].events.filter(e => e.type === 'funding'), fl = S.flows.find(f => f.kind === 'pnl' && /Alignement/.test(f.note || ''));
    if (fb.length !== 1 || !near(fb[0].amount, 0.3) || fb[0].date !== '2026-10-05') return 'swap BBB ' + JSON.stringify(fb);
    if (!fl) return 'rattrapage absent';
    const A = mt5AppAcct(JSON.parse(JSON.stringify({ lots: S.lots, flows: S.flows, snapshots: S.snapshots, prices: S.prices, settings: S.settings })), mt5SnapDate(Core.parseMt5(TXT)), Core.parseMt5(TXT));
    return Math.abs(A.bal - 1055.29) < 0.006 && near(fl.amount, 10.1, 0.006) ? true : 'solde après ' + A.bal + ' rattrapage ' + fl.amount;
  });

  await t('Radar allégé : « À traiter » par défaut, baisses non détenues repliées, une ligne par action, par paquets de 30', async () => {
    const D = days(60);
    try { localStorage.removeItem(SEEN_KEY); } catch (e) {}
    Radar.hist.AAA = { bars: D.map((d, i) => [d, i < 58 ? 120 + i : 100]) };
    Radar.hist.BBB = { bars: D.map((d, i) => [d, i < 58 ? 100 : 120]) };
    Radar.hist.CCC = { bars: D.map((d, i) => [d, i < 58 ? 120 + i : 100]) };
    S.watch = [{ id: 'wa', ticker: 'AAA', period: 5, tf: 'D', sym: '' }, { id: 'wb', ticker: 'BBB', period: 5, tf: 'D', sym: '' }, { id: 'wc', ticker: 'CCC', period: 5, tf: 'D', sym: '' }];
    for (let k = 0; k < 35; k++) { const t = 'Z' + String(k).padStart(2, '0'); Radar.hist[t] = { bars: D.map((d, i) => [d, 100 + i]) }; S.watch.push({ id: 'z' + k, ticker: t, period: 5, tf: 'D', sym: '' }); }
    S.lots = [lot({ ticker: 'AAA', price: 110, stopInitial: 90, stopCurrent: 90 })]; S.prices.AAA = [{ date: D[59], price: 100 }];
    radarFilter = 'todo'; radarQuery = ''; tab = 'radar'; render(); await wait(50);
    const v = $('#rlist'); if (!v || !v.querySelector('.todo')) return 'vue À traiter absente';
    const tx = v.textContent.replace(/\s+/g, ' ');
    if (!/Vos positions · 1.*AAA/.test(tx) || !/Hausses à étudier · 1.*BBB/.test(tx) || !/Baisses sur actions non détenues · 1/.test(tx)) return 'sections : ' + tx.slice(0, 300);
    const dn = v.querySelector('details[data-lazy="downs"]'); if (dn.querySelector('.lazy').innerHTML) return 'baisses non repliées';
    dn.open = true; await wait(50); if (!/CCC/.test(dn.textContent)) return 'contenu des baisses non chargé à l’ouverture';
    $('[data-act="radar-seen-downs"]').click(); await wait(50);
    if (/Baisses sur actions non détenues/.test($('#rlist').textContent)) return 'baisses non marquées vues';
    $('[data-act="radar-filter"][data-f="all"]').click(); await wait(50);
    const rows = $('#rlist').querySelectorAll('details.rmini'); if (rows.length !== 30) return 'Toutes : ' + rows.length + ' lignes';
    if (rows[0].querySelector('.lazy').innerHTML) return 'carte construite avant ouverture';
    rows[0].open = true; await wait(50); if (!rows[0].querySelector('.rrow')) return 'carte non construite à l’ouverture';
    $('[data-act="radar-more"]').click(); await wait(50);
    if ($('#rlist').querySelectorAll('details.rmini').length !== 38) return 'Afficher plus : ' + $('#rlist').querySelectorAll('details.rmini').length;
    const q = $('#radar-q'); q.value = 'bbb'; q.dispatchEvent(new Event('input', { bubbles: true })); await wait(50);
    const n = $('#rlist').querySelectorAll('details.rmini').length; radarQuery = ''; radarFilter = 'todo';
    return n === 1 ? true : 'recherche : ' + n;
  });

  await t('Positions compactes : une ligne par action triée par distance au stop, carte construite à l’ouverture, une seule ouverte', async () => {
    const D = days(5);
    S.lots = [lot({ id: 'p1', ticker: 'AAA', price: 100, stopCurrent: 90 }), lot({ id: 'p2', ticker: 'BBB', price: 100, stopCurrent: 105 }), lot({ id: 'p3', ticker: 'CCC', price: 100, stopCurrent: 98 })];
    S.prices.AAA = [{ date: D[4], price: 120 }]; S.prices.BBB = [{ date: D[4], price: 130 }]; S.prices.CCC = [{ date: D[4], price: 99 }];
    posFilter = 'all'; posSort = 'risk'; tab = 'pos'; render(); await wait(50);
    const rows = [...document.querySelectorAll('details.pmini')];
    if (rows.length !== 3 || document.querySelector('.pcard')) return 'lignes ' + rows.length + (document.querySelector('.pcard') ? ' (carte déjà construite)' : '');
    if (rows[0].querySelector('.tk').textContent !== 'CCC' || rows.map(r => r.querySelector('.tk').textContent).join(',') !== 'CCC,BBB,AAA' || !rows[1].querySelector('.pill.win')) return 'tri ou « sans risque » : ' + rows.map(r => r.querySelector('.tk').textContent).join(',');
    rows[0].open = true; await wait(50); if (!rows[0].querySelector('.pcard')) return 'carte non construite';
    rows[1].open = true; await wait(50); if (rows[0].open) return 'deux cartes ouvertes';
    $('[data-act="pfilter"][data-f="safe"]').click(); await wait(50);
    if (document.querySelectorAll('details.pmini').length !== 1) return 'filtre sans risque';
    $('[data-act="pfilter"][data-f="all"]').click(); await wait(50);
    tab = 'dash'; render(); const ob = document.createElement('button'); ob.dataset.act = 'open-lot'; ob.dataset.lot = 'p1'; document.body.appendChild(ob); ob.click(); ob.remove(); await wait(100);
    const o = document.querySelector('details.pmini[open]');
    return o && o.querySelector('.tk').textContent === 'AAA' && o.querySelector('.pcard') ? true : 'Voir une position depuis une alerte';
  });

  await t('Passe visuelle : valeur puis Ce soir sur le bord, onglet Analyse, Réglages en Compte et Configuration', async () => {
    S.lots = [lot()]; S.prices.AAA = [{ date: days(2)[1], price: 105 }]; tab = 'dash'; render();
    const v = $('#view'), hero = v.querySelector('.hero-card'), tn = v.querySelector('#tonight');
    if (!hero || !tn || !(hero.compareDocumentPosition(tn) & Node.DOCUMENT_POSITION_FOLLOWING)) return 'valeur nette pas en tête';
    if (/Ce qui marche pour vous|Qualité des sorties/.test(v.textContent)) return 'statistiques encore sur le bord';
    if (!$('#tab-ana')) return 'onglet Analyse absent';
    $('#tab-ana').click(); await wait(50);
    if (!/Performance/.test($('#view').textContent) || !/Positions clôturées/.test($('#view').textContent)) return 'Analyse incomplète';
    tab = 'set'; setPart = 'acct'; render();
    if (!$('#setForm') || /Synchronisation et sauvegarde|Sauvegarde et données/.test($('#view').textContent)) return 'partie Compte';
    $('[data-act="set-part"][data-f="conf"]').click(); await wait(50);
    const ok = !$('#setForm') && /Synchronisation et sauvegarde|Sauvegarde et données/.test($('#view').textContent);
    setPart = 'acct'; return ok ? true : 'partie Configuration';
  });

  await t('ntfy : nom proposé, refus d’un nom trop court, canal enregistré et activé', async () => {
    tab = 'set'; setPart = 'conf'; render();
    if (!$('#ntfy')) { setPart = 'acct'; return 'carte ntfy absente'; }
    $('#ntfy-topic').value = 'court'; $('[data-act="ntfy-save"]').click(); await wait(50);
    if (S.settings.ntfy) { setPart = 'acct'; return 'nom trop court accepté'; }
    $('[data-act="ntfy-gen"]').click(); const v = $('#ntfy-topic').value;
    $('[data-act="ntfy-save"]').click(); await wait(100);
    const ok = /^carnet-[a-z0-9]{9}$/.test(v) && S.settings.ntfy && S.settings.ntfy.topic === v && S.settings.ntfy.on === true && $('[data-act="ntfy-on"]');
    setPart = 'acct'; return ok ? true : 'enregistrement ' + JSON.stringify(S.settings.ntfy);
  });

  await t('Dividendes à venir dans Ce soir et sur la position, actualités du robot dans la carte, contrôle des cours MT5', async () => {
    const keep = Radar.robot, td = todayISO();
    Radar.robot = { divcal: [{ t: 'AAA', ex: addDays(td, 2), amt: 0.5, pay: addDays(td, 20) }], news: { AAA: [{ t: 'Titre Reuters', s: 'Reuters', u: 'https://example.com/a', d: Date.now() - 3600e3 }, { t: 'Titre blog', s: 'Blog', u: 'https://example.com/b', d: Date.now() }] } };
    S.lots = [lot({ id: 'n1' })]; S.prices.AAA = [{ date: days(2)[1], price: 105 }];
    tab = 'dash'; render();
    const tn = $('#tonight') ? $('#tonight').textContent.replace(/\s+/g, ' ') : '';
    if (!/Dividendes d’ici 10 jours : AAA .* \+5,00/.test(tn)) { Radar.robot = keep; return 'Ce soir : ' + tn.slice(-300); }
    posFilter = 'all'; tab = 'pos'; render();
    const row = document.querySelector('details.pmini'); if (!/div\. /.test(row.textContent)) { Radar.robot = keep; return 'étiquette div. absente'; }
    row.open = true; await wait(50);
    const nl = row.querySelector('.newsl'), links = nl ? [...nl.querySelectorAll('a.newsi')] : [];
    const ok = links.length === 2 && links[0].href === 'https://example.com/b' && links[0].target === '_blank' && /Dividende : détachement/.test(row.textContent);
    Radar.robot = keep;
    if (!ok) return 'actualités ' + links.length;
    const rep = { acct: '1', gen: null, from: '2026-10-01', to: '2026-10-07', deals: [], ops: [], sum: {}, open: [{ date: '2026-10-01', time: '', pos: '9', sym: 'AAA.NYSE', type: 'buy', vol: 10, price: 100, mkt: 110, swap: 0, profit: 100 }] };
    S.prices.AAA = [{ date: '2026-10-07', price: 100 }];
    const d = mt5Diff(rep, '2026-10-01'), px = d.out.find(x => x.g === 'px');
    if (!px || px.on) return 'contrôle des cours absent ou coché d’office';
    const st = JSON.parse(JSON.stringify({ prices: S.prices })); px.fix(st);
    return st.prices.AAA.some(x => x.price === 110 && x.src === 'mt5') ? true : 'cours MT5 non repris';
  });

  await t('Actualités en français : titre traduit, anglais dessous, résumé traduit', async () => {
    const keep = Radar.robot, keepL = newsLive.ZZZ;
    Radar.robot = { news: { ZZZ: [{ t: 'Shares fall as clients delay projects', f: 'L’action recule, les clients repoussent leurs projets', s: 'Reuters', u: 'https://example.com/r', d: Date.now() - 7200e3 }] } };
    newsLive.ZZZ = { at: Date.now(), items: [{ t: 'Three takeaways from the call', s: 'Yahoo', u: 'https://example.com/y', d: Date.now(), x: 'Management kept its targets. Big deals slow next quarter.' }] };
    trCache['Three takeaways from the call'] = 'Trois points à retenir de la conférence';
    trCache['Management kept its targets. Big deals slow next quarter.'] = 'La direction maintient ses objectifs. Les grands contrats ralentissent.';
    const box = document.createElement('div'); box.innerHTML = newsHTML('ZZZ');
    Radar.robot = keep; if (keepL) newsLive.ZZZ = keepL; else delete newsLive.ZZZ;
    const a = [...box.querySelectorAll('a.newsi')], txt = box.textContent;
    if (a.length !== 2) return 'liens ' + a.length;
    const ok = /Trois points à retenir/.test(a[0].textContent) && /Résumé : La direction maintient/.test(a[0].textContent) && a[0].querySelector('.news-en').textContent === 'Three takeaways from the call'
      && /L’action recule/.test(a[1].textContent) && /Shares fall/.test(a[1].querySelector('.news-en').textContent) && /Traduction automatique/.test(txt)
      && isQuotePage('ACN Nov 2026 257.500 call (ACN261106C00257500) stock price, news, quote and history') && isQuotePage('Accenture PLC Cl A ACN (Chile: Santiago)') && !isQuotePage('Starbucks to cut 900 jobs | Reuters')
      && cutSum('Short') === '' && cutSum('One. Two. Three.'.repeat(1) + ' Padding text here.') === 'One. Two.';
    return ok ? true : txt.slice(0, 300);
  });

  await t('Journal des clôturées : par période, rangé par date de clôture, analyse visible', async () => {
    const td = todayISO(), mon = addDays(td, -((wdOf(td) + 6) % 7)), sell = d => [{ id: 's' + d, type: 'sell', date: d, qty: 10, price: 110, fee: 0 }];
    S.lots = [lot({ ticker: 'WK1', date: addDays(mon, -30), note: 'Clôture au-dessus de la SMA 50 hebdo', events: sell(mon) }),
      lot({ ticker: 'WK2', date: addDays(mon, -40), events: sell(td) }),
      lot({ ticker: 'OLD', date: addDays(mon, -90), events: sell(addDays(mon, -3)) }),
      lot({ ticker: 'OPN', date: addDays(mon, -5) })];
    journalFilter = 'closed'; tab = 'pos';
    const tks = () => [...document.querySelectorAll('#view details.lot .tk')].map(e => e.textContent).filter(t => t !== 'OPN' || true);
    jPeriod = 'w0'; render(); const a = tks(), txt = document.querySelector('#view').textContent;
    jPeriod = 'w1'; render(); const b = tks();
    jPeriod = 'all'; render(); const c = tks(), months = document.querySelectorAll('.jmonth').length;
    jPeriod = 'w0';
    const ok = a.join() === (td === mon ? 'WK1,WK2'.split(',').sort().join() === a.slice().sort().join() ? a.join() : 'x' : 'WK2,WK1') && b.join() === 'OLD' && c.length === 3 && !c.includes('OPN') && months >= 1
      && /Analyse : Clôture au-dessus de la SMA 50 hebdo/.test(txt) && /2 trades · 2 gagnants, 0 perdant/.test(txt);
    return ok ? true : JSON.stringify({ a, b, c, months, s: (txt.match(/Cette semaine[^·]*·[^·]*·[^·]*/) || [''])[0] });
  });

  await t('Graphique : une unité par onglet (bougies et SMA de l’unité seulement), stop, entrée et ventes', async () => {
    const D = days(400);
    const u = unpackHist({ s: D[0], o: D.map((d, i) => i ? Core.days(D[i - 1], d) : 0), c: D.map((d, i) => 100 + i), n: 400, x: D.slice(-70).flatMap(() => [-50, 120, -130]), xn: 70 });
    if (u.ohlc !== 70 || u.bars[399].length !== 5) return 'décodage bougies ' + u.ohlc;
    Radar.hist.AAA = u;
    S.watch = [{ id: 'wd', ticker: 'AAA', period: 5, tf: 'D', sym: '' }, { id: 'ww', ticker: 'AAA', period: 10, tf: 'W', sym: '' }, { id: 'wm', ticker: 'AAA', period: 3, tf: 'M', sym: '' }];
    S.lots = [lot({ date: D[340], price: 440, smas: ['W|10'], events: [{ id: 'st', type: 'stop', date: D[360], from: 90, to: 450 }, { id: 's', type: 'sell', date: D[370], qty: 4, price: 470, fee: 0 }] })];
    sheetChart('AAA'); await wait(30);
    if (chartSt.tf !== 'W') { closeSheet(); return 'onglet par défaut ' + chartSt.tf + ' (attendu : unité de la SMA d’entrée)'; }
    const lg = () => $('.chlg').textContent, nR = () => $('#chSvg').querySelectorAll('g rect').length;
    const w1 = lg(); if (!/SMA S10/.test(w1) || /SMA J5|SMA M3/.test(w1)) { closeSheet(); return 'hebdo : ' + w1; }
    if (!$('#chSvg .stp') || !$('#chSvg .m-in') || !$('#chSvg .m-out') || !$('#chSvg rect.tg-stop') || !$('#chSvg rect.tg-in')) { closeSheet(); return 'stop / entrée / ventes manquants'; }
    $('[data-act="ch-tf"][data-tf="D"]').click(); await wait(30);
    const d1 = lg(); if (!/SMA J5/.test(d1) || /SMA S10|SMA M3/.test(d1) || nR() !== 66) { closeSheet(); return 'journalier : ' + d1 + ' / ' + nR(); }
    $('[data-act="ch-range"][data-n="22"]').click(); await wait(30);
    if (nR() !== 22) { closeSheet(); return '1 M : ' + nR(); }
    $('[data-act="ch-tf"][data-tf="M"]').click(); await wait(30);
    const m1 = lg(), months = new Set(D.map(d => d.slice(0, 7))).size;
    if (!/SMA M3/.test(m1) || /SMA J5|SMA S10/.test(m1) || nR() !== Math.min(24, months)) { closeSheet(); return 'mensuel : ' + m1 + ' / ' + nR() + ' sur ' + months; }
    const ok = /reconstruites/.test($('#chWrap').textContent) && /au-dessus du stop|sous le stop/.test($('.chh').textContent);
    closeSheet();
    return ok ? true : 'mention bougies reconstruites ou distance au stop absente';
  });

  await t('S&P en Jour : cours en direct de SPY avant le robot, « — » sans cours, dernière clôture pour le mois', async () => {
    const D = days(30), last = D[29], today = addDays(last, 1), keep = Live.prices, pr = perfRange;
    Radar.hist.SPY = { bars: D.map((d, i) => [d, 500 + i]), n: 30, full: 1, last, ls: last, adj: 'splits' };
    const sel = { from: last, to: today, r: 0.5 }, pts = [{ date: last, index: 1, r: null }, { date: today, index: 1.005, r: 0.005 }], P = { pts, itd: null };
    const txt = () => { const m = document.createElement('div'); m.innerHTML = benchBlock(P, sel, pts).tiles; return m.textContent.replace(/\s+/g, ' '); };
    try {
      perfRange = 'day'; Live.prices = {};
      const a = txt(); if (!/S&P 500—/.test(a) || /0,00 %/.test(a) || !/ce soir/.test(a)) return 'sans cours : ' + a;
      Live.prices = { SPY: { date: today, price: 529 * 1.01, at: Date.now(), live: true } };
      const b = txt(); if (!/S&P 500\+1,00 %/.test(b) || !/direct/.test(b)) return 'direct : ' + b;
      perfRange = 'month'; Live.prices = {};
      const c = txt(); if (/S&P 500—/.test(c) || !/clôture du/.test(c)) return 'mois : ' + c;
      Radar.hist.SPY.bars.push([today, 529 * 1.02]); Radar.hist.SPY.last = today; perfRange = 'day';
      const d = txt(); if (!/S&P 500\+2,00 %/.test(d) || !/clôture officielle/.test(d)) return 'après robot : ' + d;
      return true;
    } finally { Live.prices = keep; perfRange = pr; delete Radar.hist.SPY; }
  });

  await t('Horloge de New York : séance, avant l’ouverture, week-end, férié, séance courte, décalage d’heure d’été', async () => {
    const c = (d, h, m) => nyClock(nyToMs(d, h * 60 + m)), bad = [];
    const chk = (k, x, st, re) => { if (x.st !== st || !re.test(x.msg)) bad.push(k + ' : ' + x.st + ' / ' + x.msg); };
    const a = c('2026-11-09', 10, 42); if (a.time !== '10:42') bad.push('heure ' + a.time);
    chk('séance', a, 'open', /clôture dans 5 h 18 \(22:00 à Paris\)/);
    chk('avant', c('2026-11-09', 8, 55), 'ext', /Ouverture dans 35 min \(15:30 à Paris\)/);
    chk('soir', c('2026-11-09', 18, 10), 'ext', /Séance terminée · ouverture mar\. 10 nov\./);
    chk('week-end', c('2026-11-14', 12, 0), 'shut', /^Fermé · ouverture lun\. 16 nov\./);
    chk('Thanksgiving', c('2026-11-26', 10, 0), 'shut', /férié : Thanksgiving/);
    chk('séance courte', c('2026-11-27', 10, 0), 'open', /clôture dans 3 h 00 \(19:00 à Paris\) · séance courte/);
    chk('heure d’été décalée', c('2026-03-10', 9, 0), 'ext', /\(14:30 à Paris\)/);
    if (nyHolidays(2026).H['2026-04-03'] !== 'Vendredi saint' || nyHolidays(2026).H['2026-07-03'] !== 'Independence Day') bad.push('fériés 2026');
    nyTick(); const el = document.getElementById('nyc'); if (!el || !/^\d\d:\d\d$/.test(el.querySelector('b').textContent)) bad.push('pastille absente');
    return bad.length ? bad.join(' | ') : true;
  });

  reset(); tab = 'dash';
  return out;
};
