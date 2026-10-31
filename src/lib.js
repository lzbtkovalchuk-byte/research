import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = path.join(ROOT, 'data');
export const RUNS = process.env.RUNS_DIR || path.join(DATA, 'runs');

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const today = () => new Date().toISOString().slice(0, 10);
export const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export function loadConfig() {
  return yaml.load(fs.readFileSync(process.env.CONFIG || path.join(ROOT, 'config/competitors.yaml'), 'utf8'));
}

/** All apps (Skillsta funnels + competitors) as a flat list with topics[]. */
export function allApps(cfg = loadConfig()) {
  const sk = (cfg.skillsta || []).map(a => ({ ...a, topics: [a.topic], skillsta: true }));
  return [...sk, ...(cfg.competitors || [])];
}

export function runDir(date = process.env.RUN_DATE || today()) {
  const d = path.join(RUNS, date);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Most recent run folder strictly before `date`. */
export function previousRun(date) {
  if (!fs.existsSync(RUNS)) return null;
  const all = fs.readdirSync(RUNS).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date).sort();
  return all.length ? path.join(RUNS, all[all.length - 1]) : null;
}

export const readJSON = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
export const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };

// ---------- URL normalisation (point 2: detect funnel link changes) ----------
const DROP = /^(utm_.*|fbclid|gclid|ttclid|_ga|_gl|h|ad_id|adset_id|campaign_id|placement|placemnt|sitesource|site_source|ad_name|adset_name|campaign_name|af_.*|pid|c|clickid|u|o|gbv|ds|mos_d|ref|source|mc_.*)$/i;

/** Returns { key, host, path, params } where key identifies the funnel variant. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const params = [];
  for (const [k, v] of u.searchParams) {
    if (DROP.test(k)) continue;
    if (/\{\{.*\}\}/.test(v) || v === '') continue;
    if (v.length > 60) continue; // encoded state blobs, not variant ids
    params.push([k.toLowerCase(), v]);
  }
  params.sort((a, b) => a[0].localeCompare(b[0]));
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
  return { key: host + p + (qs ? '?' + qs : ''), host, path: p, params: Object.fromEntries(params) };
}

export const STORE_HOSTS = /(^|\.)(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|onelink\.me|go\.link|app\.adjust\.com|adj\.st|app\.link|instagram\.com|facebook\.com|fb\.me|oculus\.com|meta\.com|apps\.codeway\.co)$/i;
export const isStoreOrSocial = host => STORE_HOSTS.test(host);

/** Text normalisation for change detection: ignore timers, countdowns, loader %, dates. */
export function normText(t) {
  return (t || '')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '#T')
    .replace(/\b\d{1,3}\s?%/g, '#P')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, '#D')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Proxy for a geo from PROXY_UK / PROXY_US. Accepts the common formats:
 *  http(s)://user:pass@host:port, socks5://host:port, user:pass@host:port, host:port:user:pass, host:port. */
export function parseProxy(raw) {
  let v = String(raw || '').trim().replace(/^['"]|['"]$/g, '').split(/\s+/)[0];
  if (!v) return undefined;
  const num = x => /^\d{2,5}$/.test(x || '');
  if (!/^[a-z0-9]+:\/\//i.test(v)) {
    let creds = null, hostPort = v;
    if (v.includes('@')) {
      const [a, b] = [v.slice(0, v.lastIndexOf('@')), v.slice(v.lastIndexOf('@') + 1)];
      // user:pass@host:port, or host:port@user:pass
      if (num(b.split(':').pop())) { creds = a; hostPort = b; } else { creds = b; hostPort = a; }
    } else {
      const p = v.split(':');
      if (p.length >= 4 && num(p[1])) { hostPort = p[0] + ':' + p[1]; creds = p[2] + ':' + p.slice(3).join(':'); }          // host:port:user:pass
      else if (p.length >= 4 && num(p[p.length - 1])) { hostPort = p.slice(-2).join(':'); creds = p.slice(0, -2).join(':'); } // user:pass:host:port
    }
    const [user, ...pw] = creds ? creds.split(':') : [];
    v = `http://${creds ? `${encodeURIComponent(user)}:${encodeURIComponent(pw.join(':'))}@` : ''}${hostPort}`;
  }
  let u;
  try { u = new URL(v); } catch { return undefined; }
  const port = u.port || ({ 'http:': '80', 'https:': '443' }[u.protocol]);
  if (!u.hostname || !port) return undefined;
  return { server: `${u.protocol}//${u.hostname}:${port}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
}
/** Shape of a secret for logs, without its characters: "word:number:word:word". */
export function shapeOf(raw) {
  return String(raw || '').trim().replace(/[A-Za-z][A-Za-z0-9_.\-]*/g, 'word').replace(/\d+/g, 'number').slice(0, 80) + ` (${String(raw || '').trim().length} chars)`;
}
export function proxyFor(geo) {
  return parseProxy(geo === 'GB' ? process.env.PROXY_UK : process.env.PROXY_US);
}
