// Reads verification codes from the test Gmail inbox over IMAP (app password in GMAIL_APP_PASSWORD).
// Only mail sent to one funnel's plus-address after `since` is considered, so codes never mix up.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sleep } from './lib.js';

const near = /(code|verif|confirm|otp|pin|one.?time|passcode)/i;

/** Picks the most likely code from an email's text: a 4–8 digit (or 6-char alnum) token near "code". */
export function extractCode(subject, text) {
  const t = `${subject || ''}\n${text || ''}`.replace(/\u00a0/g, ' ');
  const lines = t.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    if (!near.test(lines[i]) && !near.test(lines[i - 1] || '')) continue;
    const m = lines[i].match(/\b(\d{4,8})\b/) || (lines[i + 1] || '').match(/^\s*(\d{4,8})\s*$/) || lines[i].match(/\b([A-Z0-9]{6})\b/);
    if (m && !/^(19|20)\d{2}$/.test(m[1])) return m[1];
  }
  const solo = lines.map(l => l.trim()).find(l => /^\d{4,8}$/.test(l));
  return solo || null;
}

/** Polls the inbox (and Spam) for a code sent to `to` after `since`. Returns the code or null. */
export async function waitForCode(to, since, { timeoutMs = 120000 } = {}) {
  if (process.env.CODE_OVERRIDE) return process.env.CODE_OVERRIDE; // local tests
  const pass = process.env.GMAIL_APP_PASSWORD;
  const user = to.replace(/\+[^@]*@/, '@');
  if (!pass || !/@gmail\.com$/i.test(user)) return null;
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass: pass.replace(/\s+/g, '') }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    const names = [boxes.find(b => b.specialUse === '\\All')?.path || 'INBOX', boxes.find(b => b.specialUse === '\\Junk')?.path].filter(Boolean);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (const box of names) {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ gmraw: `to:${to} newer_than:1d` }, { uid: true });
          for (const uid of [...(uids || [])].reverse().slice(0, 5)) {
            const msg = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
            if (!msg || new Date(msg.internalDate).getTime() < since - 60000) continue;
            const mail = await simpleParser(msg.source);
            const code = extractCode(mail.subject, mail.text || (mail.html || '').replace(/<[^>]+>/g, '\n'));
            if (code) return code;
          }
        } finally { lock.release(); }
      }
      await sleep(8000);
    }
    return null;
  } finally { await client.logout().catch(() => {}); }
}
