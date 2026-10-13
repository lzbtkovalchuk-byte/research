// Compares this run with the previous one: ad counts, funnel links (point 2) and funnel screens.
// Writes diff.json and a compact summary-<topic>.md that the AI analysis step reads (keeps it cheap).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, allApps, runDir, previousRun, readJSON, writeJSON, normalizeUrl } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const PREV = previousRun(date);
const cfg = loadConfig();
const apps = allApps(cfg);

const ham = (a, b) => { if (!a || !b) return 0; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const nt = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();

function loadFunnels(runPath, id) {
  if (!runPath) return {};
  const idx = readJSON(path.join(runPath, 'funnels', id, 'index.json'));
  if (!idx) return {};
  const out = {};
  for (const f of idx.funnels) { const s = readJSON(path.join(runPath, f.dir, 'steps.json')); if (s) out[f.key] = s; }
  return out;
}

/** Marks each current step same / changed / new against the previous walk of the same funnel. */
function compareSteps(prev, cur) {
  const A = prev.map(s => s.textHash), B = cur.map(s => s.textHash);
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const status = new Array(B.length).fill(null), usedPrev = new Set();
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) { status[j] = { s: ham(prev[i].dhash, cur[j].dhash) > 14 ? 'changed' : 'same', prev: i + 1, why: ham(prev[i].dhash, cur[j].dhash) > 14 ? 'visual' : '' }; usedPrev.add(i); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  for (let j = 0; j < B.length; j++) {
    if (status[j]) continue;
    // Same title at a nearby position → content changed; otherwise it's a new screen.
    let best = -1;
    for (let i = 0; i < A.length; i++) if (!usedPrev.has(i) && nt(prev[i].title) && nt(prev[i].title) === nt(cur[j].title) && Math.abs(i - j) <= 6) { best = i; break; }
    if (best >= 0) { usedPrev.add(best); status[j] = { s: 'changed', prev: best + 1, why: 'text' }; }
    else status[j] = { s: 'new' };
  }
  const removed = prev.map((s, i) => ({ n: s.n, title: s.title })).filter((_, i) => !usedPrev.has(i));
  return { status, removed };
}

const diff = { date, previous: PREV ? path.basename(PREV) : null, apps: {} };
for (const app of apps) {
  const cur = readJSON(path.join(RUN, 'ads', `${app.id}.json`));
  const old = PREV ? readJSON(path.join(PREV, 'ads', `${app.id}.json`)) : null;
  const d = { ads: null, links: [], funnels: {} };
  if (cur) {
    d.ads = { active: cur.activeEstimate, prevActive: old?.activeEstimate ?? null, delta: old ? cur.activeEstimate - old.activeEstimate : null, newInWindow: cur.newInWindow, newCreatives: cur.newCreativesInWindow };
    const nowKeys = Object.values(cur.landing), oldKeys = old ? Object.values(old.landing) : [];
    const oldMap = new Map(oldKeys.map(g => [g.key, g]));
    const nowMap = new Map(nowKeys.map(g => [g.key, g]));
    for (const g of nowKeys) {
      if (!old) { d.links.push({ status: 'current', key: g.key, ads: g.ads, first: g.first, store: g.store }); continue; }
      if (oldMap.has(g.key)) { d.links.push({ status: 'same', key: g.key, ads: g.ads, prevAds: oldMap.get(g.key).ads, first: g.first, store: g.store }); continue; }
      const n = normalizeUrl('https://' + g.key);
      const sib = oldKeys.find(o => !nowMap.has(o.key) && normalizeUrl('https://' + o.key)?.host === n?.host && normalizeUrl('https://' + o.key)?.path === n?.path);
      d.links.push(sib ? { status: 'changed', key: g.key, from: sib.key, ads: g.ads, first: g.first, store: g.store } : { status: 'new', key: g.key, ads: g.ads, first: g.first, store: g.store });
    }
    for (const o of oldKeys) if (!nowMap.has(o.key) && !d.links.some(l => l.from === o.key)) d.links.push({ status: 'removed', key: o.key, prevAds: o.ads, lastSeen: o.last, store: o.store });
  }
  const curF = loadFunnels(RUN, app.id), oldF = loadFunnels(PREV, app.id);
  for (const [key, f] of Object.entries(curF)) {
    // Same link as last run; otherwise the previous variant on the same page (e.g. ?flow=a → ?flow=b); otherwise the app's only previous funnel.
    const hp = k => { const n = normalizeUrl('https://' + k); return n ? n.host + n.path : k; };
    let pk = oldF[key] ? key : Object.keys(oldF).find(k => hp(k) === hp(key) && !curF[k]);
    if (!pk && Object.keys(oldF).length === 1 && Object.keys(curF).length === 1) pk = Object.keys(oldF)[0];
    const p = pk ? oldF[pk] : null;
    if (!p) { d.funnels[key] = { firstRun: true, status: f.steps.map(() => ({ s: 'baseline' })), removed: [] }; continue; }
    d.funnels[key] = { firstRun: false, comparedWith: pk, prevSteps: p.steps.length, ...compareSteps(p.steps, f.steps) };
  }
  diff.apps[app.id] = d;
}
writeJSON(path.join(RUN, 'diff.json'), diff);

// ---------- compact per-topic summary for the AI analysis step ----------
for (const topic of ['vocal', 'drawing']) {
  const L = [`# ${topic} — run ${date} (previous: ${diff.previous || 'none'})`, ''];
  L.push('## Ads', '| app | geo | active | Δ | new in window |', '|---|---|---|---|---|');
  for (const app of apps.filter(a => a.topics.includes(topic) && !a.skillsta)) {
    const a = diff.apps[app.id].ads;
    L.push(`| ${app.name} | ${app.geo} | ${a?.active ?? '—'} | ${a?.delta ?? '—'} | ${a?.newInWindow ?? '—'} |`);
  }
  L.push('', '## Link changes');
  for (const app of apps.filter(a => a.topics.includes(topic))) for (const l of diff.apps[app.id].links.filter(l => ['new', 'changed', 'removed'].includes(l.status))) L.push(`- ${app.name}: ${l.status} ${l.from ? l.from + ' → ' : ''}${l.key} (${l.ads ?? l.prevAds ?? 0} ads)`);
  L.push('', '## Funnels (features + changed screens)');
  for (const app of apps.filter(a => a.topics.includes(topic))) {
    const curF = loadFunnels(RUN, app.id);
    for (const [key, f] of Object.entries(curF)) {
      const fx = f.features; const df = diff.apps[app.id].funnels[key];
      L.push(`### ${app.skillsta ? '[SKILLSTA] ' : ''}${app.name} — ${key}`);
      L.push(`steps=${fx.totalSteps} stop=${fx.stop} email@${fx.emailStep ?? '—'} paywall@${fx.paywallStep ?? '—'} questions=${fx.questions} socialProof=${fx.socialProof} loader=${fx.loader} prices=${fx.prices.join(' ') || '—'} discount=${fx.discount ?? '—'} timer=${fx.timer} trial=${fx.trial} moneyBack=${fx.moneyBack}${!f.proxied && app.geo === 'GB' ? ' (captured from US, no UK proxy yet)' : ''}`);
      L.push('screens: ' + f.steps.map(s => `${s.n}.${s.kind}:"${(s.title || '').slice(0, 50)}"${df && !df.firstRun && df.status[s.n - 1]?.s !== 'same' ? ` [${df.status[s.n - 1].s.toUpperCase()}]` : ''}`).join(' | '));
      if (df?.removed?.length) L.push('removed screens: ' + df.removed.map(r => `"${r.title}"`).join(', '));
      L.push('');
    }
  }
  fs.writeFileSync(path.join(RUN, `summary-${topic}.md`), L.join('\n'));
}
console.log('diff written', RUN);
