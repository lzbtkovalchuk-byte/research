// Builds one self-contained HTML report per topic (vocal, drawing) from the run data,
// the diff and the AI analysis (if present). Screenshots are embedded so the file can be shared as-is.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, allApps, runDir, readJSON, esc, ROOT } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const cfg = loadConfig();
const apps = allApps(cfg);
const diff = readJSON(path.join(RUN, 'diff.json'), { apps: {} });
const CSS = fs.readFileSync(path.join(ROOT, 'src/report.css'), 'utf8');
const runs = fs.readdirSync(path.dirname(RUN)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const reportNo = String(runs.indexOf(date) + 1).padStart(2, '0');

const img = p => { try { return 'data:image/webp;base64,' + fs.readFileSync(p).toString('base64'); } catch { return null; } };
const geoChip = g => g === 'GB' ? '<span class="chip uk">UK</span>' : '<span class="chip us">US</span>';
const fmtDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—';
const KIND = { question: 'Question', info: 'Info', social_proof: 'Social proof', loader: 'Loader', email: 'Email gate', paywall: 'Paywall', account: 'Create account', payment: 'Payment' };
const STOP = { paywall: 'stopped at paywall (screenshot only)', account_creation: 'stopped at account creation (not submitted)', payment_form: 'stopped at payment form', email_gate: 'stopped at email gate (no test email set)', email_verification: 'stopped at email code verification', app_store: 'goes to the app store', stuck: 'auto-walk got stuck here — review', timeout: 'walk timed out', max_steps: 'step limit reached' };

function loadFunnels(id) {
  const idx = readJSON(path.join(RUN, 'funnels', id, 'index.json'));
  if (!idx) return { idx: null, list: [] };
  return { idx, list: idx.funnels.map(f => readJSON(path.join(RUN, f.dir, 'steps.json'))).filter(Boolean) };
}

function flowHTML(app, f) {
  const df = diff.apps[app.id]?.funnels?.[f.key] || { status: [], removed: [], firstRun: true };
  const changed = df.status.filter(s => s?.s === 'changed').length, added = df.status.filter(s => s?.s === 'new').length;
  const chips = df.firstRun ? '<span class="chip neutral">First capture</span>'
    : (changed || added || df.removed?.length) ? `${changed ? `<span class="chip chg">${changed} changed</span>` : ''}${added ? `<span class="chip new">${added} new</span>` : ''}${df.removed?.length ? `<span class="chip del">${df.removed.length} removed</span>` : ''}`
    : '<span class="chip neutral">No screen changes</span>';
  const fx = f.features;
  const meta = [f.key, `${fx.totalSteps} screens`, fx.emailStep ? `email gate at ${fx.emailStep}` : null, fx.paywallStep ? `paywall at ${fx.paywallStep}` : null, STOP[f.stop] || f.stop].filter(Boolean).join(' · ');
  const adCard = f.adShot ? (() => { const src = img(path.join(RUN, 'ads', f.adShot)); return src ? `<div class="shot ad"><div class="phone"><img loading="lazy" src="${src}" alt="Meta ad" data-cap="${esc(app.name)} · Meta ad (Library ID ${esc(f.adId)}) → ${esc(f.key)}"></div><span class="n">Ad</span><span class="cap">${f.ads} ads → this link</span></div><span class="arrow" aria-hidden="true">→</span>` : ''; })() : '';
  const shots = f.steps.map((s, i) => {
    const st = df.status[i]?.s;
    const cls = st === 'changed' ? ' changed' : st === 'new' ? ' added' : '';
    const badge = st === 'changed' ? '<span class="badge chg">Changed</span>' : st === 'new' ? '<span class="badge new">New</span>' : '';
    const src = img(path.join(RUN, f.dir, s.file));
    return `<div class="shot"><div class="phone${cls}" style="position:relative">${badge}${src ? `<img loading="lazy" src="${src}" alt="${esc(s.title)}" data-cap="${esc(app.name)} · ${s.n}. ${esc(s.title)} · ${esc(s.path)}">` : ''}</div><span class="n">${s.n} · ${esc(KIND[s.kind] || s.kind)}</span><span class="cap">${esc((s.title || '').slice(0, 60))}</span></div>`;
  }).join('');
  const removed = df.removed?.length ? `<p class="note">Removed since last run: ${df.removed.map(r => esc(r.title || 'untitled screen')).join(' · ')}</p>` : '';
  const proxyWarn = !f.proxied && app.geo === 'GB' ? '<p class="warn">Captured from a US connection — no UK proxy configured yet, so prices may differ from what UK users see.</p>' : '';
  return `<div class="flow" data-app="${app.id}">
    <div class="flow-head"><h3>${esc(app.name)}</h3>${geoChip(app.geo)}${chips}</div>
    <p class="flow-meta mono">${esc(meta)}</p>${df.comparedWith && df.comparedWith !== f.key ? `<p class="note">Link changed since last run — screens compared with <span class="mono">${esc(df.comparedWith)}</span>.</p>` : ''}${proxyWarn}
    <div class="strip">${adCard}${shots}</div>${removed}</div>`;
}

function topHeadlines(id) {
  const a = readJSON(path.join(RUN, 'ads', `${id}.json`));
  if (!a) return '—';
  const c = {};
  for (const ad of a.ads) { const h = (ad.headline || ad.body || '').trim(); if (h && h.length > 3) c[h] = (c[h] || 0) + ad.versions; }
  return Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([h]) => '“' + esc(h.slice(0, 90)) + '”').join('<br>') || '—';
}

function destType(id) {
  const a = readJSON(path.join(RUN, 'ads', `${id}.json`));
  if (!a) return '—';
  const g = Object.values(a.landing);
  const web = g.filter(x => !x.store).reduce((s, x) => s + x.ads, 0), store = g.filter(x => x.store).reduce((s, x) => s + x.ads, 0);
  if (!web && !store) return '<span class="chip neutral">No links</span>';
  if (web && store) return '<span class="chip neutral">Web + store</span>';
  return web ? '<span class="chip neutral">Web funnel</span>' : '<span class="chip neutral">App store</span>';
}

function build(topic) {
  const A = readJSON(path.join(RUN, `analysis-${topic}.json`), null);
  const tApps = apps.filter(a => a.topics.includes(topic));
  const comps = tApps.filter(a => !a.skillsta), sk = tApps.filter(a => a.skillsta);
  const d = id => diff.apps[id] || {};
  const newAds = comps.reduce((s, a) => s + (d(a.id).ads?.newInWindow || 0), 0);
  const linkChanges = tApps.flatMap(a => (d(a.id).links || []).filter(l => ['new', 'changed', 'removed'].includes(l.status)).map(l => ({ ...l, app: a })));
  const changedFunnels = tApps.filter(a => Object.values(d(a.id).funnels || {}).some(f => !f.firstRun && f.status.some(s => s.s !== 'same'))).map(a => a.name);
  const firstRun = !diff.previous;

  const adsRows = comps.map(a => { const x = d(a.id).ads; return `<tr><td class="app">${esc(a.name)}${a.genesis ? '<small>Genesis</small>' : ''}</td><td>${geoChip(a.geo)}</td><td class="r num">${x ? '~' + x.active : '—'}</td><td class="r num ${x?.delta > 0 ? 'delta-up' : x?.delta < 0 ? 'delta-dn' : ''}">${x?.delta == null ? '—' : (x.delta > 0 ? '+' : '') + x.delta}</td><td class="r num">${x?.newInWindow ?? '—'}</td><td>${destType(a.id)}</td><td>${topHeadlines(a.id)}</td></tr>`; }).join('');

  const linkRows = (firstRun
    ? tApps.flatMap(a => (d(a.id).links || []).filter(l => !l.store).map(l => ({ ...l, app: a })))
    : linkChanges).map(l => {
      const chip = { new: '<span class="chip new">New funnel</span>', changed: '<span class="chip chg">Variant changed</span>', removed: '<span class="chip del">Removed</span>', current: '<span class="chip neutral">Current</span>' }[l.status];
      const link = l.status === 'changed' ? `<s>${esc(l.from)}</s> → <ins>${esc(l.key)}</ins>` : l.status === 'removed' ? `<s>${esc(l.key)}</s>` : `<ins>${esc(l.key)}</ins>`;
      return `<tr><td class="app">${esc(l.app.name)}<small>${l.app.geo === 'GB' ? 'UK' : 'US'}</small></td><td>${chip}</td><td class="url">${link}</td><td class="r num">${l.ads ?? l.prevAds ?? 0}</td><td class="num">${l.status === 'removed' ? 'last seen ' + fmtDate(l.lastSeen) : fmtDate(l.first)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No funnel link changes since the last run.</td></tr>';

  const flows = [...sk, ...comps].map(a => {
    const { idx, list } = loadFunnels(a.id);
    if (!list.length) return `<div class="flow"><div class="flow-head"><h3>${esc(a.name)}</h3>${geoChip(a.geo)}</div><p class="note">${idx?.storeOnly ? 'All current ads send people to the app stores — no web funnel to capture.' : 'No web funnel found this run (no active ads with a web link and no saved link).'}</p></div>`;
    return list.map(f => flowHTML(a, f)).join('');
  }).join('');

  // Comparison: one row per main funnel.
  const cmp = [...sk, ...comps].flatMap(a => loadFunnels(a.id).list.slice(0, a.skillsta ? 5 : 1).map(f => ({ a, f })));
  const yes = v => v ? '<span class="yes">Yes</span>' : '<span class="no">No</span>';
  const cmpRows = cmp.map(({ a, f }) => { const x = f.features; return `<tr class="${a.skillsta ? 'skl' : ''}"><td class="app">${esc(a.name)}</td><td class="r num">${x.totalSteps}</td><td class="r num">${x.emailStep ?? '—'}</td><td class="r num">${x.paywallStep ?? '—'}</td><td class="r num">${x.questions}</td><td class="r num">${x.socialProof}</td><td>${yes(x.loader)}</td><td class="mono">${esc(x.prices.slice(0, 4).join(' · ') || '—')}</td><td>${x.discount ? x.discount + '%' : '—'}</td><td>${yes(x.timer)}</td><td>${yes(x.trial)}</td><td>${yes(x.moneyBack)}</td></tr>`; }).join('');

  const ampList = A?.amplitude ? (Array.isArray(A.amplitude) ? A.amplitude : [A.amplitude]) : [];
  const amp = ampList.filter(x => x?.steps?.length).map(F => {
    const st = F.steps;
    const conv = st.map((x, i) => i ? x.pct / st[i - 1].pct : 1);
    const worst = conv.slice(1).reduce((w, c, i) => c < conv[w] ? i + 1 : w, 1);
    return `<div class="card"><div class="sec-head"><h3>${esc(F.funnel || 'Skillsta funnel')}</h3><span class="muted mono">Amplitude · ${esc(F.period || '')}</span></div><div class="bars">${st.map((x, i) => `<div class="bar${i === worst ? ' drop' : ''}"><span>${esc(x.label)}</span><div class="track"><div class="fill" style="width:${Math.max(0.6, x.pct * 100).toFixed(1)}%"></div></div><span class="pct">${x.pct * 100 >= 10 ? (x.pct * 100).toFixed(0) : (x.pct * 100).toFixed(2)}%</span></div>${i ? `<div class="muted" style="font-size:11.5px;margin:-4px 0 2px 10.5em">${(conv[i] * 100).toFixed(0)}% of previous step${x.n ? ` · ${x.n.toLocaleString('en-US')} users` : ''}</div>` : `<div class="muted" style="font-size:11.5px;margin:-4px 0 2px 10.5em">${x.n ? x.n.toLocaleString('en-US') + ' users' : ''}</div>`}`).join('')}</div><p class="muted" style="font-size:12.5px">Bars: share of quiz starters reaching each step. Red: weakest step-to-step conversion.</p></div>`;
  }).join('') || '<div class="card"><h3>Skillsta funnel drop-off</h3><p class="note">Amplitude data is added by the analysis step.</p></div>';

  const hyps = A?.hypotheses?.length ? A.hypotheses.map(h => `<article class="hyp"><div class="top"><span class="chip p${Math.min(3, h.priority || 3)}">Priority ${h.priority || 3}</span><span class="chip neutral">${esc(h.stage || '')}</span></div><h3>${esc(h.title)}</h3><dl><dt>Seen in</dt><dd>${esc(h.seen_in || '—')}</dd><dt>Change</dt><dd>${esc(h.change || '—')}</dd><dt>Metric</dt><dd>${esc(h.metric || '—')}</dd><dt>Expected impact</dt><dd>${esc(h.impact || '—')}</dd></dl></article>`).join('') : '<p class="note">Hypotheses are added by the analysis step.</p>';
  const findings = A?.findings?.length ? `<ol>${A.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ol>` : `<p class="muted">${firstRun ? 'First run — this report is the baseline; changes are marked from the next run on.' : 'Analysis pending.'}</p>`;

  const title = topic === 'vocal' ? 'Vocal' : 'Drawing';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} Funnel Watch #${reportNo}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${CSS}</style></head><body>
<div class="wrap">
<header><span class="eyebrow">Skillsta · Competitor monitoring · ${title} · Report #${reportNo}</span>
<h1>${title}: Meta ads &amp; web funnels</h1>
<div class="meta"><span class="num"><b>Run:</b> ${fmtDate(date)} ${date.slice(0, 4)}${diff.previous ? ` · compared with ${fmtDate(diff.previous)}` : ' · baseline run'}</span><span class="chip uk">UK · Genesis products</span><span class="chip us">US · all other apps</span></div></header>
<nav aria-label="Report sections"><a href="#summary">Summary</a><a href="#ads">Ads activity</a><a href="#links">Funnel links</a><a href="#flows">Flows</a><a href="#skillsta">Skillsta vs competitors</a><a href="#hypotheses">Hypotheses</a></nav>
<section id="summary"><div class="sec-head"><h2>What changed in the last 2 weeks</h2></div>
<div class="summary"><div class="stat"><span class="eyebrow">Competitors tracked</span><span class="v num">${comps.length}</span><span class="d muted">+ ${sk.length} Skillsta funnel${sk.length > 1 ? 's' : ''}</span></div>
<div class="stat"><span class="eyebrow">New ads in window</span><span class="v num">${newAds}</span><span class="d muted">started since ${fmtDate(diff.previous || null)}</span></div>
<div class="stat"><span class="eyebrow">Funnel links changed</span><span class="v num">${firstRun ? '—' : linkChanges.length}</span><span class="d muted">${firstRun ? 'baseline run' : ['new', 'changed', 'removed'].map(k => linkChanges.filter(l => l.status === k).length + ' ' + k).join(' · ')}</span></div>
<div class="stat"><span class="eyebrow">Funnels with changed screens</span><span class="v num">${firstRun ? '—' : changedFunnels.length}</span><span class="d muted">${esc(changedFunnels.slice(0, 3).join(', ') || (firstRun ? 'baseline run' : 'none'))}</span></div></div>
<div class="headlines"><span class="eyebrow">Top findings</span>${findings}</div></section>
<section id="ads"><div class="sec-head"><h2>Meta ads activity</h2><span class="muted mono">Meta Ad Library · UK for Genesis products, US for others · counts are Meta's estimates</span></div>
<div class="tbl"><table><thead><tr><th>App</th><th>Geo</th><th class="r">Active ads</th><th class="r">Δ vs last run</th><th class="r">New in window</th><th>Destination</th><th>Top headlines</th></tr></thead><tbody>${adsRows}</tbody></table></div></section>
<section id="links"><div class="sec-head"><h2>Funnel link changes</h2><span class="muted">${firstRun ? 'Baseline: links currently used by ads' : 'Same app, different destination since last run (tracking parameters ignored)'}</span></div>
<div class="tbl"><table><thead><tr><th>App</th><th>Status</th><th>Link</th><th class="r">Ads</th><th>First seen</th></tr></thead><tbody>${linkRows}</tbody></table></div></section>
<section id="flows"><div class="sec-head"><h2>Ad → funnel flows</h2><span class="muted"><span class="chip chg">Changed</span> <span class="chip new">New</span> vs last run · tap a screen to enlarge</span></div>${flows}</section>
<section id="skillsta"><div class="sec-head"><h2>Skillsta vs competitors</h2><span class="muted">Structure detected from the captured screens</span></div>
<div class="tbl"><table><thead><tr><th>Funnel</th><th class="r">Screens</th><th class="r">Email at</th><th class="r">Paywall at</th><th class="r">Questions</th><th class="r">Social proof</th><th>Loader</th><th>Paywall prices</th><th>Discount</th><th>Timer</th><th>Trial</th><th>Money-back</th></tr></thead><tbody>${cmpRows}</tbody></table></div>
${A?.comparison_notes?.length ? `<div class="headlines"><span class="eyebrow">How Skillsta differs</span><ul>${A.comparison_notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
${amp}</section>
<section id="hypotheses"><div class="sec-head"><h2>Hypotheses to test</h2><span class="muted">Ranked by expected impact on Skillsta's biggest drop-off</span></div><div class="hyps">${hyps}</div></section>
<footer><span><b>How this report is made:</b> ad counts and links from the Meta Ad Library (UK for Genesis products, US for all others); funnels walked automatically on a 390×844 phone screen with fixed neutral answers and a test email, stopping at account creation or the paywall; screens compared with the previous run by text and image; Skillsta conversion from Amplitude.</span></footer>
</div>
<div class="lb" id="lb" hidden><button type="button" id="lb-close">Close</button><figure><img id="lb-img" alt=""><figcaption id="lb-cap"></figcaption></figure></div>
<script>
(function(){var lb=document.getElementById('lb'),im=document.getElementById('lb-img'),cap=document.getElementById('lb-cap');
document.addEventListener('click',function(e){var t=e.target;if(t.tagName==='IMG'&&t.closest('.phone')){im.src=t.src;cap.textContent=t.dataset.cap||'';lb.hidden=false;}else if(t===lb||t.id==='lb-close'){lb.hidden=true;}});
document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.hidden=true;});})();
</script></body></html>`;
}

for (const topic of ['vocal', 'drawing']) {
  const html = build(topic);
  const out = path.join(RUN, `report-${topic}.html`);
  fs.writeFileSync(out, html);
  console.log(out, (html.length / 1e6).toFixed(1) + ' MB');
}
