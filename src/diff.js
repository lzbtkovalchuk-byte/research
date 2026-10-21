// Compares this run with the previous one: ad counts, funnel links (point 2) and funnel screens.
// Writes diff.json (with highlight boxes for changed screens, from a pixel diff, no AI) and one compact
// summary.md for both topics that the AI analysis step reads (keeps it cheap).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
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
  const removed = prev.map((s, i) => ({ n: s.n, title: s.title, kind: s.kind, file: s.file })).filter((_, i) => !usedPrev.has(i));
  return { status, removed };
}

/** Pixel diff of two screenshots → up to 4 boxes (percent of the current image) around what changed.
 *  Only the part both captures share is compared. Tiny regions (timers, carousels dots) are ignored. */
async function diffBoxes(prevFile, curFile) {
  const W = 130, CELL = 5;
  const load = async f => { const { data, info } = await sharp(f).resize({ width: W }).grayscale().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
  let A, B;
  try { A = await load(prevFile); B = await load(curFile); } catch { return null; }
  const h = Math.min(A.h, B.h), cols = Math.ceil(W / CELL), rows = Math.ceil(h / CELL);
  const on = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let hit = 0, tot = 0;
    for (let y = r * CELL; y < Math.min(h, (r + 1) * CELL); y++) for (let x = c * CELL; x < Math.min(W, (c + 1) * CELL); x++) {
      tot++; if (Math.abs(A.data[y * W + x] - B.data[y * W + x]) > 40) hit++;
    }
    if (tot && hit / tot > 0.12) on[r * cols + c] = 1;
  }
  // Connected regions (cells within 2 of each other join).
  const seen = new Uint8Array(cols * rows), rects = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    let minR = 1e9, maxR = -1, minC = 1e9, maxC = -1; const q = [i]; seen[i] = 1;
    while (q.length) {
      const k = q.pop(), r = Math.floor(k / cols), c = k % cols;
      minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const kk = rr * cols + cc; if (on[kk] && !seen[kk]) { seen[kk] = 1; q.push(kk); }
      }
    }
    rects.push({ x0: minC * CELL, y0: minR * CELL, x1: Math.min(W, (maxC + 1) * CELL), y1: Math.min(h, (maxR + 1) * CELL) });
  }
  const screenArea = W * Math.min(h, W * 844 / 390);
  let R = rects.filter(r => (r.x1 - r.x0) * (r.y1 - r.y0) >= screenArea * 0.015);
  const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const area = r => (r.x1 - r.x0) * (r.y1 - r.y0);
  while (R.length > 4) { // merge the pair whose union grows least
    let best = null;
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const u = union(R[i], R[j]); const g = area(u) - area(R[i]) - area(R[j]); if (!best || g < best.g) best = { i, j, u, g }; }
    R = R.filter((_, k) => k !== best.i && k !== best.j); R.push(best.u);
  }
  const pad = 3;
  return R.sort((a, b) => a.y0 - b.y0).map(r => ({
    t: +Math.max(0, (r.y0 - pad) / B.h * 100).toFixed(2), l: +Math.max(0, (r.x0 - pad) / W * 100).toFixed(2),
    w: +Math.min(100, (r.x1 - r.x0 + 2 * pad) / W * 100).toFixed(2), h: +Math.min(100, (r.y1 - r.y0 + 2 * pad) / B.h * 100).toFixed(2),
  }));
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
    const cmp = compareSteps(p.steps, f.steps);
    for (const [j, st] of cmp.status.entries()) {
      if (st.prev) st.prevFile = p.steps[st.prev - 1].file;
      if (st.s !== 'changed') continue;
      st.boxes = await diffBoxes(path.join(PREV, p.dir, p.steps[st.prev - 1].file), path.join(RUN, f.dir, f.steps[j].file));
      // A visual-only change with no visible region left after filtering (timer, animation) is not a change.
      if (st.why === 'visual' && Array.isArray(st.boxes) && !st.boxes.length) { st.s = 'same'; delete st.boxes; }
    }
    d.funnels[key] = { firstRun: false, comparedWith: pk, prevDir: p.dir, prevSteps: p.steps.length, ...cmp };
  }
  diff.apps[app.id] = d;
}
writeJSON(path.join(RUN, 'diff.json'), diff);

// ---------- one compact summary (both topics) for the AI analysis step ----------
const T = a => a.topics.join('+');
const L = [`# Funnel Watch — run ${date} (previous: ${diff.previous || 'none'})`, '',
  'Each app is tagged with its topics (vocal, drawing). Screens marked [CHANGED]/[NEW]/[REMOVED] list the',
  'screenshot paths to open (previous → current). Open only those.', ''];
L.push('## Ads', '| app | topics | geo | active | Δ | new in window |', '|---|---|---|---|---|---|');
for (const app of apps.filter(a => !a.skillsta)) {
  const a = diff.apps[app.id].ads;
  L.push(`| ${app.name} | ${T(app)} | ${app.geo} | ${a?.active ?? '—'} | ${a?.delta ?? '—'} | ${a?.newInWindow ?? '—'} |`);
}
L.push('', '## Link changes');
let anyLink = false;
for (const app of apps) for (const l of diff.apps[app.id].links.filter(l => ['new', 'changed', 'removed'].includes(l.status))) { anyLink = true; L.push(`- ${app.id} (${app.name}): ${l.status} ${l.from ? l.from + ' → ' : ''}${l.key} (${l.ads ?? l.prevAds ?? 0} ads)`); }
if (!anyLink) L.push('- none');
L.push('', '## Funnels');
for (const app of apps) {
  const curF = loadFunnels(RUN, app.id);
  if (!Object.keys(curF).length) { L.push(`### ${app.id} — ${app.name} [${T(app)}]`, 'no web funnel captured', ''); continue; }
  for (const [key, f] of Object.entries(curF)) {
    const fx = f.features; const df = diff.apps[app.id].funnels[key];
    L.push(`### ${app.id} — ${app.skillsta ? '[SKILLSTA] ' : ''}${app.name} [${T(app)}] — ${key}`);
    L.push(`steps=${fx.totalSteps} stop=${fx.stop}${f.emailNote ? ` (email step said: "${f.emailNote}")` : ''} email@${fx.emailStep ?? '—'} paywall@${fx.paywallStep ?? '—'} popups=${fx.popups ?? 0} prices=${fx.prices.join(' ') || '—'} discount=${fx.discount ?? '—'} timer=${fx.timer} trial=${fx.trial} moneyBack=${fx.moneyBack}${!f.proxied && app.geo === 'GB' ? ' (captured from US, no UK proxy yet)' : ''}`);
    if (!df || df.firstRun) { L.push('first capture of this funnel (no comparison)', ''); continue; }
    const ch = f.steps.map((s, i) => ({ s, st: df.status[i] })).filter(x => x.st && x.st.s !== 'same');
    if (!ch.length && !df.removed.length) { L.push('no screen changes', ''); continue; }
    for (const { s, st } of ch) {
      const cur = `data/runs/${date}/${f.dir}/${s.file}`;
      const prev = st.prevFile ? `data/runs/${diff.previous}/${df.prevDir}/${st.prevFile}` : null;
      L.push(`- [${st.s.toUpperCase()}] screen ${s.n} ${s.kind} "${(s.title || '').slice(0, 60)}"${st.boxes ? ` (${st.boxes.length} changed regions)` : ''}: ${prev ? prev + ' → ' : ''}${cur}`);
    }
    for (const r of df.removed) L.push(`- [REMOVED] previous screen ${r.n} ${r.kind || ''} "${(r.title || '').slice(0, 60)}": data/runs/${diff.previous}/${df.prevDir}/${r.file}`);
    L.push('');
  }
}
fs.writeFileSync(path.join(RUN, 'summary.md'), L.join('\n'));
console.log('diff written', RUN);
