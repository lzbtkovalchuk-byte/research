// Collects active Meta ads per app from the public Ad Library (no login),
// filtered by the app's geo, and groups them by normalised landing link.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { loadConfig, allApps, runDir, previousRun, writeJSON, readJSON, normalizeUrl, isStoreOrSocial, sleep, sha, today } from './lib.js';

const RUN = runDir();
const OUT = path.join(RUN, 'ads');
fs.mkdirSync(OUT, { recursive: true });
const runDate = path.basename(RUN);
const prev = previousRun(runDate);
const windowStart = prev ? path.basename(prev) : new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);

const libUrl = (geo, src) => {
  const base = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${geo}&media_type=all`;
  return src.type === 'page'
    ? `${base}&search_type=page&view_all_page_id=${src.value}`
    : `${base}&search_type=keyword_unordered&q=${encodeURIComponent(src.value)}`;
};

async function dismissCookies(page) {
  for (const re of [/decline optional cookies/i, /only allow essential cookies/i, /reject/i]) {
    const b = page.getByRole('button', { name: re }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(800); return; }
  }
}

/** Scrolls the results list and returns parsed ad cards. */
async function scrape(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await dismissCookies(page);
  let last = -1;
  let flat = 0;
  for (let i = 0; i < 60 && flat < 3; i++) {
    const n = await page.evaluate(() => document.body.innerText.split('Library ID: ').length - 1);
    flat = n === last ? flat + 1 : 0;
    last = n;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2200);
  }
  return page.evaluate(() => {
    const txt = document.body.innerText;
    const results = (txt.match(/~?([\d,]+)\s+results?/) || [])[1];
    const pageIds = {};
    const html = document.documentElement.innerHTML;
    for (const m of html.matchAll(/"page_id":"(\d+)"[^{}]{0,400}?"page_name":"([^"]+)"/g)) pageIds[m[2]] = m[1];
    const leaves = [...document.querySelectorAll('div,span')].filter(e => e.childElementCount === 0 && /^Library ID: \d+$/.test(e.textContent.trim()));
    const cards = [];
    for (const leaf of leaves) {
      const id = leaf.textContent.trim().replace('Library ID: ', '');
      let c = leaf;
      while (c.parentElement && !(c.innerText.includes('Sponsored') && (c.innerText.match(/Library ID:/g) || []).length === 1 && c.querySelector('img,video'))) {
        c = c.parentElement;
        if ((c.innerText.match(/Library ID:/g) || []).length > 1) { c = null; break; }
      }
      if (!c) continue;
      c.setAttribute('data-cfw-id', id);
      const t = c.innerText;
      const L = t.split('\n').map(s => s.trim()).filter(s => s && s !== '​');
      const si = L.indexOf('Sponsored');
      const capI = L.findIndex(l => /^[A-Z0-9.-]+\.[A-Z]{2,}$/.test(l));
      const a = c.querySelector('a[href*="l.php"]');
      let link = null;
      if (a) { try { link = decodeURIComponent(new URL(a.href).searchParams.get('u')); } catch {} }
      cards.push({
        id,
        started: (t.match(/Started running on ([A-Z][a-z]{2} \d{1,2}, \d{4})/) || [])[1] || null,
        versions: Number((t.match(/(\d+) ads use this/) || [])[1] || 1),
        page: si > 0 ? L[si - 1] : null,
        body: si >= 0 ? (L[si + 1] || '').slice(0, 300) : '',
        caption: capI > 0 ? L[capI] : null,
        headline: capI > 0 ? L[capI + 1] || '' : '',
        cta: capI > 0 ? L[capI + 2] || '' : '',
        video: !!c.querySelector('video'),
        link,
      });
    }
    return { results: results ? Number(results.replace(/,/g, '')) : null, pageIds, cards };
  });
}

const toISO = s => { if (!s) return null; const d = new Date(s + ' UTC'); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

async function main() {
  const cfg = loadConfig();
  const apps = allApps(cfg).filter(a => a.ads);
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const browser = await chromium.launch();
  // Ad Library geo is a URL filter, so no proxy is needed here.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const summary = [];
  for (const app of apps) {
    if (only && !only.includes(app.id)) continue;
    const srcs = [
      ...(app.ads.page_ids || []).map(v => ({ type: 'page', value: v })),
      ...(app.ads.domains || []).map(v => ({ type: 'domain', value: v })),
    ];
    const out = { id: app.id, name: app.name, geo: app.geo, collected: today(), windowStart, sources: [], ads: [], landing: {}, pageIds: {} };
    const seen = new Set();
    for (const src of srcs) {
      const url = libUrl(app.geo, src);
      let r;
      try { r = await scrape(page, url); } catch (e) { out.sources.push({ ...src, url, error: String(e).slice(0, 200) }); continue; }
      let cards = r.cards;
      if (src.type === 'domain') cards = cards.filter(c => c.link && new URL(c.link).hostname.endsWith(src.value.replace(/^www\./, '')));
      out.sources.push({ ...src, url, results: r.results, parsed: r.cards.length, kept: cards.length });
      Object.assign(out.pageIds, r.pageIds);
      for (const c of cards) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        c.startedISO = toISO(c.started);
        const n = c.link ? normalizeUrl(c.link) : null;
        c.key = n?.key || null;
        c.store = n ? isStoreOrSocial(n.host) : null;
        out.ads.push(c);
        if (c.key) {
          const g = out.landing[c.key] ||= { key: c.key, sample: c.link, store: c.store, ads: 0, creatives: 0, first: c.startedISO, last: c.startedISO, adIds: [] };
          g.ads += c.versions; g.creatives++; g.adIds.push(c.id);
          if (c.startedISO && (!g.first || c.startedISO < g.first)) g.first = c.startedISO;
          if (c.startedISO && (!g.last || c.startedISO > g.last)) { g.last = c.startedISO; g.sample = c.link; }
        }
      }
      // Screenshot the newest ad card for each web landing group (shown at the start of each flow).
      for (const g of Object.values(out.landing)) {
        if (g.shot) continue;
        const newest = out.ads.filter(a => a.key === g.key).sort((a, b) => (b.startedISO || '').localeCompare(a.startedISO || ''))[0];
        const loc = page.locator(`[data-cfw-id="${newest.id}"]`);
        if (!(await loc.count())) continue;
        try {
          await loc.scrollIntoViewIfNeeded();
          // Headless Chromium can't play Meta's video codecs; show the video's poster frame instead of the error box.
          await loc.evaluate(c => c.querySelectorAll('video').forEach(v => {
            if (!v.poster) return;
            const img = document.createElement('img'); img.src = v.poster; img.style.cssText = 'width:100%;height:auto;display:block';
            const box = v.closest('div[class]') || v.parentElement; box.replaceChildren(img);
          })).catch(() => {});
          await sleep(1500);
          const buf = await loc.screenshot({ timeout: 15000 });
          const file = `${app.id}-${sha(g.key)}.webp`;
          await sharp(buf).resize({ width: 600, withoutEnlargement: true }).webp({ quality: 70 }).toFile(path.join(OUT, file));
          g.shot = file; g.shotAd = newest.id;
        } catch {}
      }
    }
    // Page result counts are Meta's estimates; for domain searches use the filtered count.
    // Domain searches can match other advertisers; trust Meta's total only when nearly all parsed ads were the app's own.
    out.activeEstimate = out.sources.reduce((s, x) => s + (x.type === 'page' ? (x.results || 0) : (x.kept || 0)), 0);
    out.parsedCreatives = out.ads.length;
    out.newInWindow = out.ads.filter(a => a.startedISO && a.startedISO >= windowStart).reduce((s, a) => s + a.versions, 0);
    out.newCreativesInWindow = out.ads.filter(a => a.startedISO && a.startedISO >= windowStart).length;
    writeJSON(path.join(OUT, `${app.id}.json`), out);
    summary.push({ id: app.id, active: out.activeEstimate, newInWindow: out.newInWindow, landings: Object.keys(out.landing).length, errors: out.sources.filter(s => s.error).length });
    console.log(app.id, JSON.stringify(summary.at(-1)));
  }
  await browser.close();
  writeJSON(path.join(OUT, '_summary.json'), summary);
}

main().catch(e => { console.error(e); process.exit(1); });
