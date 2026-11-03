// TradeGuide — UI controller
import { analyze, computeSeries, scoreAt, labelFor, riskReport, tradePlan, fmtPx, pctS, fmtBig, ENGINE_VERSION } from './engine.js';
import { getChart, searchSymbols, UNIVERSE, isDemo, broker, access, samplePortfolio, botApi, liveApi } from './data.js';
import { learnAndDecide } from './learn.js';
import { classify, PROFILES, marketStatus, classVolatility } from './assets.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('tg:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tg:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  symbol: null,
  interval: store.get('interval', '1d'),
  account: store.get('account', 10000),
  riskPct: store.get('riskPct', 1),
  watchlist: store.get('watchlist', []), // [{symbol, name, lastAction}]
  result: null,
  scanSet: 'stocks',
  scanRows: [],
  sort: { key: 'score', dir: -1 },
  portfolio: null,
  pfSort: { key: 'value', dir: -1 },
};
let reqId = 0;
const charts = {};

// ---------- Boot ----------
function init() {
  $('#engineVer').textContent = `engine v${ENGINE_VERSION}`;
  $$('#intervalSeg button').forEach((b) => b.classList.toggle('on', b.dataset.interval === state.interval));
  $('#accInput').value = state.account;
  $('#riskInput').value = state.riskPct;

  const picks = ['AAPL', 'NVDA', 'TSLA', 'SPY', 'BTC-USD', 'ETH-USD', 'SOL-USD'];
  $('#quickPicks').innerHTML = picks.map((s) => `<button class="chip" data-sym="${s}">${s}</button>`).join('');
  $('#quickPicks').addEventListener('click', (e) => { const s = e.target.closest('[data-sym]')?.dataset.sym; if (s) load(s); });

  $$('[data-view]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); show(el.dataset.view); }));
  $('#intervalSeg').addEventListener('click', (e) => {
    const iv = e.target.closest('[data-interval]')?.dataset.interval; if (!iv || iv === state.interval) return;
    state.interval = iv; store.set('interval', iv);
    $$('#intervalSeg button').forEach((b) => b.classList.toggle('on', b === e.target));
    if (state.symbol) load(state.symbol);
  });
  setupSearch();
  ['accInput', 'riskInput'].forEach((id) => $('#' + id).addEventListener('input', () => {
    const a = parseFloat($('#accInput').value), r = parseFloat($('#riskInput').value);
    if (a > 0) { state.account = a; store.set('account', a); }
    if (r > 0 && r <= 10) { state.riskPct = r; store.set('riskPct', r); }
    if (state.result) renderPlan(state.result);
  }));
  $('#starBtn').addEventListener('click', toggleWatch);
  $('#scanSet').addEventListener('click', (e) => {
    const s = e.target.closest('[data-set]')?.dataset.set; if (!s) return;
    state.scanSet = s; $$('#scanSet button').forEach((b) => b.classList.toggle('on', b.dataset.set === s));
  });
  $('#scanBtn').addEventListener('click', () => runScan());
  ['onlyBuys', 'lowRisk'].forEach((id) => $('#' + id).addEventListener('change', renderScan));

  // disclaimer
  const dlg = $('#disclaimer');
  if (!store.get('ack', false) && dlg.showModal) { dlg.showModal(); dlg.addEventListener('close', () => store.set('ack', true)); }

  // deep link: #/AAPL or ?s=AAPL
  const symFromHash = () => (location.hash.startsWith('#/') ? decodeURIComponent(location.hash.slice(2)) : '');
  const fromQ = new URLSearchParams(location.search).get('s');
  if (symFromHash() || fromQ) load((symFromHash() || fromQ).toUpperCase());
  else if (location.hash === '#portfolio') show('portfolio');
  window.addEventListener('hashchange', () => { const s = symFromHash(); if (s && s.toUpperCase() !== state.symbol) load(s.toUpperCase()); });
  initPortfolio();
  initBot();

  renderWatch();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + view));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'watchlist') refreshWatch();
  if (view === 'scanner') renderMarkets();
  if (view === 'portfolio' && !state.portfolio && access.get()) loadPortfolio();
  if (view === 'bot' && access.get() && $('#botOpen').hidden) loadBot();
  if (view === 'analyze' && state.result) requestAnimationFrame(() => Object.values(charts).forEach((c) => c?.timeScale().fitContent()));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// ---------- Search ----------
function setupSearch() {
  const inp = $('#search'), list = $('#searchResults');
  let t, items = [], active = -1;
  const close = () => { list.hidden = true; active = -1; };
  const pick = (sym) => { inp.value = ''; close(); inp.blur(); load(sym); };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim();
    if (!q) return close();
    t = setTimeout(async () => {
      try { items = await searchSymbols(q); } catch { items = []; }
      if (inp.value.trim() !== q) return;
      const direct = q.toUpperCase().replace(/[^A-Z0-9.\-=^]/g, '');
      if (direct && !items.some((x) => x.symbol === direct)) items.push({ symbol: direct, name: 'Analyze this symbol', type: '' });
      list.innerHTML = items.map((x, i) => `<li role="option" data-i="${i}"><div><div class="s-sym">${esc(x.symbol)}</div><div class="s-name">${esc(x.name)}${x.exchange ? ' · ' + esc(x.exchange) : ''}</div></div>${x.type === 'INDEX' ? '<span class="s-type">index</span>' : badge(x.symbol, x.assetClass || (x.type === 'CRYPTOCURRENCY' ? 'crypto' : x.type === 'ETF' ? 'etf' : 'stock'), x.name, true)}</li>`).join('');
      list.hidden = !items.length; active = -1;
    }, 220);
  });
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(items[+li.dataset.i].symbol); } });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('li', list).forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sym = active >= 0 ? items[active]?.symbol : inp.value.trim().toUpperCase();
      if (sym) pick(sym);
    } else if (e.key === 'Escape') close();
  });
  inp.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- Analyze ----------
// asset-class badge: STOCK / ETF / CRYPTO (+ crypto-linked flag)
function badge(symbol, assetClass, name, small) {
  const c = classify(symbol, assetClass, name);
  return `<span class="cls c-${c.cls}"${small ? ' style="font-size:9.5px;padding:3px 5px"' : ''}>${c.profile.short}</span>${c.cryptoLinked ? ` <span class="cls c-link" title="${esc(c.linkedNote)}"${small ? ' style="font-size:9.5px;padding:3px 5px"' : ''}>₿-LINKED</span>` : ''}`;
}
const benchFor = (ac) => (ac === 'crypto' ? 'BTC-USD' : 'SPY');

async function load(symbol) {
  const id = ++reqId;
  state.symbol = symbol;
  show('analyze');
  if (location.hash !== '#/' + symbol) history.replaceState(null, '', '#/' + symbol);
  $('#analyzeEmpty').hidden = true; $('#analyzeError').hidden = true; $('#analysis').hidden = true; $('#analyzeLoading').hidden = false;
  try {
    const data = await getChart(symbol, state.interval);
    if (id !== reqId) return;
    const meta = { ...data.meta, interval: state.interval };
    let bench = null;
    const bsym = benchFor(meta.assetClass);
    if (bsym !== meta.symbol) { try { bench = (await getChart(bsym, state.interval)).candles; } catch { /* beta optional */ } }
    if (id !== reqId) return;
    const res = analyze(dedupe(data.candles), meta, bench, { account: state.account, riskPct: state.riskPct });
    res.source = data.source + (data.stale ? ` · STALE (sources busy; from ${new Date(data.staleSince).toLocaleTimeString([], { timeStyle: 'short' })})` : ''); res.demo = !!data.demo;
    state.result = res;
    $('#demoBanner').hidden = !(isDemo() || data.demo);
    render(res);
    updateWatchAction(meta.symbol, res.signal.action);
    $('#histDecision').innerHTML = '<span class="why">Learning this asset\'s history…</span>'; $('#histEvidence').innerHTML = ''; $('#histPill').textContent = ''; $('#histNote').textContent = '';
    setTimeout(() => { if (id === reqId) renderHistory(learnAndDecide(dedupe(data.candles), meta, bench)); }, 30);
  } catch (e) {
    if (id !== reqId) return;
    $('#analyzeError').hidden = false;
    $('#analyzeError').textContent = `Couldn't analyse ${symbol}: ${e.message}. Check the symbol (crypto uses the -USD suffix, e.g. BTC-USD) and try again.`;
  } finally {
    if (id === reqId) $('#analyzeLoading').hidden = true;
  }
}

function dedupe(candles) {
  const out = []; let lastT = -Infinity;
  for (const c of candles) if (c.t > lastT) { out.push(c); lastT = c.t; }
  return out;
}

function render(res) {
  const { meta, signal: s, risk: r } = res;
  $('#analysis').hidden = false;
  $('#qSym').textContent = meta.symbol;
  $('#qName').textContent = meta.name;
  $('#qPrice').textContent = (meta.currency === 'USD' ? '$' : '') + fmtPx(res.price);
  const chg = $('#qChg'); chg.textContent = pctS(res.change) + ` ${meta.interval === '1h' ? '1h' : meta.interval === '1wk' ? '1w' : '1d'}`; chg.className = 'q-chg mono ' + (res.change >= 0 ? 'up' : 'down');
  const asOf = new Date(res.asOf * 1000);
  $('#qMeta').textContent = `${meta.assetClass.toUpperCase()} · ${meta.exchange || '—'} · ${meta.currency} · last bar ${asOf.toLocaleString([], { dateStyle: 'medium', timeStyle: meta.interval === '1h' ? 'short' : undefined })} · source: ${res.source}`;
  setStar();
  const C = classify(meta.symbol, meta.assetClass, meta.name);
  $('#qCls').outerHTML = `<span id="qCls">${badge(meta.symbol, meta.assetClass, meta.name)}</span>`;
  const ms = marketStatus(C.cls);
  $('#qMkt').className = `mkt ${ms.phase}`; $('#qMkt').textContent = ms.label; $('#qMkt').title = ms.detail;
  $('#analysis').style.setProperty('--cls-color', C.profile.color);
  renderProfile(res, C, ms);

  // verdict
  $('#vLabel').innerHTML = `<span class="tone-${s.tone}">${s.label}</span>${s.changed ? '<span class="flip">new signal</span>' : ''}`;
  $('#vMark').style.left = `${(s.score + 100) / 2}%`;
  $('#vScore').textContent = `Score ${s.score >= 0 ? '+' : ''}${s.score.toFixed(0)} / 100 · previous bar ${s.prevScore >= 0 ? '+' : ''}${s.prevScore.toFixed(0)}`;
  $('#confPill').textContent = `${s.confidence.label} confidence · ${s.confidence.value}%`;
  $('#vSummary').textContent = res.summary;

  // risk
  const rc = r.score <= 3 ? 'var(--up)' : r.score <= 5 ? 'var(--buy)' : r.score <= 7 ? 'var(--warn)' : 'var(--down)';
  $('#riskPill').textContent = r.level; $('#riskPill').style.color = rc;
  $('#riskNum').innerHTML = `${r.score.toFixed(1)}<small>/10</small>`; $('#riskNum').style.color = rc;
  $('#riskBars').innerHTML = Array.from({ length: 10 }, (_, i) => `<span style="${i < Math.round(r.score) ? `background:${i < 3 ? 'var(--up)' : i < 5 ? 'var(--buy)' : i < 7 ? 'var(--warn)' : 'var(--down)'}` : ''}"></span>`).join('');
  const m = [
    ['Volatility (ann.)', pct(r.annVol)], ['Max drawdown', pct(r.maxDrawdown)],
    ['VaR 95% / bar', r.var95 != null ? '−' + pct(r.var95, 1) : '—'], ['Typical bar (ATR)', r.atrPct != null ? pct(r.atrPct, 1) : '—'],
    [`Beta vs ${meta.assetClass === 'crypto' ? 'BTC' : 'SPY'}`, r.beta?.beta != null ? r.beta.beta.toFixed(2) : '—'], ['Sharpe (1y)', r.sharpe != null ? r.sharpe.toFixed(2) : '—'],
    ['From 1y high', pct(r.fromHigh)], ['$ volume / bar', r.dollarVol != null ? '$' + fmtBig(r.dollarVol) : '—'],
  ];
  $('#riskMetrics').innerHTML = m.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  // factors
  $('#factors').innerHTML = [...s.factors].sort((a, b) => b.weight - a.weight).map((f) => {
    const w = Math.abs(f.score) * 50, left = f.score >= 0 ? 50 : 50 - w;
    const col = f.score > 0.1 ? 'var(--up)' : f.score < -0.1 ? 'var(--down)' : 'var(--hold)';
    return `<li><span class="f-name">${f.label} <small style="color:var(--dim);font-weight:400">${f.weight}%</small></span><span class="f-score" style="color:${col}">${f.score >= 0 ? '+' : ''}${f.score.toFixed(2)}</span>
      <div class="f-bar"><span style="left:${left}%;width:${w}%;background:${col}"></span></div><span class="f-why">${esc(f.reason)}</span></li>`;
  }).join('');

  renderMyPosition(res);
  renderPlan(res);
  $('#warnings').innerHTML = r.warnings.map((w) => `<li class="${w.sev}">${esc(w.text)}</li>`).join('');
  renderBacktest(res);
  renderCharts(res);
}

function renderPlan(res) {
  const p = tradePlan(res.S, res.signal, res.risk, { account: state.account, riskPct: state.riskPct });
  const s = res.signal, long = p.direction === 'long';
  const title = s.action === 'BUY' ? 'Trade plan — long setup' : s.action === 'SELL' ? 'Plan — exit / protect' : 'Plan — if you enter anyway';
  $('#planTitle').textContent = title;
  const row = (cls, label, px, pc) => `<div class="lvl ${cls}"><b>${label}</b><span class="px">${fmtPx(px)}</span><span class="pc">${pc == null ? '' : pctS(pc)}</span></div>`;
  if (long) {
    $('#levels').innerHTML = row('entry', 'Entry (last close)', p.entry) + row('stop', 'Stop-loss', p.stop, p.stopPct) + row('tgt', 'Target 1 · 2R', p.t1, p.t1Pct) + row('tgt', 'Target 2 · 3R', p.t2, p.t2Pct) + row('trail', 'Trailing stop (3×ATR)', p.trailing, (p.trailing - p.entry) / p.entry);
  } else {
    $('#levels').innerHTML = row('entry', 'Last close', p.entry) + row('trail', 'Exit-if-holding: trailing stop', p.entry - 1.5 * (res.S.atr.at(-1) || 0), -(1.5 * (res.S.atr.at(-1) || 0)) / p.entry) + row('stop', 'Re-check if price reclaims', p.stop, p.stopPct) + row('tgt', 'Downside target 1 · 2R', p.t1, p.t1Pct) + row('tgt', 'Downside target 2 · 3R', p.t2, p.t2Pct);
  }
  const units = p.units, unitWord = res.meta.assetClass === 'crypto' ? 'units' : 'shares';
  const qty = res.meta.assetClass === 'crypto' ? units.toFixed(units < 1 ? 6 : 4) : Math.floor(units).toLocaleString();
  const out = $('#sizeOut');
  out.className = 'size-out' + (long ? '' : ' short');
  if (long) {
    out.innerHTML = `Buy about <b>${qty}</b> ${unitWord} (≈ <b>$${Math.round(p.positionValue).toLocaleString()}</b>). If the stop hits you lose ≈ <b>$${Math.round(p.riskDollars).toLocaleString()}</b> (${state.riskPct}% of account); Target 1 makes ≈ <b>$${Math.round(p.riskDollars * 2).toLocaleString()}</b>.${p.capped ? ' <br><small>Size capped at 25% of account — the stop is tight relative to price.</small>' : ''}`;
  } else {
    out.innerHTML = `Signal is bearish — TradeGuide does not suggest opening a new long. If you <b>hold</b>, consider tightening your stop or trimming. Short-selling and inverse products carry unlimited/compounding risk and are for experienced traders only.`;
  }
  const notes = [];
  if (s.action === 'WAIT') notes.push('No edge right now: the levels above show where risk sits if you take the trade anyway. Waiting for a Buy signal is the disciplined choice.');
  if (p.resistanceWarning) notes.push(p.resistanceWarning);
  if (res.risk.score >= 8) notes.push('Risk is very high — consider half your normal position size.');
  { const C = classify(res.meta.symbol, res.meta.assetClass, res.meta.name);
    if (state.riskPct > C.profile.suggestRiskPct && C.cls === 'crypto') notes.push(`For crypto, ${C.profile.suggestRiskPct}% risk per trade is a common ceiling — you're using ${state.riskPct}%.`);
    notes.push(`Stop width ${C.cls === 'crypto' ? '2.5' : '2'}×ATR (${C.profile.label.toLowerCase()} default).`); }
  notes.push('Levels use last close; adjust for the live price and spread before placing orders.');
  $('#planNote').textContent = notes.join(' ');
}

function renderBacktest(res) {
  const b = res.backtest;
  const fmtD = (t) => new Date(t * 1000).toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
  $('#btRange').textContent = b.from ? `${fmtD(b.from)} → ${fmtD(b.to)}` : '';
  const cls = (x) => (x == null ? '' : x >= 0 ? 'up' : 'down');
  const cards = [
    ['Signal strategy', `<b class="${cls(b.totalReturn)}">${pctS(b.totalReturn)}</b>`, `max DD ${pct(b.maxDrawdown)}`],
    ['Buy & hold', `<b class="${cls(b.buyHold)}">${pctS(b.buyHold)}</b>`, `max DD ${pct(b.buyHoldMaxDrawdown)}`],
    ['Win rate', `<b>${b.winRate == null ? '—' : pct(b.winRate)}</b>`, `${b.trades} closed trades`],
    ['Profit factor', `<b>${b.profitFactor == null ? '—' : isFinite(b.profitFactor) ? b.profitFactor.toFixed(2) : '∞'}</b>`, `in market ${pct(b.exposure)} of time`],
  ];
  $('#btGrid').innerHTML = cards.map(([k, v, sub]) => `<div class="bt"><span>${k}</span>${v}<br><small>${sub}</small></div>`).join('');
  const rows = b.tradeList.slice(-25).reverse();
  $('#tradeTable').innerHTML = `<thead><tr><th>Entry</th><th>Exit</th><th>Entry px</th><th>Exit px</th><th>Return</th><th>Exit by</th></tr></thead><tbody>` +
    (rows.map((t) => `<tr><td>${fmtD(t.entryT)}</td><td>${fmtD(t.exitT)}</td><td>${fmtPx(t.entry)}</td><td>${fmtPx(t.exit)}</td><td class="${cls(t.ret)}">${pctS(t.ret)}</td><td>${t.reason}</td></tr>`).join('') || '<tr><td colspan="6">No completed trades</td></tr>') +
    (b.open ? `<tr><td>${fmtD(b.open.entryT)}</td><td>open</td><td>${fmtPx(b.open.entry)}</td><td>—</td><td class="${cls(b.open.unrealised)}">${pctS(b.open.unrealised)}</td><td>—</td></tr>` : '') + '</tbody>';
}

// ---------- Charts ----------
const LC = () => window.LightweightCharts;
function baseOpts(el, extra = {}) {
  return {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: '#8b9aab', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(31,42,53,.5)' }, horzLines: { color: 'rgba(31,42,53,.5)' } },
    rightPriceScale: { borderColor: '#1f2a35' },
    timeScale: { borderColor: '#1f2a35', timeVisible: state.interval === '1h', secondsVisible: false },
    crosshair: { mode: 0 },
    handleScroll: { vertTouchDrag: false },
    ...extra,
  };
}
function renderCharts(res) {
  if (!LC()) return;
  ['main', 'rsi', 'eq'].forEach((k) => { charts[k]?.remove(); charts[k] = null; });
  const { S } = res;
  const bars = res.S.c.map((c, i) => ({ time: res.times[i], open: S.o[i], high: S.h[i], low: S.l[i], close: c }));
  const line = (arr) => arr.map((v, i) => (v == null ? null : { time: res.times[i], value: v })).filter(Boolean);

  const main = LC().createChart($('#chart'), baseOpts($('#chart')));
  const cs = main.addCandlestickSeries({ upColor: '#26c281', downColor: '#f05252', borderVisible: false, wickUpColor: '#26c281', wickDownColor: '#f05252', priceFormat: { type: 'price', precision: res.price < 1 ? 6 : 2, minMove: res.price < 1 ? 0.000001 : 0.01 } });
  cs.setData(bars);
  const vol = main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(S.v.map((v, i) => ({ time: res.times[i], value: v, color: S.c[i] >= S.o[i] ? 'rgba(38,194,129,.35)' : 'rgba(240,82,82,.35)' })));
  main.addLineSeries({ color: '#4ea8ff', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(line(S.sma50));
  main.addLineSeries({ color: '#c084fc', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(line(S.sma200));
  cs.setMarkers(res.backtest.markers.map((m) => ({ time: m.time, position: m.kind === 'buy' ? 'belowBar' : 'aboveBar', color: m.kind === 'buy' ? '#26c281' : '#f05252', shape: m.kind === 'buy' ? 'arrowUp' : 'arrowDown', text: m.text })));
  const p = tradePlan(S, res.signal, res.risk, { account: state.account, riskPct: state.riskPct });
  if (res.signal.action === 'BUY') {
    cs.createPriceLine({ price: p.stop, color: '#f05252', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'stop' });
    cs.createPriceLine({ price: p.t1, color: '#26c281', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'T1' });
  }
  const visible = state.interval === '1wk' ? 156 : state.interval === '1h' ? 240 : 260;
  main.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - visible), to: bars.length + 3 });
  charts.main = main;

  const rc = LC().createChart($('#rsiChart'), baseOpts($('#rsiChart'), { rightPriceScale: { borderColor: '#1f2a35', scaleMargins: { top: 0.1, bottom: 0.1 } } }));
  const rs = rc.addLineSeries({ color: '#f5a524', lineWidth: 1.5, priceLineVisible: false });
  rs.setData(line(S.rsi));
  [70, 30].forEach((v) => rs.createPriceLine({ price: v, color: '#5d6c7c', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
  charts.rsi = rc;
  // sync time scales
  main.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r) rc.timeScale().setVisibleLogicalRange(r); });
  rc.timeScale().setVisibleLogicalRange(main.timeScale().getVisibleLogicalRange());

  const ec = LC().createChart($('#equityChart'), baseOpts($('#equityChart')));
  const bhStart = S.c[S.c.length - res.backtest.curve.length];
  ec.addLineSeries({ color: '#5d6c7c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'buy&hold' })
    .setData(res.backtest.curve.map((pt, j) => ({ time: pt.time, value: S.c[S.c.length - res.backtest.curve.length + j] / bhStart })));
  ec.addLineSeries({ color: '#3ddc97', lineWidth: 2, priceLineVisible: false, title: 'signal' }).setData(res.backtest.curve);
  ec.timeScale().fitContent();
  charts.eq = ec;
}

// ---------- Watchlist ----------
const inWatch = (sym) => state.watchlist.some((w) => w.symbol === sym);
function setStar() { const on = inWatch(state.symbol); $('#starBtn').textContent = on ? '★' : '☆'; $('#starBtn').classList.toggle('on', on); $('#starBtn').setAttribute('aria-label', on ? 'Remove from watchlist' : 'Add to watchlist'); }
function toggleWatch() {
  const r = state.result; if (!r) return;
  if (inWatch(r.meta.symbol)) state.watchlist = state.watchlist.filter((w) => w.symbol !== r.meta.symbol);
  else state.watchlist.push({ symbol: r.meta.symbol, name: r.meta.name, lastAction: r.signal.action });
  store.set('watchlist', state.watchlist); setStar(); renderWatch();
}
function updateWatchAction(sym, action) {
  const w = state.watchlist.find((x) => x.symbol === sym); if (!w) return;
  if (w.lastAction !== action) { w.prevAction = w.lastAction; w.lastAction = action; w.flippedAt = Date.now(); store.set('watchlist', state.watchlist); }
}
let watchRows = [];
function renderWatch() {
  $('#watchEmpty').hidden = state.watchlist.length > 0;
  $('#watchTable').innerHTML = state.watchlist.length ? rowsTable(state.watchlist.map((w) => watchRows.find((r) => r.symbol === w.symbol) || { symbol: w.symbol, name: w.name, pending: true }), true) : '';
  bindTable($('#watchTable'), true);
}
async function refreshWatch() {
  if (!state.watchlist.length) return renderWatch();
  watchRows = await scanSymbols(state.watchlist.map((w) => ({ symbol: w.symbol, name: w.name })), () => {});
  watchRows.forEach((r) => {
    const w = state.watchlist.find((x) => x.symbol === r.symbol);
    if (w && r.action && w.lastAction !== r.action) { w.prevAction = w.lastAction; w.lastAction = r.action; w.flippedAt = Date.now(); }
    if (w?.flippedAt && Date.now() - w.flippedAt < 3 * 86400e3) r.flip = `${w.prevAction}→${w.lastAction}`;
  });
  store.set('watchlist', state.watchlist);
  renderWatch();
}

// ---------- Scanner ----------
async function scanSymbols(list, onProgress) {
  const out = []; let done = 0;
  const benches = {};
  const getBench = async (ac) => { const b = benchFor(ac); if (!(b in benches)) benches[b] = getChart(b, state.interval).then((d) => d.candles).catch(() => null); return benches[b]; };
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const d = await getChart(item.symbol, state.interval);
        const candles = dedupe(d.candles);
        const meta = { ...d.meta, interval: state.interval };
        const S = computeSeries(candles);
        const i = S.c.length - 1;
        const sc = scoreAt(S, i), lab = labelFor(sc.score);
        const risk = riskReport(candles, S, meta, meta.symbol === benchFor(meta.assetClass) ? null : await getBench(meta.assetClass));
        const plan = tradePlan(S, lab, risk, { account: state.account, riskPct: state.riskPct });
        out.push({ symbol: meta.symbol, name: item.name || meta.name, assetClass: meta.assetClass, metaName: meta.name, price: S.c[i], chg: (S.c[i] - S.c[i - 1]) / S.c[i - 1], score: sc.score, ...lab, risk: risk.score, riskLevel: risk.level, vol: risk.annVol, stopPct: plan.stopPct, rsi: S.rsi[i] });
      } catch (e) { out.push({ symbol: item.symbol, name: item.name, error: e.message }); }
      onProgress(++done / list.length);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  $('#demoBanner').hidden = !isDemo();
  return out;
}
async function runScan() {
  const list = state.scanSet === 'watchlist' ? state.watchlist : state.scanSet === 'all' ? [...UNIVERSE.stocks, ...UNIVERSE.etfs, ...UNIVERSE.crypto] : UNIVERSE[state.scanSet];
  if (!list.length) { $('#scanTable').innerHTML = '<tbody><tr><td>Your watchlist is empty.</td></tr></tbody>'; return; }
  const btn = $('#scanBtn'), prog = $('#scanProgress');
  btn.disabled = true; btn.textContent = 'Scanning…'; prog.hidden = false; prog.firstElementChild.style.width = '0';
  state.scanRows = await scanSymbols(list, (f) => { prog.firstElementChild.style.width = `${f * 100}%`; });
  btn.disabled = false; btn.textContent = 'Run scan'; setTimeout(() => { prog.hidden = true; }, 400);
  renderScan();
}
function renderScan() {
  renderMarkets();
  let rows = state.scanRows;
  if ($('#onlyBuys').checked) rows = rows.filter((r) => r.action === 'BUY');
  if ($('#lowRisk').checked) rows = rows.filter((r) => r.risk != null && r.risk <= 6);
  const { key, dir } = state.sort;
  rows = [...rows].sort((a, b) => (a.error ? 1 : b.error ? -1 : ((a[key] ?? 0) > (b[key] ?? 0) ? 1 : -1) * dir));
  $('#scanTable').innerHTML = state.scanRows.length ? rowsTable(rows, false) : '';
  bindTable($('#scanTable'), false);
}
function rowsTable(rows, removable) {
  const cols = [['symbol', 'Asset'], ['price', 'Price'], ['chg', 'Chg'], ['score', 'Signal'], ['risk', 'Risk'], ['vol', 'Vol (ann.)'], ['stopPct', 'Stop dist.'], ['rsi', 'RSI']];
  const head = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${state.sort.key === k ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}${removable ? '<th></th>' : ''}</tr></thead>`;
  const body = rows.map((r) => {
    if (r.pending) return `<tr data-s="${esc(r.symbol)}"><td>${esc(r.symbol)}<span class="nm">${esc(r.name || '')}</span></td><td colspan="7" style="text-align:left;color:var(--dim)">loading…</td>${removable ? `<td><button class="rm" data-rm="${esc(r.symbol)}" aria-label="Remove">✕</button></td>` : ''}</tr>`;
    if (r.error) return `<tr data-s="${esc(r.symbol)}"><td>${esc(r.symbol)}</td><td colspan="7" style="text-align:left;color:var(--down)">${esc(r.error).slice(0, 80)}</td>${removable ? `<td><button class="rm" data-rm="${esc(r.symbol)}">✕</button></td>` : ''}</tr>`;
    const rc = r.risk <= 3 ? 'var(--up)' : r.risk <= 5 ? 'var(--buy)' : r.risk <= 7 ? 'var(--warn)' : 'var(--down)';
    return `<tr data-s="${esc(r.symbol)}"><td>${esc(r.symbol)} ${badge(r.symbol, r.assetClass, r.metaName || r.name, true)}<span class="nm">${esc(r.name || '')}</span></td>
      <td>${fmtPx(r.price)}</td><td class="${r.chg >= 0 ? 'up' : 'down'}">${pctS(r.chg)}</td>
      <td><span class="sig tone-${r.tone}">${r.label}</span> ${r.score >= 0 ? '+' : ''}${r.score.toFixed(0)}${r.flip ? ` <span class="flip">${esc(r.flip)}</span>` : ''}</td>
      <td style="color:${rc}">${r.risk.toFixed(1)}</td><td>${pct(r.vol)}</td><td>${pctS(r.stopPct)}</td><td>${r.rsi != null ? r.rsi.toFixed(0) : '—'}</td>
      ${removable ? `<td><button class="rm" data-rm="${esc(r.symbol)}" aria-label="Remove">✕</button></td>` : ''}</tr>`;
  }).join('');
  return head + `<tbody>${body}</tbody>`;
}
function bindTable(tbl, removable) {
  tbl.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { state.watchlist = state.watchlist.filter((w) => w.symbol !== rm.dataset.rm); watchRows = watchRows.filter((w) => w.symbol !== rm.dataset.rm); store.set('watchlist', state.watchlist); renderWatch(); return; }
    const th = e.target.closest('th[data-k]');
    if (th) { const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; removable ? renderWatch() : renderScan(); return; }
    const tr = e.target.closest('tr[data-s]'); if (tr) load(tr.dataset.s);
  };
}

// ---------- Portfolio (read-only brokerage) ----------
function initPortfolio() {
  $('#unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#accessCode').value.trim(); if (!code) return;
    access.set(code, $('#rememberCode').checked);
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* */ }
    $('#accessCode').value = '';
    await loadPortfolio();
  });
  $('#sampleBtn').addEventListener('click', () => loadPortfolio(true));
  $('#pfRefresh').addEventListener('click', () => loadPortfolio(state.portfolio?.sample));
  $('#pfLock').addEventListener('click', () => { access.clear(); state.portfolio = null; stopLiveFeed(); lockPortfolio(); if (state.result) renderMyPosition(state.result); });
  $('#allBrokers').addEventListener('click', () => connectBroker(''));
  $('#brokerBtns').addEventListener('click', (e) => { const b = e.target.closest('[data-slug]'); if (b) connectBroker(b.dataset.slug); });
  $('#pfSync').addEventListener('click', async () => {
    try { const r = await liveApi.refresh(); pfMessage(`Asked ${r.results.length} brokerage connection(s) for fresh data. Holdings update in a minute or two — press Refresh.${r.results.some((x) => !x.ok) ? ' Some failed: ' + r.results.filter((x) => !x.ok).map((x) => x.broker).join(', ') : ''}`); }
    catch (e) { pfMessage(e.message, true); }
  });
  $('#liveFilter').addEventListener('click', (e) => { const f = e.target.closest('[data-f]')?.dataset.f; if (!f) return; liveF = f; $$('#liveFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f)); renderFeed(); });
  $('#liveFeed').addEventListener('click', (e) => { const li = e.target.closest('li[data-s]'); if (li?.dataset.s) load(li.dataset.s); });
}
async function connectBroker(slug) {
  const w = window.open('about:blank', '_blank'); // open synchronously so popup blockers allow it
  try {
    const { url } = await liveApi.connect(slug);
    if (!/^https:\/\//.test(url)) throw new Error('Unexpected link from server');
    if (w) { w.opener = null; w.location.href = url; } else location.href = url;
    pfMessage('Finish signing in to your broker in the new tab (SnapTrade\'s secure page), then press Refresh. A new connection can take a few minutes to sync.');
  } catch (e) { w?.close(); pfMessage(e.message, true); }
}
function lockPortfolio(err) {
  $('#pfLocked').hidden = false; $('#pfOpen').hidden = true;
  $('#unlockErr').hidden = !err; $('#unlockErr').textContent = err || '';
}
function pfMessage(msg, isErr) { const el = $('#pfErr'); el.hidden = !msg; el.textContent = msg || ''; el.style.cssText = isErr ? '' : 'background:#0f2219;border-color:#1b4632;color:#a6f0cb'; }

async function loadPortfolio(sample = false) {
  $('#pfLocked').hidden = true; $('#pfOpen').hidden = false; pfMessage('');
  $('#pfTiles').innerHTML = ''; $('#pfTable').innerHTML = ''; $('#acctTable').innerHTML = ''; $('#pfAlertsCard').hidden = true; $('#pfEmpty').hidden = true;
  const prog = $('#pfProgress'); prog.hidden = false; prog.firstElementChild.style.width = '8%';
  let data;
  try {
    data = sample ? samplePortfolio() : await broker.portfolio();
  } catch (e) {
    prog.hidden = true;
    if (e.status === 401 || e.status === 429) { access.clear(); stopLiveFeed(); return lockPortfolio(e.message); }
    return lockPortfolio(e.message);
  }
  data.sample = sample;
  state.portfolio = data;
  renderProviders(data);
  if (sample) startSampleFeed(); else if (!liveOn()) startLiveFeed();
  if (!data.positions.length) {
    prog.hidden = true;
    const configured = data.providers.some((p) => p.configured);
    $('#pfEmpty').hidden = false;
    $('#pfEmpty').innerHTML = configured
      ? 'Connected, but no positions were returned yet. If you just linked a brokerage, give it a few minutes to sync and press Refresh.'
      : 'No brokerage is configured on the server yet. Add SnapTrade or Alpaca keys as environment variables (see README → "Connect your brokerage"), redeploy, then press Refresh.';
    renderAccounts(data); return;
  }
  await enrichPositions(data.positions, (f) => { prog.firstElementChild.style.width = `${8 + f * 92}%`; });
  setTimeout(() => { prog.hidden = true; }, 300);
  renderPortfolio();
  if (state.result) renderMyPosition(state.result);
}

function renderProviders(d) {
  $('#pfDemo').hidden = !(d.demo || d.sample);
  const errs = new Map((d.errors || []).map((e) => [e.provider, e.error]));
  $('#providers').innerHTML = d.providers.filter((p) => p.configured || p.id !== 'demo').map((p) =>
    `<span class="prov ${errs.has(p.id) ? 'err' : p.configured ? 'on' : ''}" title="${esc(errs.get(p.id) || '')}">${esc(p.name)} · ${errs.has(p.id) ? 'error' : p.configured ? 'connected' : 'not set up'}</span>`).join('');
  renderConnect(d);
  if (errs.size) pfMessage([...errs].map(([k, v]) => `${k}: ${v}`).join(' · '), true);
}

async function enrichPositions(positions, onProgress) {
  const syms = [...new Set(positions.map((p) => p.chartSymbol).filter(Boolean))];
  const info = new Map(); let done = 0;
  const benches = {};
  const getBench = (ac) => { const b = benchFor(ac); return (benches[b] ||= getChart(b, '1d').then((d) => d.candles).catch(() => null)); };
  const queue = [...syms];
  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const d = await getChart(sym, '1d');
        const candles = dedupe(d.candles), meta = { ...d.meta, interval: '1d' };
        const S = computeSeries(candles), i = S.c.length - 1;
        const sc = scoreAt(S, i), lab = labelFor(sc.score);
        const risk = riskReport(candles, S, meta, meta.symbol === benchFor(meta.assetClass) ? null : await getBench(meta.assetClass));
        info.set(sym, { last: S.c[i], prev: S.c[i - 1], atr: S.atr[i], score: sc.score, ...lab, risk: risk.score, riskLevel: risk.level, demo: !!d.demo });
      } catch (e) { info.set(sym, { error: e.message }); }
      onProgress(++done / Math.max(1, syms.length));
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  for (const p of positions) {
    const x = info.get(p.chartSymbol) || { error: 'Not chartable (option, fund or cash)' };
    p.sig = x.error ? null : x; p.sigError = x.error || null;
    if (p.price == null && x.last != null) { p.price = x.last; p.priceFromChart = true; }
    if (p.value == null && p.price != null) p.value = p.qty * p.price;
    if (p.pnl == null && p.value != null && p.cost != null) { p.pnl = p.value - p.cost; p.pnlPct = p.cost ? p.pnl / Math.abs(p.cost) : null; }
    p.dayChg = x.prev ? (x.last - x.prev) / x.prev : null;
    p.trail = x.atr && p.price != null ? p.price - 3 * x.atr : null;
  }
  $('#demoBanner').hidden = !isDemo();
}

export function adviceFor(p, sig, weight = 0) {
  if (!sig) return { text: 'No chart data', cls: 'neutral' };
  if (p.qty < 0) return { text: 'Short position — risk is open-ended; keep a buy-stop', cls: 'warn' };
  let a;
  if (sig.action === 'SELL') a = (p.pnl ?? 0) >= 0 ? { text: 'Sell signal — consider taking profit or tightening the stop', cls: 'warn' } : { text: 'Sell signal while at a loss — review your exit', cls: 'bad' };
  else if (p.pnlPct != null && p.pnlPct < -0.2) a = { text: `Down ${(-p.pnlPct * 100).toFixed(0)}% from cost — re-check the thesis`, cls: 'bad' };
  else if (sig.action === 'BUY') a = { text: 'Trend intact — hold and trail your stop', cls: 'good' };
  else a = { text: 'No clear signal — hold and monitor', cls: 'neutral' };
  if (weight > 0.25) a = { ...a, text: a.text + ' · position is concentrated', cls: a.cls === 'good' || a.cls === 'neutral' ? 'warn' : a.cls };
  return a;
}

function renderPortfolio() {
  const d = state.portfolio; if (!d) return;
  const P = d.positions;
  const invested = P.reduce((s, p) => s + Math.max(0, p.value || 0), 0);
  const cash = d.accounts.reduce((s, a) => s + (a.cash || 0), 0);
  const total = invested + cash;
  P.forEach((p) => { p.weight = invested ? (p.value || 0) / invested : 0; p.advice = adviceFor(p, p.sig, p.weight); });
  const pnl = P.reduce((s, p) => s + (p.pnl || 0), 0), cost = P.reduce((s, p) => s + (p.cost && p.pnl != null ? Math.abs(p.cost) : 0), 0);
  const rated = P.filter((p) => p.sig && p.value > 0);
  const wRisk = rated.length ? rated.reduce((s, p) => s + p.sig.risk * p.value, 0) / rated.reduce((s, p) => s + p.value, 0) : null;
  const biggest = [...P].sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
  const cryptoPct = invested ? P.filter((p) => p.assetClass === 'crypto').reduce((s, p) => s + (p.value || 0), 0) / invested : 0;
  const money = (x) => (x == null ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 }));
  const rc = (r) => (r <= 3 ? 'var(--up)' : r <= 5 ? 'var(--buy)' : r <= 7 ? 'var(--warn)' : 'var(--down)');
  const tiles = [
    ['Total value', money(total), `${money(cash)} cash`],
    ['Unrealised P/L', `<span class="${pnl >= 0 ? 'up' : 'down'}">${money(pnl)}</span>`, cost ? pctS(pnl / cost) + ' on cost' : ''],
    ['Positions', String(P.length), `${d.accounts.length} account${d.accounts.length === 1 ? '' : 's'}`],
    ['Portfolio risk', wRisk == null ? '—' : `<span style="color:${rc(wRisk)}">${wRisk.toFixed(1)}</span>/10`, 'value-weighted'],
    ['Largest position', biggest ? pct(biggest.weight) : '—', biggest ? esc(biggest.symbol) : ''],
    ['Crypto share', pct(cryptoPct), 'of invested'],
  ];
  $('#pfTiles').innerHTML = tiles.map(([k, v, sub]) => `<div class="tile"><span>${k}</span><b>${v}</b><br><small>${sub}</small></div>`).join('');

  // Alerts
  const al = [];
  for (const p of P) {
    if (!p.sig) continue;
    if (p.sig.action === 'SELL') al.push({ sev: (p.pnl ?? 0) < 0 ? 'high' : 'med', text: `${p.symbol}: ${p.sig.label} signal (score ${p.sig.score.toFixed(0)}). ${p.advice.text}.` });
    if (p.pnlPct != null && p.pnlPct < -0.25) al.push({ sev: 'high', text: `${p.symbol} is down ${(-p.pnlPct * 100).toFixed(0)}% from your average cost (${money(p.pnl)}).` });
    if (p.sig.risk >= 8.5) al.push({ sev: 'med', text: `${p.symbol} is rated ${p.sig.riskLevel.toLowerCase()} risk (${p.sig.risk}/10). Make sure the size matches that.` });
  }
  if (biggest && biggest.weight > 0.25) al.push({ sev: 'med', text: `${biggest.symbol} is ${pct(biggest.weight)} of your invested money. A 30% drop in it would cut the portfolio by about ${pct(biggest.weight * 0.3)}.` });
  if (cryptoPct > 0.3) al.push({ sev: 'med', text: `Crypto is ${pct(cryptoPct)} of invested money — drawdowns of 50%+ have happened repeatedly in crypto.` });
  if (wRisk != null && wRisk > 7) al.push({ sev: 'high', text: `Overall portfolio risk is high (${wRisk.toFixed(1)}/10). Consider trimming the riskiest positions or adding cash.` });
  if (P.some((p) => p.sigError)) al.push({ sev: 'info', text: `${P.filter((p) => p.sigError).length} holding(s) couldn't be scored (options, mutual funds or symbols without chart data).` });
  al.push({ sev: 'info', text: 'Stop orders at your broker aren’t visible here. Check each position has one at or near the trailing-stop level.' });
  $('#pfAlertsCard').hidden = false;
  $('#pfAlerts').innerHTML = al.map((w) => `<li class="${w.sev}">${esc(w.text)}</li>`).join('');

  // Positions table
  const { key, dir } = state.pfSort;
  const val = (p) => (key === 'signal' ? p.sig?.score : key === 'risk' ? p.sig?.risk : p[key]);
  const grp = (p) => { const c = classify(p.chartSymbol || p.symbol, p.assetClass, p.name).cls; return c === 'crypto' ? 2 : c === 'etf' ? 1 : 0; };
  const rows = [...P].sort((a, b) => grp(a) - grp(b) || ((val(a) ?? -Infinity) > (val(b) ?? -Infinity) ? 1 : -1) * dir);
  renderAllocation(P, invested, money);
  let lastG = -1;
  const groupRow = (p) => { const g = grp(p); if (g === lastG) return ''; lastG = g; const lbl = ['Stocks', 'ETFs', 'Crypto'][g]; const ps = P.filter((x) => grp(x) === g); const v = ps.reduce((a, x) => a + (x.value || 0), 0), pl = ps.reduce((a, x) => a + (x.pnl || 0), 0); return `<tr class="group"><td colspan="11">${lbl} · ${ps.length} position${ps.length === 1 ? '' : 's'} · ${money(v)} · P/L <span class="${pl >= 0 ? 'up' : 'down'}">${money(pl)}</span></td></tr>`; };
  const cols = [['symbol', 'Asset'], ['qty', 'Qty'], ['avgCost', 'Avg cost'], ['price', 'Price'], ['value', 'Value'], ['pnl', 'P/L'], ['weight', 'Weight'], ['signal', 'Signal'], ['risk', 'Risk'], ['trail', 'Trail stop'], ['advice', 'Suggested action']];
  const th = cols.map(([k, l]) => `<th data-k="${k}">${l}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const qtyFmt = (q, ac) => (ac === 'crypto' || Math.abs(q % 1) > 1e-9 ? (+q).toLocaleString('en-US', { maximumFractionDigits: 6 }) : (+q).toLocaleString());
  $('#pfTable').innerHTML = `<thead><tr>${th}</tr></thead><tbody>` + rows.map((p) => `${groupRow(p)}<tr data-s="${esc(p.chartSymbol || '')}">
    <td>${esc(p.symbol)} ${badge(p.chartSymbol || p.symbol, p.assetClass, p.name, true)}<span class="nm">${esc(p.broker)} · ${esc(p.account)}</span></td>
    <td>${qtyFmt(p.qty, p.assetClass)}</td><td>${fmtPx(p.avgCost)}</td>
    <td>${fmtPx(p.price)}${p.dayChg != null ? `<span class="nm ${p.dayChg >= 0 ? 'up' : 'down'}">${pctS(p.dayChg)}</span>` : ''}</td>
    <td>${money(p.value)}</td>
    <td class="${(p.pnl ?? 0) >= 0 ? 'up' : 'down'}">${money(p.pnl)}<span class="nm">${pctS(p.pnlPct)}</span></td>
    <td>${pct(p.weight)}</td>
    <td>${p.sig ? `<span class="sig tone-${p.sig.tone}">${p.sig.label}</span>` : '<span class="nm">—</span>'}</td>
    <td style="color:${p.sig ? rc(p.sig.risk) : 'inherit'}">${p.sig ? p.sig.risk.toFixed(1) : '—'}</td>
    <td>${fmtPx(p.trail)}</td>
    <td style="text-align:left"><span class="act ${p.advice.cls}">${esc(p.advice.text)}</span></td></tr>`).join('') + '</tbody>';
  $('#pfTable').onclick = (e) => {
    const h = e.target.closest('th[data-k]');
    if (h) { const k = h.dataset.k; if (k === 'advice') return; state.pfSort = { key: k, dir: state.pfSort.key === k ? -state.pfSort.dir : -1 }; return renderPortfolio(); }
    const tr = e.target.closest('tr[data-s]'); if (tr?.dataset.s) load(tr.dataset.s);
  };
  $('#pfAsOf').textContent = `updated ${new Date(d.asOf).toLocaleTimeString([], { timeStyle: 'short' })}`;
  renderAccounts(d);
}

function renderAccounts(d) {
  const money = (x) => (x == null ? '—' : '$' + x.toLocaleString('en-US', { maximumFractionDigits: 0 }));
  $('#acctTable').innerHTML = `<thead><tr><th>Broker</th><th>Account</th><th>Number</th><th>Total</th><th>Cash</th><th>Status</th></tr></thead><tbody>` +
    (d.accounts.map((a) => `<tr><td>${esc(a.broker)}</td><td>${esc(a.name)}</td><td>${esc(a.number)}</td><td>${money(a.total)}</td><td>${money(a.cash)}</td><td style="text-align:left;font-family:var(--sans);color:${a.error ? 'var(--down)' : 'var(--muted)'}">${a.error ? esc(a.error) : a.synced ? 'synced ' + esc(new Date(a.synced).toLocaleDateString()) : 'ok'}</td></tr>`).join('') || '<tr><td colspan="6">No accounts</td></tr>') + '</tbody>';
}

function renderMyPosition(res) {
  const card = $('#myPos');
  const held = (state.portfolio?.positions || []).filter((p) => p.chartSymbol === res.meta.symbol);
  if (!held.length) { card.hidden = true; return; }
  const qty = held.reduce((s, p) => s + p.qty, 0);
  const cost = held.reduce((s, p) => s + (p.cost || 0), 0);
  const avg = qty ? cost / qty : null;
  const value = qty * res.price, pnl = cost ? value - cost : null;
  const atr = res.S.atr.at(-1) || 0, trail = res.price - 3 * atr;
  const atRisk = qty > 0 ? (res.price - trail) * qty : null;
  const money = (x) => (x == null ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  card.hidden = false;
  $('#myPosSrc').textContent = [...new Set(held.map((p) => p.broker))].join(', ') + (state.portfolio.sample || state.portfolio.demo ? ' · sample' : '');
  $('#myPosGrid').innerHTML = [
    ['Quantity', (+qty).toLocaleString('en-US', { maximumFractionDigits: 6 })], ['Avg cost', fmtPx(avg)], ['Value', money(value)],
    ['P/L', `<span class="${(pnl ?? 0) >= 0 ? 'up' : 'down'}">${money(pnl)} ${cost ? pctS(pnl / cost) : ''}</span>`], ['If trail stop hits', atRisk == null ? '—' : `<span class="down">−${money(atRisk)}</span>`],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  const adv = adviceFor({ qty, pnl, pnlPct: cost ? pnl / cost : null }, res.signal);
  $('#myPosAdvice').innerHTML = `<span class="act ${adv.cls}">${esc(adv.text)}.</span> A trailing stop at <b class="mono">${fmtPx(trail)}</b> (3×ATR below price) would lock in ${pnl != null && avg != null && trail > avg ? 'part of your gain' : 'a defined maximum loss'}.`;
}

// ---------- Live trades (read-only) ----------
let es = null, pollTimer = null, liveF = 'all', liveMode = 'off', reloadTimer = null, sampleTimer = null;
const feed = new Map(); // provider:account:id -> latest event
const liveOn = () => !!(es || pollTimer);
function stopLiveFeed() { es?.close(); es = null; clearInterval(pollTimer); pollTimer = null; clearInterval(sampleTimer); sampleTimer = null; feed.clear(); setDot('off', 'off'); renderFeed(); }
function setDot(cls, label) { liveMode = cls; const d = $('#liveDot'); d.className = `livedot ${cls}`; d.textContent = label; }

async function startLiveFeed() {
  es?.close(); es = null; clearInterval(pollTimer); pollTimer = null;
  setDot('', 'connecting…');
  try {
    const t = await liveApi.ticket();
    if (t.streaming === false) throw new Error('streaming off');
    openStream(t.ticket);
  } catch (e) { if (e.status === 401) return; startPolling(); }
}
function openStream(ticket) {
  const src = new EventSource(`/api/live/stream?ticket=${encodeURIComponent(ticket)}`);
  es = src;
  let hello = false;
  const fallback = setTimeout(() => { if (!hello && es === src) { src.close(); es = null; startPolling(); } }, 8000); // serverless hosts can't stream
  src.addEventListener('hello', (e) => {
    hello = true; clearTimeout(fallback);
    const d = JSON.parse(e.data);
    setDot('on', 'Live'); renderSources(d.status);
    d.events.slice().reverse().forEach((ev) => addEvent(ev, false));
  });
  src.addEventListener('order', (e) => addEvent(JSON.parse(e.data), true));
  src.addEventListener('status', (e) => renderSources(JSON.parse(e.data)));
  src.addEventListener('check', (e) => { const c = JSON.parse(e.data); for (const ev of feed.values()) if (ev.id === c.id && ev.provider === c.provider) ev.check = c.check; renderFeed(); });
  src.addEventListener('account', (e) => { const a = JSON.parse(e.data); if (a.type === 'ACCOUNT_HOLDINGS_UPDATED') scheduleReload(); if (a.type === 'CONNECTION_BROKEN') pfMessage('A brokerage connection broke — reconnect it under "Connect a brokerage".', true); });
  src.onerror = () => {
    if (es !== src) return;
    if (src.readyState === 2) { es = null; setDot('off', 'reconnecting…'); setTimeout(() => { if (access.get() && !es && !pollTimer) startLiveFeed(); }, 5000); }
    else setDot('poll', 'reconnecting…');
  };
}
function startPolling() {
  setDot('poll', 'Polling · 30s');
  let first = true;
  const tick = async () => {
    try {
      const r = await liveApi.orders();
      r.orders.slice().reverse().forEach((o) => addEvent({ ...o, via: first ? 'snapshot' : 'poll', snapshot: first }, !first));
      renderSources({ sources: Object.fromEntries((r.providers || []).filter((p) => p.configured && p.id !== 'demo').map((p) => [p.id, { mode: 'poll', state: r.errors.some((x) => x.provider === p.id) ? 'error' : 'live', detail: r.errors.find((x) => x.provider === p.id)?.error || 'on-demand polling' }])) });
      first = false;
    } catch (e) { if (e.status === 401) { stopLiveFeed(); return; } setDot('off', 'offline'); }
  };
  tick(); pollTimer = setInterval(tick, 30_000);
}
function addEvent(ev, isNew) {
  const key = `${ev.provider}:${ev.accountId || ''}:${ev.id}`;
  const prev = feed.get(key);
  const t = (x) => Date.parse(x?.updatedAt || x?.executedAt || x?.placedAt || 0) || x?.receivedAt || 0;
  if (prev && t(prev) > t(ev) && prev.status === 'filled') return;
  if (prev?.check && !ev.check) ev.check = prev.check;
  const fresh = isNew && !ev.snapshot; // capture before renderFeed() clears the highlight flag
  ev._new = fresh;
  feed.set(key, ev);
  if (feed.size > 400) feed.delete(feed.keys().next().value);
  renderFeed();
  if (fresh && (ev.status === 'filled' || ev.status === 'partial') && !(prev && prev.status === ev.status && prev.filledQty === ev.filledQty)) { toast(ev); scheduleReload(); }
}
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (state.portfolio && !state.portfolio.sample) loadPortfolio(false); }, 20_000); }

function renderSources(st) {
  const names = { alpaca: 'Alpaca', coinbase: 'Coinbase', snaptrade: 'SnapTrade brokers', robinhood: 'Robinhood Crypto', demo: 'Sample feed' };
  const S = st?.sources || {};
  $('#liveSources').innerHTML = Object.entries(S).map(([id, s]) => {
    const cls = s.state === 'live' ? 'on' : s.state === 'error' ? 'err' : 'warn';
    const mode = s.mode === 'stream' ? 'instant' : s.mode === 'webhook+poll' ? 'webhook + poll' : 'poll';
    return `<span class="prov ${cls}" title="${esc(s.detail || '')}">${esc(names[id] || id)} · ${esc(mode)} · ${esc(s.state || '…')}</span>`;
  }).join('') || '<span class="prov">No live sources — connect a broker</span>';
}
function renderFeed() {
  const el = $('#liveFeed'); if (!el) return;
  const t = (x) => Date.parse(x.executedAt || x.updatedAt || x.placedAt || 0) || x.receivedAt || 0;
  let rows = [...feed.values()].sort((a, b) => t(b) - t(a));
  if (liveF === 'filled') rows = rows.filter((r) => r.status === 'filled' || r.status === 'partial');
  if (liveF === 'open') rows = rows.filter((r) => ['open', 'partial', 'canceling'].includes(r.status));
  if (!rows.length) { el.innerHTML = `<li class="empty-feed">${liveF === 'open' ? 'No open orders.' : liveMode === 'off' ? 'Live feed is off.' : 'Waiting for trades… (fills from the last 24 h appear here)'}</li>`; return; }
  const when = (x) => { const d = new Date(t(x)); return isNaN(d) || !t(x) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  el.innerHTML = rows.slice(0, 120).map((r) => {
    const q = r.status === 'filled' || r.status === 'partial' ? (r.filledQty ?? r.qty) : r.qty;
    const qty = q == null ? '' : (+q).toLocaleString('en-US', { maximumFractionDigits: 6 });
    return `<li class="${esc(r.side)}${r._new ? ' new-item' : ''}" data-s="${esc(r.chartSymbol || '')}">
      <span class="side ${esc(r.side)}">${esc(r.side)}</span>
      <div class="main"><b>${esc(qty)} ${esc(r.symbol)}</b> ${r.cls === 'option' ? '<span class="cls c-etf">OPTION</span>' : badge(r.chartSymbol || r.symbol, r.assetClass, '', true)}${r.price ? ` @ <b>${fmtPx(r.price)}</b>` : ''} <span class="meta">${esc(String(r.type || '').toLowerCase())}</span>
        <div class="meta">${esc(r.broker)}${r.account ? ' · ' + esc(r.account) : ''} · ${esc(when(r))} · ${esc(r.via || '')}${r.detectionLagSec != null ? ` · ${Math.round(r.detectionLagSec)}s lag` : ''}</div></div>
      <span class="st ${esc(r.status)}">${esc(r.status)}</span>
      ${r.check ? `<div class="chk${r.check.against ? ' against' : ''}">${esc(r.check.text)}</div>` : ''}</li>`;
  }).join('');
  rows.forEach((r) => (r._new = false));
}
function toast(ev) {
  const box = $('#toasts'); const d = document.createElement('div');
  d.className = `toast ${ev.side}`;
  const qty = ev.filledQty ?? ev.qty;
  d.innerHTML = `🧾 <b>${esc(ev.side)} ${esc(qty ?? '')} ${esc(ev.symbol)}</b>${ev.price ? ` @ <b>${fmtPx(ev.price)}</b>` : ''} — ${ev.status === 'partial' ? 'partially filled' : 'filled'}<small>${esc(ev.broker)} · tap for TradeGuide's analysis</small>`;
  d.onclick = () => { if (ev.chartSymbol) load(ev.chartSymbol); d.remove(); };
  box.prepend(d); setTimeout(() => d.remove(), 9000);
  while (box.children.length > 4) box.lastChild.remove();
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`${ev.side} ${qty ?? ''} ${ev.symbol} filled`, { body: `${ev.broker}${ev.price ? ' @ ' + fmtPx(ev.price) : ''}`, icon: 'icons/icon-192.png' }); } catch { /* */ }
}
function startSampleFeed() {
  stopLiveFeed(); setDot('on', 'Sample');
  renderSources({ sources: { demo: { mode: 'stream', state: 'live', detail: 'sample data' } } });
  const P = state.portfolio?.positions || [];
  const mk = (p, k, status, snap) => ({ provider: 'demo', broker: 'Sample Broker', account: 'Individual', id: `s${k}`, symbol: p.symbol, chartSymbol: p.chartSymbol, assetClass: p.assetClass, side: k % 3 ? 'BUY' : 'SELL', type: 'market', status, qty: p.assetClass === 'crypto' ? 0.05 : 5, filledQty: status === 'filled' ? (p.assetClass === 'crypto' ? 0.05 : 5) : 0, price: status === 'filled' ? p.price : null, updatedAt: new Date(Date.now() - (snap ? (6 - k) * 3600e3 : 0)).toISOString(), via: snap ? 'snapshot' : 'stream', snapshot: snap });
  P.slice(0, 4).forEach((p, k) => addEvent(mk(p, k, k === 3 ? 'open' : 'filled', true), false));
  let k = 10;
  sampleTimer = setInterval(() => { const p = P[k % P.length]; if (p) addEvent(mk(p, k++, 'filled', false), true); }, 20_000);
}

// ---------- Connect a brokerage ----------
const POPULAR = /^(robinhood|webull|schwab|charles schwab|fidelity|e\*?trade|etrade|interactive brokers|ibkr|vanguard|public|tastytrade|tastyworks|coinbase|kraken|merrill|sofi|firstrade|moomoo|alpaca|wealthsimple|questrade|td direct)/i;
let brokerList = null;
async function renderConnect(d) {
  const on = d.providers.some((p) => p.id === 'snaptrade' && p.configured);
  $('#connectCard').hidden = !on || d.sample;
  if (!on || d.sample) return;
  try {
    brokerList ||= (await liveApi.brokerages()).brokerages;
    const pop = brokerList.filter((b) => POPULAR.test(b.name)).slice(0, 16);
    $('#brokerBtns').innerHTML = pop.map((b) => `<button data-slug="${esc(b.slug)}">${esc(b.name)}<small>${b.maintenance ? '🔧 maintenance' : b.degraded ? '⚠️ degraded' : b.realtime ? '⚡ real-time data' : 'daily sync'}</small></button>`).join('') || '<span class="note">Use "All brokerages…" to pick yours.</span>';
  } catch (e) { $('#brokerBtns').innerHTML = `<span class="note">Couldn't load the brokerage list (${esc(e.message)}). "All brokerages…" still works.</span>`; }
}

// ---------- Stock vs crypto profile ----------
function renderProfile(res, C, ms) {
  const P = C.profile, r = res.risk, other = PROFILES[C.cls === 'crypto' ? 'stock' : 'crypto'];
  $('#profCls').outerHTML = `<span id="profCls">${badge(res.meta.symbol, res.meta.assetClass, res.meta.name)}</span>`;
  $('#profWhat').innerHTML = `<b>${esc(P.label)}:</b> ${esc(P.what)}${C.cryptoLinked ? ` <b>Crypto-linked:</b> ${esc(res.meta.symbol)} is a ${esc(C.linkedNote)} — stock-market hours and rules, crypto-style swings.` : ''}${C.leveraged ? ' <b>Leveraged/inverse fund</b> — decays over time.' : ''}`;
  const cv = r.classVol || classVolatility(C.cls, r.annVol);
  const [a, b, c] = cv.bands, max = cv.scaleMax, w = (x) => `${(x / max) * 100}%`;
  $('#profVol').innerHTML = `<div class="vg-label">Volatility <b>${(r.annVol * 100).toFixed(0)}%</b>/yr — <b>${esc(cv.text)}</b> (typical ${esc(P.typicalVol)})</div>
    <div class="vg-wrap"><div class="vg-track"><i style="width:${w(a)};background:#1f5a3f"></i><i style="width:${w(b - a)};background:#2f6b4f"></i><i style="width:${w(c - b)};background:#7a5a12"></i><i style="flex:1;background:#6b2226"></i></div><span class="vg-mark" style="left:${Math.min(99, (r.annVol / max) * 100)}%"></span></div>
    <div class="vg-legend"><span>calm</span><span>typical</span><span>volatile</span><span>extreme</span></div>`;
  const corr = r.beta?.corr;
  const rows = [
    ['Market right now', `<span class="mkt ${ms.phase}">${esc(ms.label)}</span><br><small style="color:var(--muted)">${esc(ms.detail)}</small>`, other.trades247 ? 'Open 24/7' : marketStatus('stock').label],
    ['Trading hours', P.hours, other.hours],
    ['Normal volatility', P.typicalVol, other.typicalVol],
    [`Moves with ${P.benchName}`, corr == null ? (res.meta.symbol === P.benchmark ? 'It is the benchmark' : '—') : `correlation ${corr.toFixed(2)}${r.beta?.beta != null ? `, beta ${r.beta.beta.toFixed(2)}` : ''}`, `benchmark: ${other.benchName}`],
    ['Settlement', P.settlement, other.settlement],
    ['Protection', P.protection, other.protection],
    ['Suggested risk per trade', `${P.suggestRiskPct}% of account`, `${other.suggestRiskPct}% of account`],
    ['Stop width', `${P.atrMult}× ATR`, `${other.atrMult}× ATR`],
  ];
  $('#profCompare').innerHTML = `<thead><tr><th></th><th>This ${esc(P.label.toLowerCase())}</th><th>vs ${esc(other.label.toLowerCase())}</th></tr></thead><tbody>` +
    rows.map(([k, v, o]) => `<tr><td>${k}</td><td class="this">${v}</td><td class="other">${esc(o)}</td></tr>`).join('') + '</tbody>';
  $('#profDrivers').innerHTML = P.drivers.map((d) => `<li>${esc(d)}</li>`).join('');
  $('#profRisks').innerHTML = P.risks.map((d) => `<li>${esc(d)}</li>`).join('');
  $('#profTip').innerHTML = `<b>Trading ${esc(P.label.toLowerCase())}s:</b> ${esc(P.tip)}`;
}

// ---------- Scanner market overview ----------
function renderMarkets() {
  const rows = state.scanRows.filter((r) => !r.error);
  const card = (cls, title, sub, benchSym) => {
    const P = PROFILES[cls], ms = marketStatus(cls);
    const mine = rows.filter((r) => (classify(r.symbol, r.assetClass).cls === 'crypto') === (cls === 'crypto'));
    const buys = mine.filter((r) => r.action === 'BUY').length, sells = mine.filter((r) => r.action === 'SELL').length;
    const bench = rows.find((r) => r.symbol === benchSym);
    return `<div class="mk-card" style="--c:${P.color}"><div class="row"><h3>${title} <span class="cls c-${cls}">${P.short}</span></h3><span class="mkt ${ms.phase}">${esc(ms.label)}</span></div>
      <p>${esc(ms.detail)} ${esc(sub)}</p>
      <div class="stat">${mine.length ? `${mine.length} scanned · <span class="up">${buys} buy</span> · <span class="down">${sells} sell</span>${bench ? ` · ${esc(benchSym)} <span class="sig tone-${bench.tone}">${bench.label}</span>` : ''}` : 'Run a scan to see breadth.'}</div></div>`;
  };
  $('#markets').innerHTML = card('stock', 'Stock market', 'Benchmark: S&P 500 (SPY).', 'SPY') + card('crypto', 'Crypto market', 'Benchmark: Bitcoin — most coins follow it.', 'BTC-USD');
}

// ---------- Portfolio allocation by class ----------
function renderAllocation(P, invested, money) {
  const groups = { stock: [], etf: [], crypto: [] };
  P.forEach((p) => groups[classify(p.chartSymbol || p.symbol, p.assetClass, p.name).cls].push(p));
  const linked = P.filter((p) => classify(p.chartSymbol || p.symbol, p.assetClass, p.name).cryptoLinked).reduce((a, p) => a + (p.value || 0), 0);
  $('#allocCard').hidden = !P.length;
  const parts = Object.entries(groups).map(([k, ps]) => ({ k, P: PROFILES[k], v: ps.reduce((a, p) => a + (p.value || 0), 0), pl: ps.reduce((a, p) => a + (p.pnl || 0), 0), n: ps.length,
    risk: ps.filter((p) => p.sig && p.value > 0).reduce((a, p, _, arr) => a + p.sig.risk * p.value / arr.reduce((s, x) => s + x.value, 0), 0) }));
  $('#allocBar').innerHTML = parts.filter((x) => x.v > 0).map((x) => `<i style="width:${(x.v / invested) * 100}%;background:${x.P.color}" title="${x.P.label} ${((x.v / invested) * 100).toFixed(0)}%"></i>`).join('');
  $('#allocGrid').innerHTML = parts.map((x) => `<div class="ac" style="--c:${x.P.color}"><span class="cls c-${x.k}">${x.P.short}</span> <b>${invested ? ((x.v / invested) * 100).toFixed(0) : 0}%</b>
    <small>${money(x.v)} · ${x.n} position${x.n === 1 ? '' : 's'}</small><small>P/L <span class="${x.pl >= 0 ? 'up' : 'down'}">${money(x.pl)}</span>${x.risk ? ` · risk ${x.risk.toFixed(1)}/10` : ''}</small></div>`).join('') +
    (linked > 0 ? `<p class="note" style="grid-column:1/-1">Plus ${money(linked)} in crypto-linked stocks/ETFs counted as stocks — your real crypto exposure is about ${invested ? (((groups.crypto.reduce((a, p) => a + (p.value || 0), 0) + linked) / invested) * 100).toFixed(0) : 0}%.</p>` : '');
}

// ---------- History / learning card ----------
function renderHistory({ learned: L, decision: D }) {
  if (!L.ok) { $('#histDecision').innerHTML = `<span class="why">${esc(L.reason)}</span>`; return; }
  const label = { BUY: 'Bot would BUY', SELL: 'Bot says SELL / avoid', WATCH: 'Watch — not confirmed', HOLD: 'No edge — hold off', NONE: '—' }[D.action];
  $('#histDecision').innerHTML = `<span class="big d-${D.action}">${label}</span><span class="why">${esc(D.reason)}</span>`;
  $('#histPill').textContent = `${D.evidenceCount}/3 checks bullish`;
  $('#histEvidence').innerHTML = D.evidence.map((e) => `<li><span class="mk ${e.pass ? 'ok' : e.bear ? 'no' : 'na'}">${e.pass ? '✓' : e.bear ? '✗' : '–'}</span><div><b>${esc(e.label)}</b>${esc(e.text)}</div></li>`).join('');
  const r = L.rules;
  $('#histNote').textContent = `Learned from this asset only: trained on the older ${r.ok ? '70%' : 'part'} of its history and judged on the newest 30% it never saw.${r.ok ? ` Tuned buy line ${r.buyAt}, sell line ${r.sellAt}, stop ${r.atrMult}×ATR.` : ''} Horizon: ${L.horizon} bars. A model score (AUC) near 0.50 means no better than a coin flip — the bot ignores it.`;
}

// ---------- Bot ----------
function initBot() {
  $('#botUnlock').addEventListener('submit', async (e) => {
    e.preventDefault(); const c = $('#botCode').value.trim(); if (!c) return;
    access.set(c, false); $('#botCode').value = ''; await loadBot();
  });
  $('#botPreviewBtn').addEventListener('click', previewScan);
  $('#botRun').addEventListener('click', async () => {
    const b = $('#botRun'); b.disabled = true; b.textContent = 'Scanning…'; botMsg('');
    try { const r = await botApi.run(); botMsg(r.skipped || `Scanned ${r.scanned} symbols, sent ${r.sent.length} alert(s).`); await loadBot(); }
    catch (e) { botMsg(e.message, true); } finally { b.disabled = false; b.textContent = 'Run scan now'; }
  });
  $('#botTest').addEventListener('click', async () => {
    try { const r = await botApi.test(); botMsg(r.results.map((x) => `${x.channel}: ${x.ok ? 'sent ✓' : 'failed — ' + x.error}`).join(' · '), r.results.some((x) => !x.ok)); }
    catch (e) { botMsg(e.message, true); }
  });
}
function botMsg(m, err) { const el = $('#botMsg'); el.hidden = !m; el.textContent = m || ''; el.style.cssText = err ? '' : 'background:#0f2219;border-color:#1b4632;color:#a6f0cb'; }

async function loadBot() {
  let st;
  try { st = await botApi.status(); }
  catch (e) {
    if (e.status === 401 || e.status === 429) access.clear();
    $('#botLocked').hidden = false; $('#botOpen').hidden = true; $('#botErr').hidden = false; $('#botErr').textContent = e.message; return;
  }
  $('#botLocked').hidden = true; $('#botOpen').hidden = false; $('#botErr').hidden = true;
  const names = { telegram: 'Telegram', ntfy: 'ntfy', discord: 'Discord', email: 'Email', webhook: 'Webhook' };
  $('#botChannels').innerHTML = (st.channels.length ? st.channels.map((c) => `<span class="prov on">${names[c] || c} · on</span>`).join('') : '<span class="prov err">No alert channel set up — alerts are only stored</span>') +
    `<span class="prov ${st.schedulerOn ? 'on' : ''}">schedule · ${st.schedulerOn ? 'running here' : 'external / off'}</span><span class="prov">memory · ${esc(st.store)}</span>`;
  const rec = st.record;
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  $('#botTiles').innerHTML = [
    ['Last scan', ago(st.lastRun), st.report ? `${st.report.scanned} symbols` : ''],
    ['Alerts (recent)', String(st.alerts.length), st.alerts[0] ? esc(st.alerts[0].symbol) + ' ' + esc(st.alerts[0].action) : ''],
    ['Win rate (all)', rec.winRate == null ? '—' : pct(rec.winRate), rec.closed ? `${rec.closed} closed · avg ${pctS(rec.avgRet)}` : 'needs closed alerts'],
    ...[['stock', 'Stocks & ETFs'], ['crypto', 'Crypto']].map(([k, l]) => { const b = rec.byClass?.[k] || {}, R = st.config.classRules?.[k] || {};
      return [`<span class="cls c-${k}">${k === 'crypto' ? 'CRYPTO' : 'STOCK'}</span> record`, b.closed ? `${pct(b.winRate)}` : '—', `${b.closed || 0} closed · max risk ${R.maxRisk ?? '—'} · ${R.riskPct ?? '—'}%/trade`]; }),
    ['Open alerts', String(rec.open.length), `${st.config.minEvidence}/3 evidence to buy`],
  ].map(([k, v, sub]) => `<div class="tile"><span>${k}</span><b>${v}</b><br><small>${sub}</small></div>`).join('');
  $('#openCard').hidden = !rec.open.length;
  $('#openTable').innerHTML = `<thead><tr><th>Asset</th><th>Alerted at</th><th>Last</th><th>Return</th><th>Stop</th><th>Target</th></tr></thead><tbody>` +
    rec.open.map((o) => `<tr data-s="${esc(o.symbol)}"><td>${esc(o.symbol)}<span class="nm">${new Date(o.at).toLocaleDateString()}</span></td><td>${fmtPx(o.entry)}</td><td>${fmtPx(o.last)}</td><td class="${(o.unrealised ?? 0) >= 0 ? 'up' : 'down'}">${pctS(o.unrealised)}</td><td>${fmtPx(o.stop)}</td><td>${fmtPx(o.target)}${o.t1Hit ? ' ✓' : ''}</td></tr>`).join('') + '</tbody>';
  $('#openTable').onclick = (e) => { const tr = e.target.closest('tr[data-s]'); if (tr) load(tr.dataset.s); };
  $('#botAlerts').innerHTML = st.alerts.length ? st.alerts.slice(0, 40).map((a) => `<li><div class="t d-${esc(a.action)}">${esc(a.title)}</div><div class="m">${new Date(a.at).toLocaleString()} · ${a.delivered.map((d) => esc(d.channel) + (d.ok ? ' ✓' : ' ✗')).join(', ') || 'stored only'}</div><details><summary class="m">details</summary><pre>${esc(a.body)}</pre></details></li>`).join('') : '<li>No alerts yet. The bot only alerts when evidence lines up — quiet days are normal.</li>';
  if (st.report) renderDecisions(st.report.decisions, `Latest scan · ${new Date(st.report.at).toLocaleString()}`, `${st.report.scanned} scanned${st.report.errors.length ? ` · ${st.report.errors.length} errors` : ''}`);
}

let decRows = [], decTitle = '', decMetaTxt = '', decF = 'all';
function renderDecisions(rows, title, meta) {
  if (rows) { decRows = rows; decTitle = title; decMetaTxt = meta; }
  rows = decRows.filter((d) => decF === 'all' || (decF === 'crypto' ? classify(d.symbol, d.assetClass).cls === 'crypto' : classify(d.symbol, d.assetClass).cls !== 'crypto'));
  title = decTitle; meta = decMetaTxt;
  $('#decFilter').onclick = (e) => { const f = e.target.closest('[data-f]')?.dataset.f; if (!f) return; decF = f; $$('#decFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f)); renderDecisions(); };
  $('#decCard').hidden = false; $('#decTitle').textContent = title; $('#decMeta').textContent = meta || '';
  const order = { BUY: 0, SELL: 1, WATCH: 2, HOLD: 3, NONE: 4 };
  rows = [...rows].sort((a, b) => order[a.action] - order[b.action] || b.score - a.score);
  const p0 = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
  $('#decTable').innerHTML = `<thead><tr><th>Asset</th><th>Decision</th><th>Score / line</th><th>P(up)</th><th>Model AUC</th><th>History</th><th>Back-test (unseen)</th><th>Risk</th><th>Checks</th><th>Why</th></tr></thead><tbody>` +
    rows.map((d) => `<tr data-s="${esc(d.symbol)}"><td>${esc(d.symbol)} ${badge(d.symbol, d.assetClass, d.name, true)}<span class="nm">${esc((d.name || '').replace(' (demo)', ''))}${d.held ? ' · you hold' : ''}</span></td>
      <td><b class="d-${d.action}" style="font-family:var(--sans)">${d.action}</b></td>
      <td>${d.score >= 0 ? '+' : ''}${d.score.toFixed(0)} / ${(d.action === 'SELL' ? d.sellLine : d.buyLine) ?? '—'}</td><td>${p0(d.pUp)}</td>
      <td style="color:${d.auc == null ? 'inherit' : d.auc >= 0.54 ? 'var(--up)' : 'var(--dim)'}">${d.auc == null ? '—' : d.auc.toFixed(2)}</td>
      <td>${p0(d.analogsP)}<span class="nm">n=${d.analogsN}</span></td>
      <td class="${(d.oosRet ?? 0) >= 0 ? 'up' : 'down'}">${d.oosRet == null ? '—' : pctS(d.oosRet)}<span class="nm">${d.oosTrades || 0} trades</span></td>
      <td>${d.risk}</td><td class="ev">${(d.evidence || []).map((e) => (e.pass ? '<span class="up">✓</span>' : e.bear ? '<span class="down">✗</span>' : '–')).join('')}</td>
      <td style="text-align:left;font-family:var(--sans);color:var(--muted);white-space:normal;min-width:220px">${esc(d.reason || '')}</td></tr>`).join('') + '</tbody>';
  $('#decTable').onclick = (e) => { const tr = e.target.closest('tr[data-s]'); if (tr) load(tr.dataset.s); };
}

async function previewScan() {
  const list = [...UNIVERSE.stocks, ...UNIVERSE.etfs, ...UNIVERSE.crypto, ...state.watchlist].map((x) => x.symbol).filter((s, i, a) => a.indexOf(s) === i);
  const prog = $('#botProgress'); prog.hidden = false; prog.firstElementChild.style.width = '0';
  const rows = [], queue = [...list]; let done = 0;
  const benches = {};
  const bench = (ac) => { const b = benchFor(ac); return (benches[b] ||= getChart(b, '1d').then((d) => d.candles).catch(() => null)); };
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const d = await getChart(sym, '1d'); const meta = { ...d.meta, interval: '1d' };
        const { learned: L, decision: D, risk } = learnAndDecide(dedupe(d.candles), meta, meta.symbol === benchFor(meta.assetClass) ? null : await bench(meta.assetClass));
        rows.push({ symbol: sym, name: meta.name, assetClass: meta.assetClass, action: D.action, score: D.score ?? L.score ?? 0, buyLine: D.buyLine, sellLine: D.sellLine, pUp: L.model?.pUp, auc: L.model?.auc, analogsP: L.analogs?.pUp, analogsN: L.analogs?.n || 0, oosRet: L.rules?.ok ? L.rules.test.ret : null, oosTrades: L.rules?.ok ? L.rules.test.trades : 0, risk: risk.score, evidence: D.evidence, reason: D.reason });
      } catch { /* skip */ }
      prog.firstElementChild.style.width = `${(++done / list.length) * 100}%`;
      await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
    }
  }));
  setTimeout(() => { prog.hidden = true; }, 300);
  $('#demoBanner').hidden = !isDemo();
  renderDecisions(rows, 'Preview scan — in your browser, no alerts sent', `${rows.length} symbols`);
}

const pct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);

init();
