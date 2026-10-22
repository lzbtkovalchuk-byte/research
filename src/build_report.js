// Builds one self-contained HTML report for both topics (vocal + drawing) from the run data, the diff
// and the AI analysis (analysis.json, if present). Only what changed since the previous run is shown;
// full funnels stay in data/runs/<date>/. Only screenshots used on the page are embedded.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, allApps, runDir, readJSON, esc, ROOT, RUNS, isStoreOrSocial } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const cfg = loadConfig();
const apps = allApps(cfg);
const diff = readJSON(path.join(RUN, 'diff.json'), { apps: {} });
const A = readJSON(path.join(RUN, 'analysis.json'), {}) || {};
const PREV = diff.previous ? path.join(RUNS, diff.previous) : null;
const CSS = fs.readFileSync(path.join(ROOT, 'src/report.css'), 'utf8');
const runs = fs.readdirSync(RUNS).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const reportNo = String(runs.indexOf(date) + 1).padStart(2, '0');
const MAX_CARDS = 8; // per funnel; a full redesign is summarised instead of shown screen by screen

const cache = new Map();
const img = p => { if (!cache.has(p)) { try { cache.set(p, 'data:image/webp;base64,' + fs.readFileSync(p).toString('base64')); } catch { cache.set(p, null); } } return cache.get(p); };
const fmtDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—';
const fmtLong = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const topicOf = a => a.topics.includes('vocal') && a.topics.includes('drawing') ? 'both' : a.topics[0];
const TAGS = { both: '<span class="tp v">Vocal</span><span class="tp d">Drawing</span>', vocal: '<span class="tp v">Vocal</span>', drawing: '<span class="tp d">Drawing</span>' };
const KIND = { question: 'Question', info: 'Info', social_proof: 'Social proof', loader: 'Loader', email: 'Email', paywall: 'Paywall', account: 'Create account', payment: 'Payment', popup: 'Popup' };
const STOP = {
  paywall: 'reached the paywall', account_creation: 'stops at account creation (needs a password)', payment_form: 'stops at the payment form',
  email_gate: 'stops at the email gate (no test email set)', email_verification: 'stops at the email verification code', app_store: 'sends people to the app store',
  stuck: 'the automatic walk got stuck', looped_to_start: 'goes back to its first screen (account needed to go further)',
  email_loop: 'goes back to its first screen after the email', email_code_not_received: 'the email code did not arrive in the test inbox', email_rejected: 'rejects the test email', popup_blocked: 'a popup could not be closed',
  timeout: 'the walk timed out', max_steps: 'step limit reached',
};
const stopText = f => { const [s0, extra] = String(f.stop).split('+'); const t = STOP[s0] || (s0.startsWith('error') ? 'the page failed to load' : s0); return extra === 'paywall_direct' ? `${t}; paywall opened directly` : t; };
const short = k => k.length > 60 ? k.slice(0, 57) + '…' : k;

function loadFunnels(runPath, id) {
  const idx = readJSON(path.join(runPath, 'funnels', id, 'index.json'));
  if (!idx) return [];
  return idx.funnels.filter(f => !isStoreOrSocial(f.key.split('/')[0])).map(f => readJSON(path.join(runPath, f.dir, 'steps.json'))).filter(Boolean);
}

/** One phone screenshot. side: prev | cur. boxes: highlight rectangles in % of the image. */
function phone(file, cap, side, label, boxes = [], h = 844) {
  const src = file && img(file);
  if (!src) return `<figure class="ph ${side} empty"><div class="frame">${esc(label === 'Previous' ? 'Not on the previous run' : 'No screenshot')}</div><figcaption>${esc(label)}</figcaption></figure>`;
  const bx = (boxes || []).map(b => `<span class="hl" style="top:${b.t}%;left:${b.l}%;width:${b.w}%;height:${b.h}%"></span>`).join('');
  return `<figure class="ph ${side}"><div class="frame"><div class="canvas"><img src="${src}" alt="${esc(cap)}" loading="lazy" data-cap="${esc(cap)}">${bx}</div></div><figcaption>${esc(label)}${h > 900 ? '<span class="tall">Scroll inside the screen</span>' : ''}</figcaption></figure>`;
}

const noteFor = (appId, key, n, removed = false) => (A.screens || []).find(x => x.app === appId && (!x.funnel || x.funnel === key) && x.n === n && !!x.removed === removed);

/** Builds the change cards for one funnel. */
function changes(app, f) {
  const df = diff.apps[app.id]?.funnels?.[f.key];
  if (!df || df.firstRun || !PREV) return { cards: [], count: 0 };
  // The analysis can hide a whole funnel (e.g. the walk took a different answer branch) or single screens
  // (capture noise: lazy-loaded images, shuffled options). Hidden screens are not shown or counted.
  if ((A.hide_funnels || []).some(h => h.app === app.id && h.funnel === f.key)) return { cards: [], count: 0 };
  const hidden = (n, removed) => noteFor(app.id, f.key, n, removed)?.hide;
  const curDir = path.join(RUN, f.dir), prevDir = path.join(PREV, df.prevDir || '');
  const removed = [...(df.removed || [])];
  const items = [];
  f.steps.forEach((s, j) => {
    const st = df.status[j]; if (!st || st.s === 'same' || hidden(s.n, false)) return;
    if (st.s === 'changed') { items.push({ type: 'Changed', cur: s, prev: { n: st.prev, file: st.prevFile, title: '' }, boxes: st.boxes }); return; }
    if (s.kind === 'popup') { const behind = f.steps.find(x => x.n === s.behind); items.push({ type: 'Popup', cur: s, behind }); return; }
    // A new screen where a previous one was removed at the same place = replaced (or the one the analysis names).
    const before = j ? df.status[j - 1]?.prev : 0, pn = noteFor(app.id, f.key, s.n)?.prev_n;
    const ri = pn ? removed.findIndex(r => r.n === pn) : removed.findIndex(r => before != null && r.n === (before || 0) + 1);
    if (ri >= 0) { items.push({ type: 'Replaced', cur: s, prev: removed[ri] }); removed.splice(ri, 1); return; }
    items.push({ type: 'New', cur: s });
  });
  for (const r of removed) if (!hidden(r.n, true)) items.push({ type: 'Removed', prev: r });
  const label = it => `${KIND[(it.cur || it.prev).kind] || 'Screen'}, step ${(it.cur || it.prev).n}`;
  const cards = items.slice(0, MAX_CARDS).map(it => {
    const n = noteFor(app.id, f.key, (it.cur || it.prev).n, it.type === 'Removed');
    const tt = s => (s?.title || 'untitled screen').slice(0, 70);
    const title = n?.title || ({ Changed: () => `“${tt(it.cur)}” changed`, Replaced: () => `New screen “${tt(it.cur)}” replaces “${tt(it.prev)}”`, New: () => `New screen: “${tt(it.cur)}”`, Removed: () => `Screen removed: “${tt(it.prev)}”`, Popup: () => `Popup: “${tt(it.cur)}”` })[it.type]();
    const notes = n?.notes?.length ? n.notes : [({ Changed: () => 'Changed areas are boxed in yellow.', Replaced: () => 'The screen at this point of the funnel is different.', New: () => 'This screen was not in the previous run.', Removed: () => 'This screen is no longer in the funnel.', Popup: () => `Closed automatically (${it.cur?.closed || 'closed'}) and the screen behind it was captured.` })[it.type]()];
    const cap = (s, when) => `${app.name} · ${when} · ${s.n}. ${s.title || ''}`;
    let pair;
    if (it.type === 'Popup') pair = `<div class="pair">${phone(path.join(curDir, it.cur.file), cap(it.cur, 'popup'), 'cur', 'Popup', [], it.cur.h)}${it.behind ? phone(path.join(curDir, it.behind.file), cap(it.behind, 'behind the popup'), 'prev', 'Behind the popup', [], it.behind.h) : ''}</div>`;
    else if (it.type === 'New') pair = `<div class="pair single">${phone(path.join(curDir, it.cur.file), cap(it.cur, fmtDate(date)), 'cur', `New · ${fmtDate(date)}`, [], it.cur.h)}</div>`;
    else if (it.type === 'Removed') pair = `<div class="pair single">${phone(path.join(prevDir, it.prev.file), cap(it.prev, fmtDate(diff.previous)), 'prev', `Removed · was there on ${fmtDate(diff.previous)}`)}</div>`;
    else pair = `<div class="pair">${phone(path.join(prevDir, it.prev.file), cap(it.prev, fmtDate(diff.previous)), 'prev', `Previous · ${fmtDate(diff.previous)}`)}${phone(path.join(curDir, it.cur.file), cap(it.cur, fmtDate(date)), 'cur', `Current · ${fmtDate(date)}`, it.boxes, it.cur.h)}</div>`;
    return `<article class="chg"><header><span class="st ${it.type === 'Replaced' ? 'changed' : it.type.toLowerCase()}">${it.type}</span><h4>${esc(title)}</h4><span class="step">${esc(label(it))}</span></header>${pair}<div class="note"><p class="who">What changed</p><ul>${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></article>`;
  });
  if (items.length > MAX_CARDS) cards.push(`<p class="more">${items.length - MAX_CARDS} more changed screens: see <code>data/runs/${date}/${esc(f.dir)}/</code>. This funnel looks substantially redesigned.</p>`);
  return { cards, count: items.length, kinds: [...new Set(items.map(it => (it.cur || it.prev).kind))] };
}

const firstRun = !PREV;
const comps = apps.filter(a => !a.skillsta), sk = apps.filter(a => a.skillsta);
const dApp = id => diff.apps[id] || {};
const linkChanges = id => (dApp(id).links || []).filter(l => !l.store && ['new', 'changed', 'removed'].includes(l.status));
const adsNotable = x => x && (x.newInWindow >= 20 || (x.delta != null && Math.abs(x.delta) >= Math.max(20, (x.prevActive || 0) * 0.25)));

// ---------- per-app changes ----------
const perApp = apps.map(app => {
  const list = loadFunnels(RUN, app.id);
  const ch = list.map(f => ({ f, ...changes(app, f) }));
  const screens = ch.reduce((s, c) => s + c.count, 0);
  const links = linkChanges(app.id);
  const ads = dApp(app.id).ads;
  // A landing page with prices is not a paywall; a landing that only hands over to the app store has no web paywall.
  const noPaywall = list.filter(f => !String(f.stop).startsWith('app_store') && !f.steps.some(s => s.kind === 'paywall' && s.n > 1));
  let line = A.what_changed?.[app.id];
  if (!line) {
    if (firstRun) line = 'First capture.';
    else {
      const parts = [];
      if (screens) parts.push(`${screens} screen${screens > 1 ? 's' : ''} changed (${[...new Set(ch.flatMap(c => c.kinds || []))].map(k => (KIND[k] || k).toLowerCase()).join(', ')})`);
      if (links.length) parts.push(['new', 'changed', 'removed'].map(k => { const n = links.filter(l => l.status === k).length; return n ? `${n} funnel link${n > 1 ? 's' : ''} ${k}` : ''; }).filter(Boolean).join(', '));
      if (adsNotable(ads)) parts.push(`ads: ${ads.newInWindow} new in two weeks${ads.delta != null ? `, ${ads.delta > 0 ? '+' : ''}${ads.delta} active` : ''}`);
      line = parts.length ? parts.join('. ').replace(/^./, c => c.toUpperCase()) + '.' : 'No changes.';
    }
    if (!list.length) line += ' No web funnel captured.';
    else if (noPaywall.length === list.length) line += ' Paywall not reached (see Coverage).';
  }
  const status = screens ? 'mod' : (links.length || adsNotable(ads)) ? 'minor' : 'none';
  return { app, list, ch, screens, links, ads, status, line, noPaywall };
});

const changedApps = perApp.filter(p => p.status !== 'none');
const autoHeadline = firstRun ? 'Baseline run: everything below is the starting point for the next comparison.'
  : `${perApp.filter(p => p.screens && !p.app.skillsta).length} competitor${perApp.filter(p => p.screens && !p.app.skillsta).length === 1 ? '' : 's'} changed funnel screens; ${perApp.filter(p => !p.app.skillsta && p.status === 'minor').length} changed links or ads. Everyone else: no changes.`;

const wcRow = p => `<li class="wc ${p.status}" data-topic="${topicOf(p.app)}"><span class="nm">${esc(p.app.name)}</span><span class="tags">${TAGS[topicOf(p.app)]}</span><span class="ln">${esc(p.line)}${p.screens ? ` <a href="#${p.app.id}">See</a>` : p.links.length ? ' <a href="#links">See</a>' : p.status === 'minor' ? ' <a href="#ads">See</a>' : ''}</span></li>`;
const order = [...perApp.filter(p => !p.app.skillsta)].sort((a, b) => ({ mod: 0, minor: 1, none: 2 }[a.status] - { mod: 0, minor: 1, none: 2 }[b.status]));
const wcHTML = `<ul class="wcl">${order.map(wcRow).join('')}</ul>`;
const skWC = `<ul class="wcl">${perApp.filter(p => p.app.skillsta).map(wcRow).join('')}</ul>`;

const screensHTML = firstRun
  ? '<p class="empty-note">This is the first run, so there is nothing to compare yet. From the next run on, changed screens appear here side by side.</p>'
  : (perApp.filter(p => p.screens).map(p => `<div class="comp" id="${p.app.id}" data-topic="${topicOf(p.app)}"><h3>${esc(p.app.name)} <span class="tags">${TAGS[topicOf(p.app)]}</span></h3>${p.ch.filter(c => c.count).map(c => `<p class="meta">${esc(short(c.f.key))} · captured from ${c.f.proxied || p.app.geo === 'US' ? (p.app.geo === 'GB' ? 'UK' : 'US') : 'US (no UK proxy yet)'}</p>${c.cards.join('')}`).join('')}</div>`).join('')
    || '<p class="empty-note">No funnel screens changed since the previous run.</p>');

const adRows = comps.map(a => { const x = dApp(a.id).ads; const dc = x?.delta > 0 ? 'up' : x?.delta < 0 ? 'down' : ''; return `<tr data-topic="${topicOf(a)}"><td>${esc(a.name)}</td><td><span class="tags">${TAGS[topicOf(a)]}</span></td><td>${a.geo === 'GB' ? 'UK' : 'US'}</td><td class="r">${x ? x.active.toLocaleString('en-US') : '—'}</td><td class="r ${dc}">${x?.delta == null ? '—' : (x.delta > 0 ? '+' : x.delta < 0 ? '−' : '') + Math.abs(x.delta)}</td><td class="r">${x?.newInWindow ?? '—'}</td></tr>`; }).join('');

// ---------- top creative by impressions (Ad Library sorted high to low) ----------
const adsOf = (dir, id) => dir ? readJSON(path.join(dir, 'ads', `${id}.json`), null) : null;
const topCards = comps.map(a => {
  const t = adsOf(RUN, a.id)?.top; if (!t || t.sortedByImpressions !== true) return ''; // only a confirmed impressions sort counts as "top"
  const pt = adsOf(PREV, a.id)?.top;
  const was = !pt ? '<span class="badge c">First check</span>' : pt.id === t.id ? `<span class="badge">Same as ${fmtDate(diff.previous)}</span>` : '<span class="badge n">New top creative</span>';
  const src = t.shot && img(path.join(RUN, 'ads', t.shot));
  const since = t.started ? `Running since ${fmtDate(t.started)}${t.daysRunning != null ? ` (${t.daysRunning} days)` : ''}` : 'Start date not shown';
  const where = t.key ? (t.store ? 'App store' : esc(short(t.key))) : 'No link';
  return `<article class="topc" data-topic="${topicOf(a)}">${src ? `<div class="frame"><img src="${src}" alt="Top ad of ${esc(a.name)}" loading="lazy" data-cap="${esc(a.name)} · top creative by impressions · Library ID ${esc(t.id)}"></div>` : '<div class="noimg">No screenshot</div>'}<div class="tb"><h4>${esc(a.name)} ${was}</h4>${t.body ? `<p class="copy">${esc(t.body)}</p>` : ''}<p>${since}${t.versions > 1 ? ` · ${t.versions} versions` : ''}${t.video ? ' · video' : ''}</p><p>Leads to <code>${where}</code></p></div></article>`;
}).filter(Boolean);
const topsMissing = comps.filter(a => { const t = adsOf(RUN, a.id)?.top; return t && t.sortedByImpressions !== true; }).map(a => a.name);
const topsHTML = topCards.length ? `<h3 style="margin-top:28px">Top creative by impressions</h3><p class="sub">The first ad in Meta’s Ad Library sorted by impressions, high to low, in each app’s geo. Meta doesn’t publish the numbers for these ads, only the order.</p><div class="tops">${topCards.join('')}</div>${topsMissing.length ? `<p class="sub" style="margin-top:10px">Not sorted by impressions this run, so not shown: ${esc(topsMissing.join(', '))}.</p>` : ''}` : '';

const allLinks = apps.flatMap(a => linkChanges(a.id).map(l => ({ ...l, a })));
const linkRows = allLinks.map(l => `<tr data-topic="${topicOf(l.a)}"><td>${esc(l.a.name)}</td><td><span class="badge ${{ new: 'n', changed: 'c', removed: 'x' }[l.status]}">${l.status[0].toUpperCase() + l.status.slice(1)}</span></td><td class="lk">${l.status === 'changed' ? `<del>${esc(l.from)}</del> <ins>${esc(l.key)}</ins>` : l.status === 'removed' ? `<del>${esc(l.key)}</del>` : `<ins>${esc(l.key)}</ins>`}</td><td class="r">${l.ads ?? l.prevAds ?? 0}</td></tr>`).join('');
const linksHTML = firstRun ? '<p class="empty-note">Baseline run: link changes are tracked from the next run.</p>'
  : allLinks.length ? `<div class="tbl"><table><thead><tr><th>App</th><th>Status</th><th>Link</th><th class="r">Ads</th></tr></thead><tbody>${linkRows}</tbody></table></div>`
  : `<p class="empty-note">No funnel link changes since ${fmtDate(diff.previous)}.</p>`;

// ---------- Skillsta (Amplitude) ----------
const ampList = Array.isArray(A.amplitude) ? A.amplitude : A.amplitude ? [A.amplitude] : [];
const pct = (a, b) => b ? a / b * 100 : null;
const fmtPct = v => v == null ? '—' : (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
const ampHead = ampList[0]?.steps?.slice(1).map(s => `<th class="r">${esc(s.label)}</th>`).join('') || '';
const ampRows = ampList.filter(F => F.steps?.length).map(F => {
  const st = F.steps;
  const cells = st.slice(1).map((s, i) => {
    const cur = pct(s.n, st[i].n), prev = s.prev_n != null && st[i].prev_n ? pct(s.prev_n, st[i].prev_n) : null;
    const d = cur != null && prev != null ? cur - prev : null;
    return `<td class="r">${fmtPct(cur)}${d == null ? '' : `<span class="dlt ${d >= 0.5 ? 'up' : d <= -0.5 ? 'down' : ''}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pp</span>`}</td>`;
  }).join('');
  const s0 = st[0], ds = s0.prev_n != null ? s0.n - s0.prev_n : null;
  return `<tr data-topic="${esc(F.topic || 'both')}"><td>${esc(F.funnel)}</td><td class="r">${(s0.n ?? 0).toLocaleString('en-US')}${ds == null ? '' : `<span class="dlt">${ds >= 0 ? '+' : '−'}${Math.abs(ds).toLocaleString('en-US')}</span>`}</td>${cells}</tr>`;
}).join('');
const ampHTML = ampRows ? `<p class="sub">Amplitude${ampList[0].period ? ', ' + esc(ampList[0].period) : ''}: step-to-step conversion${ampList[0].prev_period ? `, change in percentage points vs ${esc(ampList[0].prev_period)}` : ''}.</p><div class="tbl"><table><thead><tr><th>Funnel</th><th class="r">Starts</th>${ampHead}</tr></thead><tbody>${ampRows}</tbody></table></div>`
  : '<p class="empty-note">Amplitude data is added by the analysis step.</p>';

const ideas = (A.ideas || []).map(h => typeof h === 'string' ? `<li>${esc(h)}</li>` : `<li><b>${esc(h.title)}</b>${h.detail ? ' ' + esc(h.detail) : ''}${h.seen_in ? ` <span class="why">(${esc(h.seen_in)})</span>` : ''}</li>`).join('');

// ---------- coverage ----------
const cov = perApp.flatMap(p => p.noPaywall.map(f => {
  const last = f.steps[f.steps.length - 1];
  const src = last && img(path.join(RUN, f.dir, last.file));
  return `<li data-topic="${topicOf(p.app)}">${src ? `<div class="frame"><div class="canvas"><img src="${src}" alt="${esc(last.title || '')}" data-cap="${esc(p.app.name)} · where the walk stopped: ${last.n}. ${esc(last.title || '')}"></div></div>` : '<span></span>'}<div><p><b>${esc(p.app.name)}</b>: ${esc(stopText(f))}${f.emailNote ? `. The email step said: “${esc(f.emailNote)}”` : ''}${f.restartUrl ? `. It went back to ${esc(f.restartUrl.replace(/^https?:\/\//, '').slice(0, 70))}` : ''}.</p><p class="why">${esc(short(f.key))}${last ? ` · stopped at step ${last.n}, “${esc((last.title || '').slice(0, 60))}”` : ''}</p></div></li>`;
}));
const signups = perApp.flatMap(p => p.list.filter(f => f.signedUp).map(f => `<li><b>${esc(p.app.name)}</b>: ${esc(f.signedUp)}</li>`));
const signupHTML = signups.length ? `<div class="hyp" style="margin-top:14px"><p class="who" style="margin:0 0 8px;font-weight:600">Test accounts created this run</p><ul style="margin:0;padding-left:18px">${signups.join('')}</ul><p class="why" style="margin:8px 0 0">Password: the TEST_ACCOUNT_PASSWORD secret.</p></div>` : '';
const covHTML = cov.length ? `<ul class="covl">${cov.join('')}</ul>` : '<p class="empty-note">Every funnel reached its paywall.</p>';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Funnel Watch #${reportNo}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Public+Sans:wght@400;500;600&display=swap">
<style>${CSS}</style></head><body>
<div class="wrap">
<header class="top"><h1>Funnel Watch #${reportNo}</h1>
<p>Vocal and drawing competitors, ${fmtLong(date)}${diff.previous ? ` compared with ${fmtLong(diff.previous)}` : ' (baseline run)'}. Only what moved since the last run is shown; full funnels for every run stay in the repo.</p>
<p class="headline">${esc(A.headline || autoHeadline)}</p></header>
<div class="bar" role="toolbar" aria-label="Filter by topic"><button type="button" data-f="all" aria-pressed="true">All</button><button type="button" data-f="vocal" aria-pressed="false">Vocal</button><button type="button" data-f="drawing" aria-pressed="false">Drawing</button>
<nav aria-label="Sections"><a href="#changed">What changed</a><a href="#screens">Screens</a><a href="#ads">Ads</a><a href="#links">Links</a><a href="#skillsta">Skillsta</a>${cov.length ? '<a href="#coverage">Coverage</a>' : ''}</nav></div>
<section id="changed"><h2>What changed</h2><div class="wcbox">${wcHTML}</div>
<div class="legend"><span>Funnel screens changed</span><span class="minor">Links or ads changed</span></div></section>
<section id="screens"><h2>Changed screens</h2><p class="sub">Previous on the left, current on the right. Yellow boxes mark what changed; tap a screen to enlarge.</p>${screensHTML}</section>
<section id="ads"><h2>Meta ads activity</h2><p class="sub">Active ads now, change since ${fmtDate(diff.previous)}, and ads started in the window. Counts are Meta’s estimates; each app uses its own geo.</p>
<div class="tbl"><table><thead><tr><th>App</th><th>Topic</th><th>Geo</th><th class="r">Active</th><th class="r">Δ</th><th class="r">New</th></tr></thead><tbody>${adRows}</tbody></table></div>${topsHTML}</section>
<section id="links"><h2>Funnel link changes</h2><p class="sub">Only new, changed or removed links. Tracking parameters are ignored.</p>${linksHTML}</section>
<section id="skillsta"><h2>Skillsta funnels</h2>${ampHTML}${sk.length ? `<div class="wcbox" style="margin-top:14px">${skWC}</div>` : ''}</section>
${ideas ? `<section id="ideas"><h2>Ideas from this update</h2><div class="hyp"><ol>${ideas}</ol></div></section>` : ''}
${cov.length || signups.length ? `<section id="coverage"><h2>${cov.length ? 'Coverage' : 'Test accounts'}</h2>${cov.length ? `<p class="sub">Funnels where the capture didn’t reach the paywall this run.</p><div class="cov" style="display:block">${covHTML}</div>` : ''}${signupHTML}</section>` : ''}
<footer>Full funnels: <code>data/runs/${date}/</code>${diff.previous ? ` and <code>data/runs/${diff.previous}/</code>` : ''}. Funnels are walked automatically on a 390×844 phone screen with fixed neutral answers and a test email; nothing is bought.</footer>
</div>
<dialog id="zoom"><img alt=""><p></p></dialog>
<script>
(function(){
  var btns=document.querySelectorAll('.bar button');
  btns.forEach(function(b){b.addEventListener('click',function(){var f=b.dataset.f;
    btns.forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});
    document.querySelectorAll('[data-topic]').forEach(function(el){var t=el.dataset.topic;el.classList.toggle('hidden',!(f==='all'||t==='both'||t===f));});});});
  var d=document.getElementById('zoom');
  document.addEventListener('click',function(e){var fr=e.target.closest('.frame');
    if(fr&&!e.target.closest('dialog')){var im=fr.querySelector('img');if(!im)return;d.querySelector('img').src=im.src;d.querySelector('p').textContent=im.dataset.cap||'';d.showModal();return}
    if(e.target.closest('dialog'))d.close();});
})();
</script></body></html>`;

const out = path.join(RUN, 'report.html');
fs.writeFileSync(out, html);
console.log(out, (html.length / 1e6).toFixed(2) + ' MB');
