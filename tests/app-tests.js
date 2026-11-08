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
    if (!/Sous le stop · clôture mensuelle/.test($('#view').textContent)) return 'carte position MMM';
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

  await t('Graphique : bougies du robot, SMA, stop et ventes ; clôtures sans bougies', async () => {
    const D = days(90);
    const u = unpackHist({ s: D[0], o: D.map((d, i) => i ? Core.days(D[i - 1], d) : 0), c: D.map((d, i) => 100 + i), n: 90, x: D.slice(-70).flatMap(() => [-50, 120, -130]), xn: 70 });
    if (u.ohlc !== 70 || u.bars[89].length !== 5 || Math.abs(u.bars[89][3] - 189 * 1.012) > 1e-6) return 'décodage bougies ' + u.ohlc;
    Radar.hist.AAA = u; S.watch = [{ id: 'w5', ticker: 'AAA', period: 5, tf: 'D', sym: '' }];
    S.lots = [lot({ date: D[40], price: 140, events: [{ id: 'st', type: 'stop', date: D[60], from: 90, to: 150 }, { id: 's', type: 'sell', date: D[70], qty: 4, price: 170, fee: 0 }] })];
    sheetChart('AAA'); await wait(30);
    const svg = $('#chSvg'); if (!svg) return 'graphique absent';
    const nR = svg.querySelectorAll('rect').length;
    if (nR < 60 || !svg.querySelector('.sm') || !svg.querySelector('.stp') || !svg.querySelector('.m-in') || !svg.querySelector('.m-out')) return `éléments manquants (${nR} bougies)`;
    $('[data-act="ch-range"][data-n="22"]').click(); await wait(30);
    if ($('#chSvg').querySelectorAll('rect').length !== 22) return '1 M : ' + $('#chSvg').querySelectorAll('rect').length;
    Radar.hist.AAA = { bars: D.map((d, i) => [d, 100 + i]), n: 90, last: D[89] }; anaMemo.clear();
    sheetChart('AAA'); await wait(30);
    const ok = $('#chSvg .cl') && !$('#chSvg rect'); closeSheet();
    return ok ? true : 'pas de ligne de clôtures';
  });

  reset(); tab = 'dash';
  return out;
};
