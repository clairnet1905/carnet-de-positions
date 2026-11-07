/*CORE-START*/
// Moteur de calcul pur : aucune dépendance au DOM ni au stockage.
const Core = (() => {
  const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfq = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 8 });

  function usd(x, sign) {
    if (x == null || !isFinite(x)) return 'Non calculable';
    if (Math.abs(x) < 0.005) x = 0;
    const pre = x < 0 ? '−' : (sign && x > 0 ? '+' : '');
    return pre + nf2.format(Math.abs(x)) + ' $';
  }
  function pct(x, sign) {
    if (x == null || !isFinite(x)) return 'Non calculable';
    if (Math.abs(x) < 0.005) x = 0;
    const pre = x < 0 ? '−' : (sign && x > 0 ? '+' : '');
    return pre + nf2.format(Math.abs(x)) + ' %';
  }
  const qty = x => (x == null || !isFinite(x)) ? 'Non calculable' : nfq.format(x);

  function num(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    const s = String(v).replace(/[\s  ]/g, '').replace(',', '.');
    if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    return Number(s);
  }
  function numOr(v, d) { return (v == null || String(v).trim() === '') ? d : num(v); }
  const isNum = x => typeof x === 'number' && isFinite(x);
  function roundTo(x, d) { const f = Math.pow(10, d); return Math.round(x * f) / f; }
  function floorTo(x, d) { const f = Math.pow(10, d); return Math.floor(x * f + 1e-6) / f; }
  function le(a, b) { return a <= b + 1e-9 * Math.max(1, Math.abs(b)); }
  function days(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

  function normFees(f) {
    f = f || {};
    return { inFixed: numOr(f.inFixed, 0), inPct: numOr(f.inPct, 0), outFixed: numOr(f.outFixed, 0), outPct: numOr(f.outPct, 0), perShare: numOr(f.perShare, 0), minComm: numOr(f.minComm, 0) };
  }
  // Commission du courtier par action (CFD : 1 action par lot), avec un minimum par ordre, à l'entrée comme à la sortie.
  function commission(q, f) { return q > 0 && (f.perShare || f.minComm) ? Math.max(f.minComm || 0, q * (f.perShare || 0)) : 0; }
  // Frais d'entrée et de sortie : part fixe + part proportionnelle au montant échangé + commission par action.
  function feeIn(q, price, f) { return q > 0 ? f.inFixed + q * price * f.inPct / 100 + commission(q, f) : 0; }
  function feeOut(q, price, f) { return q > 0 ? f.outFixed + q * price * f.outPct / 100 + commission(q, f) : 0; }

  // ---------- 1. Calculateur avant achat ----------
  function sizePosition(inp) {
    const fees = normFees(inp.fees);
    const fractional = !!inp.fractional;
    const p = {
      equity: num(inp.equity), riskPct: num(inp.riskPct), entry: num(inp.entry), stop: num(inp.stop),
      leverage: num(inp.leverage), cap: num(inp.cap), fractional,
      decimals: fractional ? numOr(inp.decimals, 4) : 0,
      marginAvail: numOr(inp.marginAvail, null), fees
    };
    const errors = [];
    if (!isNum(p.equity) || p.equity <= 0) errors.push('La valeur nette de référence doit être positive.');
    if (!isNum(p.riskPct) || p.riskPct <= 0 || p.riskPct > 100) errors.push('Le risque par position doit être compris entre 0 et 100 %.');
    if (!isNum(p.entry) || p.entry <= 0) errors.push('Indiquez un prix d’entrée positif.');
    if (!isNum(p.stop) || p.stop <= 0) errors.push('Indiquez un stop initial positif.');
    if (isNum(p.entry) && isNum(p.stop) && p.stop > 0 && p.entry > 0 && p.stop >= p.entry) errors.push('Le stop doit être strictement inférieur au prix d’entrée (achat uniquement).');
    if (!isNum(p.leverage) || p.leverage < 1) errors.push('Le levier doit être supérieur ou égal à 1.');
    if (!isNum(p.cap) || p.cap <= 0) errors.push('Le plafond de position doit être positif.');
    const feeLabels = { inFixed: 'Frais fixes d’entrée', inPct: 'Frais d’entrée en %', outFixed: 'Frais fixes de sortie', outPct: 'Frais de sortie en %', perShare: 'Commission par action', minComm: 'Commission minimum' };
    for (const k in feeLabels) if (!isNum(fees[k]) || fees[k] < 0) errors.push(feeLabels[k] + ' : valeur invalide.');
    if (fractional && (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 8)) errors.push('La précision doit être un nombre entier de décimales entre 0 et 8.');
    if (p.marginAvail !== null && (!isNum(p.marginAvail) || p.marginAvail < 0)) errors.push('La marge disponible est invalide.');
    if (errors.length) return { ok: false, errors };

    const budget = p.equity * p.riskPct / 100;
    const fixed = fees.inFixed + fees.outFixed;
    const perUnit = (p.entry - p.stop) + p.entry * fees.inPct / 100 + p.stop * fees.outPct / 100 + 2 * fees.perShare;   // le minimum de commission est vérifié ensuite, quantité par quantité
    const lim = {
      risk: Math.max(0, (budget - fixed) / perUnit),
      cap: p.cap / p.entry,
      margin: p.marginAvail === null ? Infinity
        : Math.max(0, (p.marginAvail - fees.inFixed) / (p.entry / p.leverage + p.entry * fees.inPct / 100 + fees.perShare))
    };
    const dec = p.decimals, step = Math.pow(10, -dec);
    const ev = q => {
      const exposure = q * p.entry, margin = exposure / p.leverage;
      const fi = feeIn(q, p.entry, fees), fo = feeOut(q, p.stop, fees);
      const priceRisk = q * (p.entry - p.stop);
      return { q, exposure, margin, feeIn: fi, feeOut: fo, feesRT: fi + fo, priceRisk, totalRisk: priceRisk + fi + fo, marginNeed: margin + fi };
    };
    const fits = r => le(r.totalRisk, budget) && le(r.exposure, p.cap) && (p.marginAvail === null || le(r.marginNeed, p.marginAvail));
    const qMax = Math.min(lim.risk, lim.cap, lim.margin);
    let q = floorTo(qMax, dec), r = ev(q), guard = 0;
    while (q > 0 && !fits(r) && guard++ < 100000) { q = roundTo(q - step, dec); r = ev(q); }
    const binding = qMax === lim.cap ? 'cap' : (qMax === lim.risk ? 'risk' : 'margin');
    const stopDistPct = (p.entry - p.stop) / p.entry * 100;
    const base = { budget, lim, binding, stopDistPct, decimals: dec, step, marginChecked: p.marginAvail !== null, params: p };

    if (!(q > 0)) {
      const r1 = ev(step);
      const unit = dec === 0 ? '1 action' : qty(step) + ' action';
      const parts = [];
      if (fixed >= budget) parts.push(`les frais fixes aller-retour (${usd(fixed)}) atteignent déjà le budget de risque (${usd(budget)})`);
      else if (!le(r1.totalRisk, budget)) parts.push(`le risque estimé serait de ${usd(r1.totalRisk)} pour un budget de ${usd(budget)}`);
      if (!le(r1.exposure, p.cap)) parts.push(`l’exposition serait de ${usd(r1.exposure)} pour un plafond de ${usd(p.cap)}`);
      if (p.marginAvail !== null && !le(r1.marginNeed, p.marginAvail)) parts.push(`la marge et les frais d’entrée (${usd(r1.marginNeed)}) dépasseraient la marge disponible (${usd(p.marginAvail)})`);
      const msg = `Aucune position ne peut être prise : avec la plus petite quantité autorisée (${unit}), ${parts.join(' ; ')}.`
        + (dec === 0 ? ' Les fractions d’action sont désactivées.' : '');
      return Object.assign({ ok: false, blocked: true, errors: [msg] }, base);
    }

    let reason = null;
    if (r.exposure < p.cap - 0.005) {
      if (binding === 'risk') reason = `Taille réduite pour respecter le budget de risque de ${nf2.format(p.riskPct)} % (${usd(budget)}) : le stop est à ${pct(stopDistPct)} de l’entrée${(fixed || fees.inPct || fees.outPct) ? ', frais compris' : ''}.`;
      else if (binding === 'margin') reason = `Taille réduite par la marge disponible (${usd(p.marginAvail)}).`;
      else reason = `Quantité arrondie vers le bas à la précision autorisée (${qty(step)}).`;
      if (binding !== 'cap' && q < floorTo(qMax, dec) - step / 2) reason += ' Ajustée vers le bas après recalcul des frais.';
      else if (binding !== 'cap' && dec === 0) reason += ' Arrondie à l’action entière inférieure.';
    }
    return Object.assign({ ok: true, errors: [], reason, riskPctAccount: r.totalRisk / p.equity * 100, drop10: r.exposure * 0.10 }, base, r);
  }

  // ---------- 2. Comptabilité ----------
  // Swap estimé des CFD à l'achat : chaque nuit de semaine où la ligne est détenue à la clôture,
  // quantité × dernier cours connu × taux annuel ÷ 360, multiplié le jour du rollover triple (vendredi : week-end).
  // Un financement saisi à la main (montant réel du courtier) remplace l'estimation jusqu'à sa date.
  let SW = null;
  const swapMemo = new Map();
  function setSwap(cfg) { SW = cfg && cfg.pct > 0 ? cfg : null; }
  const addDay = d => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  function swapNights(lot) {
    const evs = lot.events || [], ph = priceHist(SW.prices, lot.ticker);
    const manual = evs.reduce((m, e) => e.type === 'funding' && e.date > m ? e.date : m, '');
    const sells = evs.filter(e => e.type === 'sell').sort((a, b) => a.date < b.date ? -1 : 1);
    const sig = [SW.pct, SW.triple, SW.today, lot.date, lot.qty, lot.price, manual, sells.map(e => e.date + ':' + e.qty).join(','), ph.length, ph.length ? ph[ph.length - 1].date + ph[ph.length - 1].price : ''].join('|');
    const hit = swapMemo.get(lot.id);
    if (hit && hit.sig === sig) return hit.nights;
    const px = ph.slice().sort((a, b) => a.date < b.date ? -1 : 1), nights = [];
    let held = lot.qty, si = 0, pi = 0, price = lot.price;
    for (let d = lot.date; d < SW.today; d = addDay(d)) {
      while (si < sells.length && sells[si].date <= d) held -= sells[si++].qty;
      if (held <= 1e-9) break;
      while (pi < px.length && px[pi].date <= d) price = px[pi++].price;
      const wd = new Date(d + 'T12:00:00Z').getUTCDay();
      if (wd === 0 || wd === 6 || d <= manual) continue;
      nights.push([d, held * price * SW.pct / 100 / 360 * (wd === SW.triple ? 3 : 1)]);
    }
    swapMemo.set(lot.id, { sig, nights });
    return nights;
  }
  // Swap estimé jusqu'à la clôture du jour upTo (la nuit de upTo n'est pas encore passée).
  function swapEst(lot, upTo) {
    if (!SW) return 0;
    let t = 0;
    for (const [d, a] of swapNights(lot)) { if (upTo && d >= upTo) break; t += a; }
    return t;
  }
  function lotState(lot, upTo) {
    const evs = (lot.events || []).filter(e => !upTo || e.date <= upTo);
    let sold = 0, gross = 0, exitFees = 0, funding = 0, divs = 0, lastSell = null;
    for (const e of evs) {
      if (e.type === 'sell') {
        sold += e.qty; gross += e.qty * (e.price - lot.price); exitFees += e.fee || 0;
        if (!lastSell || e.date > lastSell) lastSell = e.date;
      } else if (e.type === 'funding') funding += e.amount;
      else if (e.type === 'dividend' || e.type === 'adjust') divs += e.amount;
    }
    let rem = lot.qty - sold;
    if (Math.abs(rem) < 1e-9) rem = 0;
    const fundingEst = swapEst(lot, upTo);
    funding += fundingEst;
    const entryFee = lot.entryFee || 0;
    // Chaque coût n'apparaît qu'une fois : frais d'entrée, frais de sortie, financement (saisi ou estimé).
    const netRealized = gross + divs - entryFee - exitFees - funding;
    return { rem, sold, gross, exitFees, funding, fundingEst, divs, entryFee, txFees: entryFee + exitFees, netRealized, closed: rem <= 0, closeDate: rem <= 0 ? lastSell : null };
  }

  function priceHist(prices, t) { return (prices && prices[t]) || []; }
  function priceOn(prices, t, d) { return priceHist(prices, t).find(x => x.date === d) || null; }
  function lastPrice(prices, t, upTo) {
    let best = null;
    for (const x of priceHist(prices, t)) if ((!upTo || x.date <= upTo) && (!best || x.date >= best.date)) best = x;
    return best;
  }

  // mode 'last' : dernier cours connu ; mode 'exact' : cours saisi exactement à la date upTo.
  function accountState(st, upTo, mode) {
    const s = st.settings;
    let deposits = 0, withdrawals = 0;
    for (const f of st.flows) if (!upTo || f.date <= upTo) { if (f.amount >= 0) deposits += f.amount; else withdrawals -= f.amount; }
    let realized = 0, unreal = 0, txFees = 0, funding = 0, divs = 0, gross = 0, exposure = 0, margin = 0, openCount = 0, minPriceDate = null;
    const missing = [], fallback = [];
    for (const lot of st.lots) {
      if (upTo && lot.date > upTo) continue;
      const ls = lotState(lot, upTo);
      realized += ls.netRealized; txFees += ls.txFees; funding += ls.funding; divs += ls.divs; gross += ls.gross;
      if (ls.closed) continue;
      openCount++;
      let pr = mode === 'exact' ? priceOn(st.prices, lot.ticker, upTo) : lastPrice(st.prices, lot.ticker, upTo);
      if (!pr) {
        if (mode === 'exact') { missing.push(lot.ticker); continue; }
        pr = { price: lot.price, date: lot.date }; fallback.push(lot.ticker);
      }
      unreal += ls.rem * (pr.price - lot.price);
      exposure += ls.rem * pr.price;
      margin += ls.rem * pr.price / (lot.leverage || 1);
      if (!minPriceDate || pr.date < minPriceDate) minPriceDate = pr.date;
    }
    const equity = s.initialCapital + deposits - withdrawals + realized + unreal;
    return { equity, deposits, withdrawals, realized, unreal, txFees, funding, divs, gross, exposure, margin, openCount, minPriceDate, missing, fallback };
  }

  // ---------- 3. Performance ----------
  // Une observation n'existe qu'à une date où chaque position ouverte a un cours saisi ce jour-là,
  // ou quand aucune position n'est ouverte. Les valeurs courtier sont prioritaires à leur date.
  function observations(st, today) {
    const s = st.settings, start = s.startDate;
    const startFlows = st.flows.filter(f => f.date <= start).reduce((a, f) => a + f.amount, 0);
    const map = new Map();
    map.set(start, { date: start, value: s.initialCapital + startFlows, source: 'initial' });
    const dates = new Set();
    for (const t in st.prices) for (const x of st.prices[t]) dates.add(x.date);
    for (const l of st.lots) { dates.add(l.date); for (const e of l.events || []) dates.add(e.date); }
    for (const f of st.flows) dates.add(f.date);
    for (const d of dates) {
      if (d <= start || (today && d > today)) continue;
      const a = accountState(st, d, 'exact');
      if (a.missing.length) continue;
      map.set(d, { date: d, value: a.equity, source: a.openCount ? 'app' : 'app-flat' });
    }
    for (const b of st.snapshots || []) {
      if (b.date < start || (today && b.date > today) || !isNum(b.netValue)) continue;
      const appObs = map.get(b.date);
      map.set(b.date, { date: b.date, value: b.netValue, source: 'courtier', appValue: appObs && appObs.source !== 'courtier' ? appObs.value : null });
    }
    return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  }

  function twr(obs, flows) {
    const pts = [];
    if (!obs.length) return { points: pts, broken: false };
    pts.push(Object.assign({}, obs[0], { index: 1, r: null, est: false }));
    let idx = 1;
    for (let i = 1; i < obs.length; i++) {
      const a = obs[i - 1], b = obs[i];
      const fl = flows.filter(f => f.date > a.date && f.date <= b.date);
      const F = fl.reduce((x, f) => x + f.amount, 0);
      const exact = fl.every(f => f.date === b.date);
      let r;
      if (exact) {
        if (!(a.value > 0)) return { points: pts, broken: true, brokenAt: b.date };
        r = (b.value - F) / a.value - 1;
      } else {
        // Modified Dietz : flux pondérés par la durée restante de la sous-période.
        const T = days(a.date, b.date);
        const W = fl.reduce((x, f) => x + f.amount * days(f.date, b.date) / T, 0);
        const den = a.value + W;
        if (!(den > 0)) return { points: pts, broken: true, brokenAt: b.date };
        r = (b.value - a.value - F) / den;
      }
      idx *= 1 + r;
      pts.push(Object.assign({}, b, { index: idx, r, est: !exact }));
    }
    return { points: pts, broken: false };
  }

  function periodReturn(points, from, to) {
    if (!points.length) return null;
    let base = null, end = null;
    for (const p of points) { if (p.date < from) base = p; if (p.date <= to) end = p; }
    if (!base && points[0].date <= to) base = points[0];
    if (!base || !end || end.date <= base.date) return null;
    const est = points.some(p => p.date > base.date && p.date <= end.date && p.est);
    return { r: (end.index / base.index - 1) * 100, from: base.date, to: end.date, est };
  }

  function maxDrawdown(points) {
    if (points.length < 2) return null;
    let peak = points[0], worst = { dd: 0, peak: points[0].date, trough: points[0].date };
    for (const p of points) {
      if (p.index > peak.index) peak = p;
      const dd = (p.index / peak.index - 1) * 100;
      if (dd < worst.dd) worst = { dd, peak: peak.date, trough: p.date };
    }
    return worst;
  }

  function frequency(points) {
    if (points.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < points.length; i++) gaps.push(days(points[i - 1].date, points[i].date));
    gaps.sort((a, b) => a - b);
    const m = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
    return { count: points.length, medianGap: m, maxGap: gaps[gaps.length - 1] };
  }

  // ---------- 4. Statistiques des positions clôturées ----------
  // rUnit(lot) : valeur de 1 R en dollars (par défaut le risque initial réel au stop).
  function tradeStats(st, rUnit) {
    const closed = [];
    for (const lot of st.lots) {
      const ls = lotState(lot), u = rUnit ? rUnit(lot) : lot.riskInitial;
      if (ls.closed) closed.push({ lot, net: ls.netRealized, date: ls.closeDate, R: u > 0 ? ls.netRealized / u : null });
    }
    const wins = closed.filter(c => c.net > 0.0049), losses = closed.filter(c => c.net < -0.0049);
    const sumW = wins.reduce((a, c) => a + c.net, 0), sumL = losses.reduce((a, c) => a + c.net, 0);
    const withR = closed.filter(c => c.R != null);
    const planned = st.lots.filter(l => l.planOk === true || l.planOk === false);
    return {
      count: closed.length, wins: wins.length, losses: losses.length,
      winRate: closed.length ? wins.length / closed.length * 100 : null,
      avgWin: wins.length ? sumW / wins.length : null,
      avgLoss: losses.length ? sumL / losses.length : null,
      profitFactor: sumL < 0 ? sumW / -sumL : null,
      avgR: withR.length ? withR.reduce((a, c) => a + c.R, 0) / withR.length : null,
      avgWinR: (x => x.length ? x.reduce((a, c) => a + c.R, 0) / x.length : null)(withR.filter(c => c.net > 0.0049)),
      avgLossR: (x => x.length ? x.reduce((a, c) => a + c.R, 0) / x.length : null)(withR.filter(c => c.net < -0.0049)),
      rCount: withR.length,
      planRate: planned.length ? planned.filter(l => l.planOk).length / planned.length * 100 : null,
      planCount: planned.length, closed
    };
  }

  // Analyse du stop pour la partie restante d'une ligne.
  function stopAnalysis(lot, ls, last, fees) {
    const stop = lot.stopCurrent;
    if (!(isNum(stop) && stop > 0)) return { missing: true };
    const estExit = feeOut(ls.rem, stop, normFees(fees));
    const vsEntry = ls.rem * (stop - lot.price) - estExit;
    return {
      missing: false, estExit, vsEntry,
      totalIfStop: ls.netRealized + ls.rem * (stop - lot.price) - estExit,
      pullback: last ? ls.rem * (last.price - stop) + estExit : null,
      belowStop: last ? last.price <= stop : false
    };
  }

  return { usd, pct, qty, num, numOr, isNum, roundTo, floorTo, days, normFees, commission, feeIn, feeOut, setSwap, sizePosition,
    lotState, priceOn, lastPrice, accountState, observations, twr, periodReturn, maxDrawdown, frequency, tradeStats, stopAnalysis };
})();
/*CORE-END*/
