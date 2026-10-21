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
const BASE_EMAIL = process.env[S.test_email_env || 'TEST_EMAIL'] || S.test_email || '';
let EMAIL = BASE_EMAIL; // set per funnel in walk()

/** A fresh plus-address per funnel and run (elza+fw261025imprint1@gmail.com), so no funnel says "already registered". */
function emailFor(app, idx) {
  const m = BASE_EMAIL.match(/^([^@+]+)(?:\+[^@]*)?@(.+)$/);
  if (!m || S.plus_address === false) return BASE_EMAIL;
  const d = path.basename(RUN).replace(/-/g, '').slice(2); // YYMMDD
  return `${m[1]}+fw${d}${app.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}${idx + 1}@${m[2]}`;
}
const NAME = S.test_name || 'Alex';
const MAX_STEPS = S.max_steps || 90;
const MAX_FUNNELS = S.max_funnels_per_app || 2;

const CTA = /^(continue|next|next step|get started|let'?s get started|start|start now|start quiz|take the quiz|take quiz|begin|let'?s go|let'?s start|go|got it|ok(ay)?|i'?m ready|ready|submit|done|proceed|i agree|agree|see (my )?(results?|plan)|show (my )?(results?|plan)|get (my )?(results?)|reveal (my )?results?|check (my )?results?|continue with email|sounds good|awesome|great|yes,? let'?s do it|grow your child.s skills|discover more|tap to continue|skip for now|explore( my)? results|view( my)? results|unlock( my)? results|get( my)? results|claim( my)? (plan|results)|continue to results)\b/i;
const NEVER = /(sign in|log ?in|with google|with apple|with facebook|terms|privacy|cookie|policy|back|close|menu|help|faq|contact|download the app|app store|google play|why we ask|why do we ask|learn more|read more|more info|^why\??$|all rights reserved|©|accept( all)?( cookies)?$|allow( all)?( cookies)?$|reject|customi[sz]e|save my preferences|confirm my choices|manage (cookies|preferences)|cookie settings|^home$|home$|^blog$|^instruments$|^languages?$|family plan|log ?out)/i;
const DECLINE = /(don.?t want|do not want|no,? thanks|not now|not interested|i.?ll pass|no thank you|maybe later|skip)/i;
const PRICE = /(?:[$£€]\s?\d+[.,]?\d*|\d+[.,]\d{2}\s?(?:usd|gbp|eur|[$£€]))/gi;

const HIDE_CSS = `#onetrust-consent-sdk,#onetrust-banner-sdk,.cky-consent-container,#CybotCookiebotDialog,#usercentrics-root,.cc-window,[id*="cookie-banner" i],[class*="cookie-banner" i],[aria-label*="cookie" i][role="dialog"]{display:none!important}`;

async function rejectCookies(page) {
  // Banners without a reject button: open settings and save with optional cookies off.
  const cust = page.getByRole('button', { name: /^(customi[sz]e|manage (preferences|cookies)|cookie settings)$/i }).first();
  if (await cust.isVisible({ timeout: 300 }).catch(() => false) && /cookie/i.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) {
    await cust.click({ timeout: 2000 }).catch(() => {}); await sleep(600);
    const save = page.getByRole('button', { name: /^(save my preferences|confirm my choices|save( settings| preferences)?|reject all)$/i }).first();
    if (await save.isVisible({ timeout: 500 }).catch(() => false)) { await save.click({ timeout: 2000 }).catch(() => {}); await sleep(500); }
  }
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
      const lab = ([...(i.labels || [])].map(l => l.innerText).join(' ') || i.closest('label')?.innerText || i.parentElement?.parentElement?.innerText || '').trim();
      return { sel: `[data-cfw="in${n}"]`, tag: i.tagName.toLowerCase(), type: i.type, name: i.name, ph: i.placeholder || '', label: lab.slice(0, 120), min: i.min, max: i.max, value: i.type === 'checkbox' ? i.checked : i.value, required: i.required };
    });
    const hasPassword = inputs.some(i => i.type === 'password');
    const hasCard = [...document.querySelectorAll('input[autocomplete="cc-number"],iframe[src*="stripe"],iframe[src*="braintree"],iframe[src*="solidgate"],iframe[src*="checkout.com"],iframe[src*="paypal"],iframe[name*="card" i]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 20 && r.top < innerHeight; });
    // Clickable candidates.
    const cand = [...document.querySelectorAll('button,[role=button],[role=radio],[role=checkbox],[role=option],label,a,li,div,span')].filter(el => {
      if (!vis(el)) return false;
      const s = getComputedStyle(el);
      const clickable = ['BUTTON', 'A', 'LABEL'].includes(el.tagName) || el.getAttribute('role') || s.cursor === 'pointer' || el.onclick || /^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test((el.innerText || '').trim());
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
      if (CTA.test(t) && t.length <= 32 && !/receive|news|updates|offers|marketing/i.test(t)) ctas.push(item);
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
    const imgs = [...document.images].filter(i => i.getBoundingClientRect().width > 80 && i.getBoundingClientRect().top < innerHeight).map(i => (i.currentSrc || i.src).slice(-80) + i.alt).join(',');
    const alts = [...document.images].filter(i => i.getBoundingClientRect().width > 80 && i.getBoundingClientRect().top < innerHeight).map(i => i.alt).filter(Boolean).join(' / ');
    return { url: location.href, title, text: text.slice(0, 4000), imgs, alts, inputs, hasPassword, hasCard, ctas, opts, primary };
  }, { ctaSrc: CTA.source, neverSrc: NEVER.source });
}

function inputValue(i) {
  const k = `${i.type} ${i.name} ${i.ph} ${i.label}`.toLowerCase();
  if (i.type === 'email' || /e-?mail/.test(k) || /@/.test(i.ph)) return EMAIL ? { v: EMAIL, kind: 'email' } : { stop: 'email_gate' };
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
  if (prices.length >= 2 && payWords) return 'paywall';
  if (s.hasCard) return 'payment';
  if (s.hasPassword) return 'account';
  if (s.inputs.some(i => i.type === 'email' || /e-?mail/i.test(`${i.name} ${i.ph} ${i.label}`) || /@/.test(i.ph))) return 'email';
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
  if (/(couldn.t access your mic|microphone (is )?blocked|allow (access to )?(your )?microphone)/i.test(s.text)) { const sk = o.find(x => /^(skip|finish|not now|later|continue without)/i.test(x.text)); if (sk) return sk; }
  const yes = o.find(x => /^(yes|👍\s*yes|yes,? .{0,20})$/i.test(x.text)); if (yes && o.length <= 4) return yes;
  // Time pickers: pick a time from the open list.
  const times = o.filter(x => /^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test(x.text));
  if (times.length) return times[Math.floor(times.length / 2)];
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

const MAX_SHOT_H = 6000; // CSS px; longer pages are cut here

/** Many funnels scroll inside a fixed-height container, so fullPage alone would still cut them.
 *  Temporarily let the largest inner scroller (and its ancestors) grow to full height. */
async function expandScroller(page) {
  return page.evaluate(() => {
    let best = null, extra = 0;
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowY)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.4) continue;
      const x = el.scrollHeight - el.clientHeight;
      if (x > 40 && x > extra) { extra = x; best = el; }
    }
    const docScrolls = document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 40;
    if (!best || docScrolls) return false;
    const saved = [];
    for (let e = best; e; e = e.parentElement) {
      saved.push([e, e.getAttribute('style')]);
      e.style.setProperty('height', 'auto', 'important');
      e.style.setProperty('max-height', 'none', 'important');
      e.style.setProperty('overflow', 'visible', 'important');
      if (e !== document.documentElement && e !== document.body && getComputedStyle(e).position === 'fixed') e.style.setProperty('position', 'absolute', 'important');
    }
    window.__cfwRestore = saved;
    return true;
  }).catch(() => false);
}
async function restoreScroller(page) {
  await page.evaluate(() => { for (const [e, st] of window.__cfwRestore || []) st == null ? e.removeAttribute('style') : e.setAttribute('style', st); window.__cfwRestore = null; }).catch(() => {});
}

/** Full-page screenshot (webp, 390 px wide). The visual hash uses only the first screen (390×844),
 *  so a longer capture alone never counts as a change. Returns { dhash, h } with h = image height. */
async function shot(page, file) {
  const expanded = await expandScroller(page);
  if (expanded) await sleep(300);
  let buf;
  try { buf = await page.screenshot({ type: 'png', fullPage: true, timeout: 20000 }); }
  catch { buf = await page.screenshot({ type: 'png' }); }
  finally { if (expanded) await restoreScroller(page); }
  const meta = await sharp(buf).metadata();
  const dpr = meta.width / 390;
  const fullH = Math.min(meta.height, Math.round(MAX_SHOT_H * dpr));
  const full = sharp(buf).extract({ left: 0, top: 0, width: meta.width, height: fullH });
  const out = await full.resize({ width: 390 }).webp({ quality: 68 }).toFile(file);
  const top = await sharp(buf).extract({ left: 0, top: 0, width: meta.width, height: Math.min(meta.height, Math.round(844 * dpr)) }).png().toBuffer();
  const raw = await sharp(top).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let h = ''; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h += raw[y * 9 + x] > raw[y * 9 + x + 1] ? '1' : '0';
  return { dhash: h, h: out.height }; // 64-bit difference hash for visual change detection
}

// ---------- popups (gift offers, exit offers, promo dialogs) ----------
const POP_CLOSE = /^(×|✕|✖|╳|x|close|close popup|dismiss|no,? thanks|no thank you|not now|maybe later|skip|later)$/i;
const POP_OK = /^(continue|ok(ay)?|got it|claim( it| (my )?gift)?|get it|sounds good|great|awesome|thanks!?)$/i;

/** Finds an overlay covering the funnel (not a cookie banner) and marks its close control. */
async function findPopup(page) {
  return page.evaluate(({ closeSrc, okSrc }) => {
    const CLOSE = new RegExp(closeSrc, 'i'), OK = new RegExp(okSrc, 'i');
    const vw = innerWidth, vh = innerHeight;
    const shown = (el, min = 8) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width >= min && r.height >= min && r.bottom > 0 && r.top < vh && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.1; };
    document.querySelectorAll('[data-cfw-pop],[data-cfw-close],[data-cfw-ok]').forEach(e => { e.removeAttribute('data-cfw-pop'); e.removeAttribute('data-cfw-close'); e.removeAttribute('data-cfw-ok'); });
    const bodyLen = (document.body?.innerText || '').trim().length;
    const cands = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]')].filter(e => shown(e, 60));
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' || !shown(el, 60)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * vh * 0.4 || (parseInt(s.zIndex, 10) || 0) < 10) continue;
      cands.push(el);
    }
    for (const el of cands.reverse()) {
      const text = (el.innerText || '').trim();
      if (!text || /cookie|consent|gdpr|privacy preferences/i.test(text.slice(0, 500))) continue;
      // Something must be behind it: an app shell holding the whole funnel is not a popup.
      if (bodyLen - text.length < 60) continue;
      const ctrls = [...el.querySelectorAll('button,[role=button],a,span,div,i,svg')].filter(c => shown(c));
      const er = el.getBoundingClientRect();
      const closeEl = ctrls.find(c => /close|dismiss/i.test(c.getAttribute('aria-label') || '') || /close/i.test(c.className?.baseVal ?? c.className ?? '') && c.getBoundingClientRect().width < 80)
        || ctrls.find(c => CLOSE.test((c.innerText || c.textContent || '').trim()))
        || ctrls.find(c => { const r = c.getBoundingClientRect(); return ['BUTTON'].includes(c.tagName) && !(c.innerText || '').trim() && r.width < 64 && r.top < er.top + er.height * 0.3 && r.left > er.left + er.width * 0.6; });
      const isDialog = el.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog');
      if (!closeEl && !isDialog) continue;
      if (closeEl) (closeEl.closest('button,[role=button],a') || closeEl).setAttribute('data-cfw-close', '1');
      el.setAttribute('data-cfw-pop', '1');
      const okEl = ctrls.find(c => ['BUTTON', 'A'].includes(c.tagName) || c.getAttribute('role') === 'button' ? OK.test((c.innerText || '').trim()) : false);
      if (okEl) okEl.setAttribute('data-cfw-ok', '1');
      // Title: largest text inside the popup.
      let title = '', best = 0;
      for (const t of el.querySelectorAll('h1,h2,h3,p,div,span')) {
        if (t.childElementCount > 2 || !shown(t)) continue;
        const tx = (t.innerText || '').trim(); if (!tx || tx.length > 120) continue;
        const f = parseFloat(getComputedStyle(t).fontSize) || 0; if (f > best) { best = f; title = tx.replace(/\s+/g, ' '); }
      }
      // A point outside the popup's content box (on its backdrop), for click-outside closing.
      let box = null, area = 0;
      for (const c of el.querySelectorAll('*')) {
        const r = c.getBoundingClientRect(); const a = r.width * r.height;
        if (a < vw * vh * 0.85 && a > area && getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)') { area = a; box = r; }
      }
      const outside = box && box.top > 70 ? { x: Math.round(vw / 2), y: Math.round(box.top / 2) } : null;
      return { title, text: text.slice(0, 1500), hasClose: !!closeEl, hasOk: !!okEl, outside, dialog: isDialog };
    }
    return null;
  }, { closeSrc: POP_CLOSE.source, okSrc: POP_OK.source }).catch(() => null);
}

/** Closes the marked popup. Never clicks anything that leads to payment. Returns how it closed, or null. */
async function closePopup(page, pop) {
  const gone = async () => !(await page.evaluate(() => {
    const e = document.querySelector('[data-cfw-pop]'); if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 40 && r.height > 40 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.1;
  }).catch(() => false));
  if (pop.hasClose) {
    const c = page.locator('[data-cfw-close]').first();
    await c.click({ timeout: 3000 }).catch(() => c.click({ force: true, timeout: 2000 }).catch(() => {}));
    await sleep(900); if (await gone()) return 'close button';
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(700); if (await gone()) return 'escape';
  if (pop.outside) {
    await page.mouse.click(pop.outside.x, pop.outside.y).catch(() => {});
    await sleep(700); if (await gone()) return 'click outside';
  }
  // Gift/info popups whose only button is "Continue": fine to press when the popup shows no price.
  if (pop.hasOk && !PRICE.test(pop.text)) {
    PRICE.lastIndex = 0;
    await page.locator('[data-cfw-ok]').first().click({ timeout: 3000 }).catch(() => {});
    await sleep(900); if (await gone()) return 'continue button';
  }
  PRICE.lastIndex = 0;
  return null;
}

const EMAIL_ERR = /(already (exists|registered|in use|taken|been used|have an account)|account (already )?exists|email (is )?(already )?(taken|in use|registered)|invalid e-?mail|enter a valid e-?mail|use a different e-?mail)/i;
/** After the email is submitted: the funnel's error message if it rejected the address. */
async function emailError(page) {
  return page.evaluate(src => {
    const re = new RegExp(src, 'i');
    if (!document.querySelector('input[type=email],input[name*=mail i],input[placeholder*=mail i]')) return null;
    for (const el of document.querySelectorAll('p,span,div,small,label,li')) {
      if (el.childElementCount > 1) continue;
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      if (t && t.length < 160 && r.width > 0 && r.height > 0 && re.test(t)) return t.replace(/\s+/g, ' ');
    }
    return null;
  }, EMAIL_ERR.source).catch(() => null);
}

async function walk(browser, app, entry, dir, idx = 0) {
  EMAIL = emailFor(app, idx);
  const proxy = proxyFor(app.geo);
  const ctx = await browser.newContext({
    permissions: ['microphone', 'camera'],
    ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    locale: app.geo === 'GB' ? 'en-GB' : 'en-US', timezoneId: app.geo === 'GB' ? 'Europe/London' : 'America/New_York',
    ...(proxy ? { proxy } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const steps = [];
  const seen = new Map();
  let stop = 'max_steps', lastKey = '', prevScreen = null, popups = 0, emailNote = null;
  const t0 = Date.now();
  try {
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    await rejectCookies(page);
    for (let i = 0; i < MAX_STEPS; i++) {
      if (Date.now() - t0 > 25 * 60e3) { stop = 'timeout'; break; }
      await settle(page);
      if (i < 3 || i % 5 === 0) await rejectCookies(page);
      await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
      // Popup over the funnel (gift, exit offer, promo): capture it, close it, then capture the screen behind it.
      const pop = popups < 6 ? await findPopup(page) : null;
      if (pop) {
        const pkey = 'popup|' + normText(pop.text).slice(0, 400);
        seen.set(pkey, (seen.get(pkey) || 0) + 1);
        if (seen.get(pkey) <= 2) {
          popups++;
          const n = steps.length + 1, file = String(n).padStart(2, '0') + '.webp';
          const { dhash, h } = await shot(page, path.join(dir, file));
          steps.push({ n, file, url: page.url(), path: new URL(page.url()).pathname, title: pop.title, kind: 'popup', text: pop.text, textHash: sha(pkey.slice(0, 2000)), dhash, h, prices: [] });
          const how = await closePopup(page, pop);
          steps[n - 1].closed = how || 'could not close';
          console.log(`  popup "${pop.title.slice(0, 40)}" → ${how || 'could not close'}`);
          if (!how) { stop = 'popup_blocked'; break; }
          await settle(page, 3000);
          continue;
        }
      }
      let s = await inspect(page);
      const host = new URL(s.url).hostname;
      const kind = classify(s);
      const nkey = normText(s.text).slice(0, 2000) + '|' + s.imgs.slice(0, 600); // image-only screens (statement cards) differ only by picture
      // The screen behind a popup: link it to the popup (it may be a screen recorded just before).
      const lastStep = steps[steps.length - 1];
      if (lastStep?.kind === 'popup' && !lastStep.behind) lastStep.behind = nkey === lastKey ? (steps[steps.length - 2]?.n || null) : steps.length + 1;
      // Same screen with only a timer/progress change (loaders) → don't record again.
      if (nkey !== lastKey) {
        const n = steps.length + 1;
        const file = String(n).padStart(2, '0') + '.webp';
        const { dhash, h } = await shot(page, path.join(dir, file));
        steps.push({ n, file, url: s.url, path: new URL(s.url).pathname, title: s.title, kind, text: s.text.slice(0, 1500), textHash: sha(normText(s.text).slice(0, 2000) + '|' + s.alts), dhash, h, prices: [...new Set(s.text.match(PRICE) || [])].slice(0, 12) });
        lastKey = nkey;
        // Funnel sent us back to its start (e.g. after the email or sign-up): drop that screen and stop.
        const early = new Set(steps.slice(0, 3).map(x => x.path));
        const firstText = steps[0]?.textHash;
        const backToStart = n > 1 && (
          (steps.length > 8 && (early.has(steps[n - 1].path) || steps[n - 1].path === '/') && !early.has(steps[n - 2].path)) ||
          (steps[n - 1].textHash === firstText && steps.slice(0, -1).some(x => x.kind === 'email')));
        if (backToStart) {
          try { fs.unlinkSync(path.join(dir, file)); } catch {}
          steps.pop();
          stop = steps.some(x => x.kind === 'email') ? 'email_loop' : 'looped_to_start';
          break;
        }
      }
      seen.set(nkey, (seen.get(nkey) || 0) + 1);
      if (seen.get(nkey) > 4) { stop = 'stuck'; break; }
      if (isStoreOrSocial(host)) { stop = 'app_store'; break; }
      if (kind === 'paywall' && steps.length > 1) { stop = 'paywall'; break; }
      if (kind === 'payment') { stop = 'payment_form'; break; }
      if (kind === 'account') { stop = 'account_creation'; break; }
      if (/(one-time code|verification code|enter (the )?code|\botp\b|verify your email|check your (e-?mail|inbox))/i.test(s.text)) { stop = 'email_verification'; break; }

      // Date pickers (readonly "Choose date" inputs): open the calendar and pick a day about a month ahead.
      const dateIn = s.inputs.find(i => !i.value && /date|dd\/|mm\//i.test(`${i.ph} ${i.name} ${i.label}`));
      if (dateIn) {
        await page.locator(dateIn.sel).click({ force: true }).catch(() => {});
        await sleep(800);
        const picked = await page.evaluate(() => {
          const vis = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
          const next = [...document.querySelectorAll('[aria-label*="next" i],.dp__arrow_bottom,.dp__inner_nav,[class*="next" i]')].filter(vis)[0];
          if (next) next.click();
          return true;
        }).catch(() => false);
        await sleep(600);
        const ok = await page.evaluate(() => {
          const vis = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
          const cells = [...document.querySelectorAll('.dp__cell_inner,[role=gridcell] button,[role=gridcell],td button,.react-datepicker__day,[class*="day" i]')]
            .filter(e => vis(e) && /^\d{1,2}$/.test((e.innerText || '').trim()) && !/disabled|outside|offset|other/i.test(e.className + ' ' + (e.getAttribute('aria-disabled') || '')));
          const c = cells.find(e => e.innerText.trim() === '15') || cells[Math.floor(cells.length / 2)];
          if (!c) return false;
          c.click();
          const sel = [...document.querySelectorAll('.dp__action_select,button')].filter(vis).find(b => /^(select|ok|done|apply|confirm)$/i.test((b.innerText || '').trim()));
          if (sel) sel.click();
          return true;
        }).catch(() => false);
        if (ok && picked) { await sleep(800); s = await inspect(page); }
      }
      // Fill inputs.
      let filled = false, gate = null, emailFilled = false;
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
        if (v.kind === 'email') emailFilled = true;
      }
      if (gate) { stop = gate; break; }

      const before = await page.evaluate(() => location.href + '|' + document.body.innerText + '|' + [...document.images].filter(i => i.getBoundingClientRect().width > 80 && i.getBoundingClientRect().top < innerHeight).map(i => (i.currentSrc || i.src).slice(-80) + i.alt).join(',')).catch(() => '');
      const changed = async () => (await page.evaluate(() => location.href + '|' + document.body.innerText + '|' + [...document.images].filter(i => i.getBoundingClientRect().width > 80 && i.getBoundingClientRect().top < innerHeight).map(i => (i.currentSrc || i.src).slice(-80) + i.alt).join(',')).catch(() => '')) !== before;
      const snap = () => page.evaluate(() => location.href + '|' + document.body.innerText + '|' + [...document.images].filter(i => i.getBoundingClientRect().width > 80 && i.getBoundingClientRect().top < innerHeight).map(i => (i.currentSrc || i.src).slice(-80) + i.alt).join(',')).catch(() => '');
      // Click; if nothing happens, retry as a touch tap and then a raw mouse click at the element's centre.
      // State = page text + the clicked element's markup, so a checkbox that only changes style still counts as a change.
      const state = async loc => (await snap()) + '|' + (await loc.evaluate(e => e.outerHTML.slice(0, 3000) + (e.closest('form,ul,div')?.innerHTML || '').length).catch(() => ''));
      const click = async (sel, toggle = false) => {
        const loc = page.locator(sel).first();
        const b = await state(loc);
        await loc.click({ timeout: 4000 }).catch(() => loc.click({ force: true }).catch(() => {}));
        if (toggle) return;
        await sleep(700); if ((await state(loc)) !== b) return;
        await loc.tap({ timeout: 3000 }).catch(() => {});
        await sleep(700); if ((await state(loc)) !== b) return;
        await loc.evaluate(e => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) e.dispatchEvent(new PointerEvent(t, { bubbles: true })); e.click(); }).catch(() => {});
        await sleep(700); if ((await state(loc)) !== b) return;
        const bb = await loc.boundingBox().catch(() => null);
        if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2).catch(() => {});
      };
      const pressCTA = async st => {
        const optTexts = new Set(st.opts.map(o => o.text));
        const c = st.ctas.filter(c => !c.disabled).sort((a, b) => b.top - a.top)[0] || (st.primary && !st.primary.disabled && !optTexts.has(st.primary.text) && !/receive|news|updates|offers/i.test(st.primary.text) ? st.primary : null);
        if (c) { await click(c.sel); act.cta = c.text; await sleep(1100); }
        return !!c;
      };
      const act = {};
      // Plain loader (no pop-up question): don't click anything, just let it finish.
      if (kind === 'loader' && !/\?/.test(s.text) && !s.inputs.length) {
        let moved = false;
        for (let w = 0; w < 40 && !moved; w++) { await sleep(1000); moved = await changed(); }
        if (moved) { prevScreen = { url: s.url, title: s.title, answered: false }; continue; }
      }
      // Re-visiting a question we already answered (answer feedback, multi-select) → continue instead of toggling the answer.
      const same = prevScreen && prevScreen.url === s.url && prevScreen.title === s.title && prevScreen.answered;
      let answered = false;
      if (filled) {
        act.filled = true; await sleep(500);
        // Watch for an error message that may flash before the funnel moves on or resets.
        if (emailFilled) await page.evaluate(src => {
          const re = new RegExp(src, 'i'); window.__cfwErr = null;
          const check = () => { if (window.__cfwErr) return; for (const el of document.querySelectorAll('p,span,div,small,label,li')) { if (el.childElementCount > 1) continue; const t = (el.innerText || '').trim(); if (t && t.length < 160 && re.test(t)) { window.__cfwErr = t.replace(/\s+/g, ' '); return; } } };
          new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
        }, EMAIL_ERR.source).catch(() => {});
        await pressCTA(await inspect(page)); answered = true;
        if (emailFilled) {
          act.email = EMAIL;
          await sleep(800);
          const flashed = await page.evaluate(() => window.__cfwErr || null).catch(() => null);
          if (flashed) emailNote = flashed;
          const err = await emailError(page) || (flashed && await page.evaluate(() => !!document.querySelector('input[type=email],input[name*=mail i],input[placeholder*=mail i]')).catch(() => false) ? flashed : null);
          if (err) { emailNote = err; if (steps.length) { steps[steps.length - 1].action = act; steps[steps.length - 1].emailError = err; } stop = 'email_rejected'; break; }
        }
      }
      else {
        let moved = false;
        if (same) moved = await pressCTA(s) && await changed();
        if (!moved && !same && !/\?/.test(s.title + ' ' + s.text.slice(0, 300)) && !multiCount(s.text) && s.ctas.some(c => !c.disabled)) moved = await pressCTA(s) && await changed();
        if (!moved) {
          const multi = multiCount(s.text);
          if (multi) {
            const picks = s.opts.filter(x => !x.disabled && !/prefer not|^other$|^none/i.test(x.text)).slice(0, multi);
            for (const p of picks) { await click(p.sel, true); await sleep(350); }
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
          // Last resort: try each answer and button on the screen until one moves the funnel forward.
          const st = await inspect(page);
          const tries = [...st.opts.filter(o => !o.icon), ...st.ctas, ...(st.primary ? [st.primary] : []), ...st.opts.filter(o => o.icon)].slice(0, 8);
          for (const t of tries) { await click(t.sel); await sleep(800); if (await changed()) { moved = true; act.fallback = t.text; break; } }
          if (!moved) { await page.keyboard.press('Enter').catch(() => {}); await sleep(1200); moved = await changed(); }
          if (!moved) { stop = 'stuck'; break; }
        }
      }
    }
  } catch (e) {
    stop = 'error: ' + String(e.message || e).slice(0, 160);
  }
  // Keep the page markup when the walk got stuck, so the answering rules can be fixed.
  if (/stuck|timeout/.test(stop)) { try { fs.writeFileSync(path.join(dir, 'stuck.html'), (await page.content()).slice(0, 400000)); } catch {} }
  // Every flow should end on a paywall. If a gate we can't pass (email code, account, mic test, stuck screen)
  // stopped the walk, open the paywall directly in the same session (answers and email are kept) and capture it.
  if (!steps.some(x => x.kind === 'paywall')) {
    try {
      const here = new URL(page.url());
      const guesses = [...(app.paywall_urls || []), ...['/paywall', '/plans', '/pricing', '/checkout', '/subscription', '/payment', '/offer', '/plan', '/selling-page', '/get-plan'].map(p => here.origin + p)];
      for (const u of [...new Set(guesses)].slice(0, 12)) {
        const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
        if (!r || r.status() >= 400) continue;
        await sleep(2500); await settle(page); await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
        const s = await inspect(page);
        if (classify(s) !== 'paywall') continue;
        const n = steps.length + 1, file = String(n).padStart(2, '0') + '.webp';
        const { dhash, h } = await shot(page, path.join(dir, file));
        steps.push({ n, file, url: s.url, path: new URL(s.url).pathname, title: s.title, kind: 'paywall', direct: true, h, gate: stop, text: s.text.slice(0, 1500), textHash: sha(normText(s.text).slice(0, 2000)), dhash, prices: [...new Set(s.text.match(PRICE) || [])].slice(0, 12) });
        stop = stop + '+paywall_direct';
        break;
      }
    } catch {}
  }
  await ctx.close();
  return { steps, stop, proxied: !!proxy, email: EMAIL, emailNote };
}

/** Structural features used for the Skillsta comparison table (no AI needed). */
function features(steps, stop) {
  const idx = k => { const s = steps.find(x => x.kind === k); return s ? s.n : null; };
  const pay = steps.find(s => s.kind === 'paywall' && s.n > 1);
  const pt = pay?.text || '';
  return {
    totalSteps: steps.length,
    stop,
    emailStep: idx('email'),
    paywallStep: pay?.n || null,
    questions: steps.filter(s => s.kind === 'question').length,
    socialProof: steps.filter(s => s.kind === 'social_proof').length,
    popups: steps.filter(s => s.kind === 'popup').length,
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
  // Fake mic/camera so voice and drawing tests in funnels can run (they hear a test tone).
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
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
    for (const [ei, e] of chosen.entries()) {
      const fdir = path.join(appDir, sha(e.key));
      fs.mkdirSync(fdir, { recursive: true });
      console.log(`→ ${app.id} ${e.key}`);
      const r = await walk(browser, app, e.url, fdir, ei);
      const f = { ...e, dir: path.relative(RUN, fdir), stop: r.stop, proxied: r.proxied, email: r.email, emailNote: r.emailNote, steps: r.steps, features: features(r.steps, r.stop) };
      writeJSON(path.join(fdir, 'steps.json'), f);
      index.funnels.push({ key: e.key, dir: f.dir, stop: r.stop, steps: r.steps.length, why: e.why, ads: e.ads });
      console.log(`  ${r.steps.length} screens, stop=${r.stop}, email=${r.email}${r.emailNote ? ` (${r.emailNote})` : ''}`);
    }
    writeJSON(path.join(appDir, 'index.json'), index);
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
