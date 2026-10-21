// Posts the run's report.html to Slack as one message plus the HTML file, so people outside the org
// (Slack Connect) can download and open it. Message: title, Skillsta funnels (Amplitude), key findings,
// top hypotheses. Needs SLACK_BOT_TOKEN (scopes: files:write, chat:write). Channel: SLACK_CHANNEL_ID,
// else settings.slack_channel. DRY_RUN=1 prints the message instead of posting.
import fs from 'node:fs';
import path from 'node:path';
import { runDir, readJSON, loadConfig } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const DRY = !!process.env.DRY_RUN;
const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN && !DRY) { console.log('SLACK_BOT_TOKEN not set — skipping Slack.'); process.exit(0); }
const cfg = loadConfig();
const channel = process.env.SLACK_CHANNEL_ID || cfg.settings?.slack_channel;
if (!channel && !DRY) { console.log('No Slack channel set.'); process.exit(0); }

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
const fmt = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Skillsta funnels: starts → step-to-step conversion, like the report's Amplitude table.
const pct = (a, b) => { if (!b) return '—'; const v = a / b * 100; return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%'; };
const amp = (Array.isArray(A.amplitude) ? A.amplitude : A.amplitude ? [A.amplitude] : []).filter(F => F.steps?.length);
const ampLine = F => `• ${F.funnel}: ${F.steps[0].n.toLocaleString('en-US')} starts → ` + F.steps.slice(1).map((s, i) => `${s.label.toLowerCase()} ${pct(s.n, F.steps[i].n)}`).join(' → ');

const lines = [`*Competitor Funnel Watch #${no}* (run of ${fmt(date)}${diff.previous ? `, compared with ${fmt(diff.previous)}` : ''})`, '',
  'Full report with changed screens side by side, ads and paywalls: the HTML file below (open it in a browser).'];
if (amp.length) lines.push('', `*Skillsta funnels, ${amp[0].period} (Amplitude)*`, ...amp.map(ampLine));
const findings = A.findings || [];
if (findings.length) lines.push('', '*Key findings*', ...findings.map(f => `• ${f}`));
const ideas = (A.ideas || []).slice(0, 3);
if (ideas.length) lines.push('', '*Top hypotheses*', ...ideas.map((h, i) => `${i + 1}. ${typeof h === 'string' ? h : h.title}`));
const text = lines.join('\n');
if (DRY) { console.log(text); process.exit(0); }

const buf = fs.readFileSync(file);
const name = `funnel-watch-${date}.html`;
const up = await api('files.getUploadURLExternal', { filename: name, length: String(buf.length) });
const put = await fetch(up.upload_url, { method: 'POST', body: buf });
if (!put.ok) throw new Error('upload failed ' + put.status);
await api('files.completeUploadExternal', { files: [{ id: up.file_id, title: `Funnel Watch #${no} — ${fmt(date)}` }], channel_id: channel, initial_comment: text }, false);
console.log('posted to', channel);
