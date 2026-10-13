// Uploads report-vocal.html and report-drawing.html to Slack as separate messages.
// Needs SLACK_BOT_TOKEN (scopes: files:write, chat:write) and SLACK_CHANNEL_ID
// (or SLACK_CHANNEL_VOCAL / SLACK_CHANNEL_DRAWING to send each topic to its own channel).
import fs from 'node:fs';
import path from 'node:path';
import { runDir, readJSON } from './lib.js';

const RUN = runDir();
const date = path.basename(RUN);
const TOKEN = process.env.SLACK_BOT_TOKEN;
if (!TOKEN) { console.log('SLACK_BOT_TOKEN not set — skipping Slack.'); process.exit(0); }

async function api(method, body, form = true) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json; charset=utf-8' }) },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
}

for (const topic of ['vocal', 'drawing']) {
  const file = path.join(RUN, `report-${topic}.html`);
  if (!fs.existsSync(file)) continue;
  const channel = process.env[`SLACK_CHANNEL_${topic.toUpperCase()}`] || process.env.SLACK_CHANNEL_ID;
  if (!channel) { console.log('No Slack channel set.'); break; }
  const buf = fs.readFileSync(file);
  const name = `${topic}-funnel-watch-${date}.html`;
  const up = await api('files.getUploadURLExternal', { filename: name, length: String(buf.length) });
  const put = await fetch(up.upload_url, { method: 'POST', body: buf });
  if (!put.ok) throw new Error('upload failed ' + put.status);
  const A = readJSON(path.join(RUN, `analysis-${topic}.json`), {});
  const lines = [`*${topic === 'vocal' ? 'Vocal' : 'Drawing'} competitor report — ${date}*`, 'Download the HTML file and open it in a browser.'];
  if (A.findings?.length) lines.push('', ...A.findings.slice(0, 3).map(f => '• ' + f));
  if (A.hypotheses?.length) lines.push('', `Top hypothesis: ${A.hypotheses[0].title}`);
  await api('files.completeUploadExternal', { files: [{ id: up.file_id, title: name }], channel_id: channel, initial_comment: lines.join('\n') }, false);
  console.log('posted', topic);
}
