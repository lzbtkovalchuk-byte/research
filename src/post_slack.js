// Posts the run's report.html to Slack as one message: the "What changed" lines as text, plus the HTML
// file, so people outside the org (Slack Connect) can download and open it.
// Needs SLACK_BOT_TOKEN (scopes: files:write, chat:write). Channel: SLACK_CHANNEL_ID, else settings.slack_channel.
import fs from 'node:fs';
import path from 'node:path';
import { runDir, readJSON, loadConfig, allApps } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN) { console.log('SLACK_BOT_TOKEN not set — skipping Slack.'); process.exit(0); }
const cfg = loadConfig();
const channel = process.env.SLACK_CHANNEL_ID || cfg.settings?.slack_channel;
if (!channel) { console.log('No Slack channel set.'); process.exit(0); }

async function api(method, body, form = true) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

const file = path.join(RUN, 'report.html');
if (!fs.existsSync(file)) { console.log('No report.html for', date); process.exit(0); }
const A = readJSON(path.join(RUN, 'analysis.json'), {}) || {};
const diff = readJSON(path.join(RUN, 'diff.json'), {}) || {};
const runs = fs.readdirSync(path.dirname(RUN)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const no = String(runs.indexOf(date) + 1).padStart(2, '0');
const fmt = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const apps = allApps(cfg).filter(a => !a.skillsta);
const changed = apps.map(a => ({ a, line: A.what_changed?.[a.id] })).filter(x => x.line && !/^no changes\.?$/i.test(x.line.trim()));
const unchanged = apps.filter(a => !changed.some(c => c.a.id === a.id)).map(a => a.name);
const lines = [`*Funnel Watch #${no}* · ${fmt(date)}${diff.previous ? ` vs ${fmt(diff.previous)}` : ' (baseline)'}`];
if (A.headline) lines.push(A.headline);
if (changed.length) lines.push('', '*What changed*', ...changed.map(c => `• *${c.a.name}*: ${c.line}`));
if (unchanged.length && changed.length) lines.push(`• No changes: ${unchanged.join(', ')}`);
lines.push('', 'Full report with side-by-side screens: download the HTML file below and open it in a browser.');

const buf = fs.readFileSync(file);
const name = `funnel-watch-${date}.html`;
const up = await api('files.getUploadURLExternal', { filename: name, length: String(buf.length) });
const put = await fetch(up.upload_url, { method: 'POST', body: buf });
if (!put.ok) throw new Error('upload failed ' + put.status);
await api('files.completeUploadExternal', { files: [{ id: up.file_id, title: `Funnel Watch #${no} — ${fmt(date)}` }], channel_id: channel, initial_comment: lines.join('\n') }, false);
console.log('posted to', channel);
