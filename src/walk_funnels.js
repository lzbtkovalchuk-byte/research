// Walks every funnel (Skillsta + competitors) on a 390x844 phone viewport through the app's geo,
// answering with a fixed, neutral policy so runs are comparable. Saves a screenshot + text per screen.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import sharp from 'sharp';
import { loadConfig, allApps, runDir, readJSON, writeJSON, normalizeUrl, isStoreOrSocial, normText, sleep, sha, proxyFor } from './lib.js';

const RUN = runDir();
const cfg = loadConfig();
const S = cfg.settings || {};
const EMAIL = process.env[S.test_email_env || 'TEST_EMAIL'] || S.test_email || '';
const NAME = S.test_name || 'Alex';
const MAX_STEPS = S.max_steps || 90;
const MAX_FUNNELS = S.max_funnels_per_app || 2;

const CTA = /^(continue|next|next step|get started|let'?s get started|start|start now|start quiz|take the quiz|take quiz|begin|let'?s go|let'?s start|go|got it|ok(ay)?|i'?m ready|ready|submit|done|proceed|i agree|agree|see (my )?(results?|plan)|show (my )?(results?|plan)|get (my )?(results?)|reveal (my )?results?|check (my )?results?|continue with email|sounds good|awesome|great|yes,? let'?s do it|grow your child.s skills|discover more|tap to continue|skip for now|explore( my)? results|view( my)? results|unlock( my)? results|get( my)? results|claim( my)? (plan|results)|continue to results)\b/i;
const NEVER = /(sign in|log ?in|with google|with apple|with facebook|terms|privacy|cookie|policy|back|close|menu|help|faq|contact|download the app|app store|google play|why we ask|why do we ask|learn more|read more|more info|^why\??$|all rights reserved|©|accept( all)?( cookies)?$|allow( all)?( cookies)?$|reject|^home$|home$|^blog$|^instruments$|^languages?$|family plan|log ?out)/i;
const DECLINE = /(don.?t want|do not want|no,? thanks|not now|not interested|i.?ll pass|no thank you|maybe later|skip)/i;
const PRICE = /(?:[$£€]\s?\d+[.,]?\d*|\d+[.,]\d{2}\s?(?:usd|gbp|eur|[$£€]))/gi;

const HIDE_CSS = `#onetrust-consent-sdk,#onetrust-banner-sdk,.cky-consent-container,#CybotCookiebotDialog,#usercentrics-root,.cc-window,[id*="cookie-banner" i],[class*="cookie-banner" i],[aria-label*="cookie" i][role="dialog"]{display:none!important}`;

async function rejectCookies(page) {
  for (const re of [/^reject all$/i, /^reject$/i, /^decline( all)?$/i, /^only (necessary|essential)/i, /^(necessary|essential) only/i, /^deny$/i, /^refuse/i]) {
    const b = page.getByRole('button', { name: re }).first();
    if (await b.isVisible({ timeout: 300 }).catch(() => false)) { await b.click({ timeout: 2000 }).catch(() => {}); await sleep(500); break; }
  }
  await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
}

/** Waits until visible text stops changing (or timeout). */
async function settle(page, maxMs = 6000) {
  let prev = '', stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const cur = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (cur && cur === prev) { if (++stable >= 2) return; } else stable = 0;
    prev = cur;
    await sleep(400);
  }
}

/** Reads the current screen: text, title, inputs, options and CTA candidates (marked in the DOM). */
async function inspect(page) {
  return page.evaluate(({ ctaSrc, neverSrc }) => {
    const CTA = new RegExp(ctaSrc, 'i'), NEVER = new RegExp(neverSrc, 'i');
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight * 1.6 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
    document.querySelectorAll('[data-cfw]').forEach(e => e.removeAttribute('data-cfw'));
    const text = (document.body?.innerText || '').replace(/\n{2,}/g, '\n').trim();
    // Title = largest visible text near the top.
    let title = '', best = 0;
    for (const el of document.querySelectorAll('h1,h2,h3,p,div,span')) {
      if (el.childElementCount > 2 || !vis(el)) continue;
      const t = el.innerText?.trim(); if (!t || t.length > 140) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0; const top = el.getBoundingClientRect().top;
      const score = fs - Math.max(0, top - 450) / 60;
      if (score > best) { best = score; title = t.replace(/\s+/g, ' '); }
    }
    const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis).filter(i => !['hidden', 'submit', 'button', 'radio'].includes(i.type)).map((i, n) => {
      i.setAttribute('data-cfw', 'in' + n);
      const lab = (i.labels?.[0]?.innerText || i.closest('label')?.innerText || '').trim();
      return { sel: `[data-cfw="in${n}"]`, tag: i.tagName.toLowerCase(), type: i.type, name: i.name, ph: i.placeholder || '', label: lab.slice(0, 120), min: i.min, max: i.max, value: i.type === 'checkbox' ? i.checked : i.value, required: i.required };
    });
    const hasPassword = inputs.some(i => i.type === 'password');
    const hasCard = [...document.querySelectorAll('input[autocomplete="cc-number"],iframe[src*="stripe"],iframe[src*="braintree"],iframe[src*="solidgate"],iframe[src*="checkout.com"],iframe[src*="paypal"],iframe[name*="card" i]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 20 && r.top < innerHeight; });
    // Clickable candidates.
    const cand = [...document.querySelectorAll('button,[role=button],[role=radio],[role=checkbox],[role=option],label,a,li,div,span')].filter(el => {
      if (!vis(el)) return false;
      const s = getComputedStyle(el);
      const clickable = ['BUTTON', 'A', 'LABEL'].includes(el.tagName) || el.getAttribute('role') || s.cursor === 'pointer' || el.onclick;
      if (!clickable) return false;
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (!t && !el.querySelector('img,svg')) return false;
      if (t.length > 90) return false;
      const r = el.getBoundingClientRect();
      if (r.top < 64 && r.width < 80) return false; // header icons (back arrow)
      return true;
    });
    let leaf = cand.filter(el => !cand.some(o => o !== el && el.contains(o) && (o.innerText || '').trim()));
    // If a leaf sits inside a real button/label/link, click that instead (handlers live there).
    leaf = [...new Set(leaf.map(el => el.closest('button,[role=button],[role=radio],[role=checkbox],[role=option],label,a') || el))];
    const ctas = [], opts = [];
    leaf.forEach((el, n) => {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      if (NEVER.test(t) && !CTA.test(t)) return;
      el.setAttribute('data-cfw', 'c' + n);
      const r = el.getBoundingClientRect();
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).opacity < 0.5;
      const item = { sel: `[data-cfw="c${n}"]`, text: t.slice(0, 80), top: Math.round(r.top), disabled };
      if (CTA.test(t)) ctas.push(item);
      else if (t && t.length <= 60) opts.push(item);
      else if (!t) opts.push({ ...item, icon: true });
    });
    // Primary button: the widest visible button-like element (usually the full-width CTA at the bottom).
    let primary = null, pw = 0;
    for (const el of document.querySelectorAll('button,[role=button],input[type=submit],a')) {
      if (!vis(el)) continue;
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 40 || NEVER.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < innerWidth * 0.55 || r.top < innerHeight * 0.25) continue;
      const w = r.width + r.top / 10;
      if (w > pw) { pw = w; if (!el.getAttribute('data-cfw')) el.setAttribute('data-cfw', 'p0'); primary = { sel: `[data-cfw="${el.getAttribute('data-cfw')}"]`, text: t.slice(0, 40), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' }; }
    }
    return { url: location.href, title, text: text.slice(0, 4000), inputs, hasPassword, hasCard, ctas, opts, primary };
  }, { ctaSrc: CTA.source, neverSrc: NEVER.source });
}

function inputValue(i) {
  const k = `${i.type} ${i.name} ${i.ph} ${i.label}`.toLowerCase();
  if (i.type === 'email' || /e-?mail/.test(k)) return EMAIL ? { v: EMAIL, kind: 'email' } : { stop: 'email_gate' };
  if (/name/.test(k)) return { v: NAME };
  if (/age|years? old/.test(k)) return { v: '30' };
  if (/height|tall/.test(k)) return { v: /ft|feet/.test(k) ? '5' : '170' };
  if (/weight/.test(k)) return { v: /lb/.test(k) ? '160' : '70' };
  if (i.type === 'number' || i.type === 'tel') {
    const lo = Number(i.min), hi = Number(i.max);
    return { v: String(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? Math.round((lo + hi) / 2) : 30) };
  }
  return null;
}

function classify(s) {
  const prices = (s.text.match(PRICE) || []);
  const payWords = /(per (day|week|month|year)|\/\s?(day|week|wk|month|mo|year|yr)|billed|subscription|plan|trial|money.back|guarantee|discount|% off)/i.test(s.text);
  if (s.hasCard) return 'payment';
  if (prices.length >= 2 && payWords) return 'paywall';
  if (s.hasPassword) return 'account';
  if (s.inputs.some(i => i.type === 'email' || /e-?mail/i.test(`${i.name} ${i.ph} ${i.label}`))) return 'email';
  if (/(creating|building|analy[sz]ing|preparing|generating|calculating) (your|a)/i.test(s.text)) return 'loader';
  if (/\b\d{1,3}(,\d{3})+\+?\s|\d+(\.\d)?\s?(m|k|million)\+?\s(people|users|learners|students|women|men|members)|featured in|as seen (in|on)|trusted by/i.test(s.text)) return 'social_proof';
  if (s.opts.length >= 2) return 'question';
  return 'info';
}

const AGE = /^(under\s?\d+|\d{1,2}\s?[-–]\s?\d{1,2}|\d{1,2}\+|\d{1,2} or (older|more))/i;
/** How many options a multi-select screen needs (e.g. "Choose your top 3"). 0 = single choice. */
function multiCount(text) {
  const m = text.match(/(?:choose|select|pick)\s+(?:your\s+)?(?:top\s+|at least\s+|up to\s+)?(\d)/i);
  if (m) return Number(m[1]);
  return /(all that apply|select all|choose all|multiple answers|select one or more|choose one or more)/i.test(text) ? 1 : 0;
}

function pickOption(s) {
  let o = s.opts.filter(x => !x.disabled && x.text !== s.title);
  if (o.some(x => !x.icon)) o = o.filter(x => !x.icon);
  if (!o.length) return null;
  // Voice/mic tests can't run headless → skip them.
  if (/(record|microphone|\bmic\b|sing a note|glide)/i.test(s.text)) { const sk = o.find(x => /^(skip|finish|not now|later|continue without)/i.test(x.text)); if (sk) return sk; }
  const yes = o.find(x => /^(yes|👍\s*yes|yes,? .{0,20})$/i.test(x.text)); if (yes && o.length <= 4) return yes;
  // Age ranges: pick the bracket containing 30 (adult, neutral).
  const ages = o.filter(x => AGE.test(x.text));
  if (ages.length >= 3) {
    const hit = ages.find(x => { const m = x.text.match(/(\d{1,2})\s?[-–]\s?(\d{1,2})/); return m && Number(m[1]) <= 30 && 30 <= Number(m[2]); });
    if (hit) return hit;
  }
  if (/(e-?mails?|newsletter|updates|offers|promotions)/i.test(s.text)) { const d = o.find(x => DECLINE.test(x.text)); if (d) return d; }
  const r3 = o.find(x => x.text === '3'); if (r3 && o.some(x => x.text === '5')) return r3; // 1–5 scale → middle
  const good = o.filter(x => !/prefer not|^other$|^none|^skip/i.test(x.text) && !DECLINE.test(x.text));
  return (good[0] || o[0]);
}

async function shot(page, file) {
  const buf = await page.screenshot({ type: 'png' });
  await sharp(buf).resize({ width: 390 }).webp({ quality: 68 }).toFile(file);
  const raw = await sharp(buf).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let h = ''; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h += raw[y * 9 + x] > raw[y * 9 + x + 1] ? '1' : '0';
  return h; // 64-bit difference hash for visual change detection
}

async function walk(browser, app, entry, dir) {
  const proxy = proxyFor(app.geo);
  const ctx = await browser.newContext({
    ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    locale: app.geo === 'GB' ? 'en-GB' : 'en-US', timezoneId: app.geo === 'GB' ? 'Europe/London' : 'America/New_York',
    ...(proxy ? { proxy } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const steps = [];
  const seen = new Map();
  let stop = 'max_steps', lastKey = '', prevScreen = null;
  const t0 = Date.now();
  try {
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    await rejectCookies(page);
    for (let i = 0; i < MAX_STEPS; i++) {
      if (Date.now() - t0 > 12 * 60e3) { stop = 'timeout'; break; }
      await settle(page);
      await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
      let s = await inspect(page);
      const host = new URL(s.url).hostname;
      const kind = classify(s);
      const nkey = normText(s.text).slice(0, 2000);
      // Same screen with only a timer/progress change (loaders) → don't record again.
      if (nkey !== lastKey) {
        const n = steps.length + 1;
        const file = String(n).padStart(2, '0') + '.webp';
        const dhash = await shot(page, path.join(dir, file));
        steps.push({ n, file, url: s.url, path: new URL(s.url).pathname, title: s.title, kind, text: s.text.slice(0, 1500), textHash: sha(nkey), dhash, prices: [...new Set(s.text.match(PRICE) || [])].slice(0, 12) });
        lastKey = nkey;
      }
      seen.set(nkey, (seen.get(nkey) || 0) + 1);
      if (seen.get(nkey) > 4) { stop = 'stuck'; break; }
      if (isStoreOrSocial(host)) { stop = 'app_store'; break; }
      if (kind === 'paywall' && steps.length > 1) { stop = 'paywall'; break; }
      if (kind === 'payment') { stop = 'payment_form'; break; }
      if (kind === 'account') { stop = 'account_creation'; break; }
      if (/(one-time code|verification code|enter (the )?code|\botp\b|verify your email|check your (e-?mail|inbox))/i.test(s.text)) { stop = 'email_verification'; break; }

      // Fill inputs.
      let filled = false, gate = null;
      for (const inp of s.inputs) {
        if (inp.type === 'checkbox') {
          if (/terms|privacy|agree|policy|consent to/i.test(inp.label) && !/news|offer|update|marketing|promot/i.test(inp.label) && !inp.value) { await page.locator(inp.sel).check({ force: true }).catch(() => {}); filled = true; }
          continue;
        }
        if (inp.tag === 'select') { await page.locator(inp.sel).selectOption({ index: 1 }).catch(() => {}); filled = true; continue; }
        if (inp.value) continue;
        const v = inputValue(inp);
        if (!v) continue;
        if (v.stop) { gate = v.stop; break; }
        await page.locator(inp.sel).fill(v.v).catch(() => {});
        filled = true;
      }
      if (gate) { stop = gate; break; }

      const before = await page.evaluate(() => location.href + '|' + document.body.innerText).catch(() => '');
      const changed = async () => (await page.evaluate(() => location.href + '|' + document.body.innerText).catch(() => '')) !== before;
      const click = async sel => { await page.locator(sel).first().click({ timeout: 4000 }).catch(() => page.locator(sel).first().click({ force: true }).catch(() => {})); };
      const pressCTA = async st => {
        const c = st.ctas.filter(c => !c.disabled).sort((a, b) => b.top - a.top)[0] || (st.primary && !st.primary.disabled ? st.primary : null);
        if (c) { await click(c.sel); act.cta = c.text; await sleep(1100); }
        return !!c;
      };
      const act = {};
      // Re-visiting a question we already answered (answer feedback, multi-select) → continue instead of toggling the answer.
      const same = prevScreen && prevScreen.url === s.url && prevScreen.title === s.title && prevScreen.answered;
      let answered = false;
      if (filled) { act.filled = true; await sleep(500); await pressCTA(await inspect(page)); answered = true; }
      else {
        let moved = false;
        if (same) moved = await pressCTA(s) && await changed();
        if (!moved && !same && !/\?/.test(s.title + ' ' + s.text.slice(0, 300)) && !multiCount(s.text) && s.ctas.some(c => !c.disabled)) moved = await pressCTA(s) && await changed();
        if (!moved) {
          const multi = multiCount(s.text);
          if (multi) {
            const picks = s.opts.filter(x => !x.disabled && !/prefer not|^other$|^none/i.test(x.text)).slice(0, multi);
            for (const p of picks) { await click(p.sel); await sleep(350); }
            act.opt = picks.map(p => p.text).join(' + ');
          } else {
            const opt = pickOption(s);
            if (opt) { await click(opt.sel); act.opt = opt.text; await sleep(900); }
          }
          answered = !!act.opt;
          const after = await inspect(page);
          if (multi || !(await changed()) || (after.url === s.url && after.title === s.title)) await pressCTA(after);
        }
      }
      if (steps.length) steps[steps.length - 1].action = act;
      prevScreen = { url: s.url, title: s.title, answered };
      if (!(await changed())) {
        // Loader or animated screen: wait for it to move on by itself.
        let moved = false;
        for (let w = 0; w < 25 && !moved; w++) { await sleep(1000); moved = await changed(); }
        if (!moved) {
          await page.keyboard.press('Enter').catch(() => {});
          await sleep(1200);
          if (!(await changed())) { stop = 'stuck'; break; }
        }
      }
    }
  } catch (e) {
    stop = 'error: ' + String(e.message || e).slice(0, 160);
  }
  await ctx.close();
  return { steps, stop, proxied: !!proxy };
}

/** Structural features used for the Skillsta comparison table (no AI needed). */
function features(steps, stop) {
  const idx = k => { const s = steps.find(x => x.kind === k); return s ? s.n : null; };
  const pay = steps.find(s => s.kind === 'paywall');
  const pt = pay?.text || '';
  return {
    totalSteps: steps.length,
    stop,
    emailStep: idx('email'),
    paywallStep: pay?.n || null,
    questions: steps.filter(s => s.kind === 'question').length,
    socialProof: steps.filter(s => s.kind === 'social_proof').length,
    loader: steps.some(s => s.kind === 'loader'),
    prices: pay?.prices || [],
    discount: (pt.match(/(\d{2})\s?% ?off|save (\d{2})\s?%|(\d{2})%\s?discount/i) || []).slice(1).find(Boolean) || null,
    timer: /\b\d{1,2}:\d{2}\b/.test(pt),
    trial: /free trial|\d+[- ]day trial|trial/i.test(pt),
    moneyBack: /money.?back|refund|guarantee/i.test(pt),
  };
}

async function main() {
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const apps = allApps(cfg);
  const browser = await chromium.launch();
  for (const app of apps) {
    if (only && !only.includes(app.id)) continue;
    const ads = readJSON(path.join(RUN, 'ads', `${app.id}.json`), null);
    const entries = [];
    const add = (url, why, g) => { const n = normalizeUrl(url); if (!n || isStoreOrSocial(n.host) || entries.some(e => e.key === n.key)) return; entries.push({ url, key: n.key, why, ads: g?.ads || 0, adShot: g?.shot || null, adId: g?.shotAd || null }); };
    if (ads) Object.values(ads.landing).filter(g => !g.store).sort((a, b) => b.ads - a.ads).forEach(g => add(g.sample, 'ad', g));
    (app.seeds || []).forEach(u => add(u, 'seed'));
    const chosen = entries.slice(0, app.skillsta ? 5 : MAX_FUNNELS);
    const storeOnly = ads && !entries.length && Object.values(ads.landing).some(g => g.store);
    const appDir = path.join(RUN, 'funnels', app.id);
    fs.mkdirSync(appDir, { recursive: true });
    const index = { id: app.id, name: app.name, geo: app.geo, skillsta: !!app.skillsta, storeOnly, funnels: [] };
    for (const e of chosen) {
      const fdir = path.join(appDir, sha(e.key));
      fs.mkdirSync(fdir, { recursive: true });
      console.log(`→ ${app.id} ${e.key}`);
      const r = await walk(browser, app, e.url, fdir);
      const f = { ...e, dir: path.relative(RUN, fdir), stop: r.stop, proxied: r.proxied, steps: r.steps, features: features(r.steps, r.stop) };
      writeJSON(path.join(fdir, 'steps.json'), f);
      index.funnels.push({ key: e.key, dir: f.dir, stop: r.stop, steps: r.steps.length, why: e.why, ads: e.ads });
      console.log(`  ${r.steps.length} screens, stop=${r.stop}`);
    }
    writeJSON(path.join(appDir, 'index.json'), index);
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
