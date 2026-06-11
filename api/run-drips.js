// /api/run-drips.js
// Server-side drip processor. Triggered by Vercel Cron (see vercel.json).
// Reads due enrollments from Supabase, sends the next email via Gmail
// (reusing the same token + refresh flow as gmail-api.js), then advances
// the enrollment and writes a send_log row. No browser needed.
//
// Security: requires header  x-cron-secret: <CRON_SECRET>  (set in Vercel env).
// Vercel Cron automatically sends Authorization: Bearer <CRON_SECRET> when
// CRON_SECRET is set, so we accept either that or the x-cron-secret header.

export const config = { api: { bodyParser: false } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AGENT_NAME = process.env.DRIP_AGENT_NAME || 'Randy Baker';
const DAY_MS = 86400000;

function supaHeaders(extra) {
  return Object.assign({
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }, extra || {});
}

async function supaGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return []; }
}

async function supaUpsert(table, rows) {
  return fetch(SUPA_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: supaHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows)
  });
}

function mergeTags(text, c) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{\s*first\s*\}\}/gi, (c && c.first) || 'there')
    .replace(/\{\{\s*last\s*\}\}/gi, (c && c.last) || '')
    .replace(/\{\{\s*property\s*\}\}/gi, (c && c.property) || 'your property search')
    .replace(/\{\{\s*price\s*\}\}/gi, (c && c.price) || '')
    .replace(/\{\{\s*agent\s*\}\}/gi, AGENT_NAME);
}

// Get a valid access token for a member, refreshing if needed. Mirrors gmail-api.js.
async function getAccessToken(memberId) {
  const rows = await supaGet('gmail_tokens?member_id=eq.' + encodeURIComponent(memberId));
  if (!Array.isArray(rows) || !rows[0]) return { error: 'Gmail not connected for member ' + memberId };
  let rec = rows[0];
  let accessToken = rec.access_token;
  if (!accessToken || Date.now() >= (rec.expires_at - 60000)) {
    if (!rec.refresh_token) return { error: 'No refresh token for member ' + memberId };
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: rec.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token'
      }).toString()
    });
    const nt = await rr.json();
    if (nt.error) return { error: 'Token refresh failed: ' + (nt.error_description || nt.error) };
    accessToken = nt.access_token;
    rec.access_token = accessToken;
    rec.expires_at = Date.now() + ((nt.expires_in || 3600) * 1000);
    await supaUpsert('gmail_tokens', [rec]);
  }
  return { accessToken: accessToken };
}

async function gmailSend(accessToken, to, subject, htmlBody) {
  const lines = [
    'To: ' + to,
    'Subject: ' + subject,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    htmlBody || ''
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw })
  });
  const data = await resp.json();
  if (data.error) return { error: data.error.message };
  return { messageId: data.id };
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // if no secret configured, allow (dev). Set CRON_SECRET in prod.
  const hdr = req.headers['x-cron-secret'];
  const auth = req.headers['authorization'] || '';
  return hdr === secret || auth === ('Bearer ' + secret);
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' });
  }

  const nowIso = new Date().toISOString();
  const summary = { checked: 0, sent: 0, failed: 0, completed: 0, skipped: 0, errors: [] };

  try {
    // Pull active, due enrollments
    const due = await supaGet(
      'enrollments?status=eq.active&nextSendAt=lte.' + encodeURIComponent(nowIso) + '&order=nextSendAt.asc&limit=100'
    );
    if (!Array.isArray(due) || !due.length) {
      return res.status(200).json({ ok: true, message: 'No due enrollments', summary });
    }

    // Cache campaigns + contacts + tokens to avoid refetching per row
    const campaigns = await supaGet('campaigns?limit=500');
    const campById = {};
    (campaigns || []).forEach(function (c) {
      if (typeof c.steps === 'string') { try { c.steps = JSON.parse(c.steps); } catch (e) { c.steps = []; } }
      if (!Array.isArray(c.steps)) c.steps = [];
      campById[String(c.id)] = c;
    });

    const tokenCache = {}; // memberId -> {accessToken} or {error}

    for (let i = 0; i < due.length; i++) {
      const enr = due[i];
      summary.checked++;
      const camp = campById[String(enr.campaignId)];
      if (!camp || !camp.steps.length) {
        enr.status = 'stopped'; enr.nextSendAt = null;
        await supaUpsert('enrollments', [enr]); summary.skipped++; continue;
      }
      const step = camp.steps[enr.stepIndex];
      if (!step) {
        enr.status = 'completed'; enr.nextSendAt = null;
        await supaUpsert('enrollments', [enr]); summary.completed++; continue;
      }

      // Look up the contact
      const contacts = await supaGet('contacts?id=eq.' + encodeURIComponent(enr.contactId) + '&limit=1');
      const c = (Array.isArray(contacts) && contacts[0]) ? contacts[0] : null;
      const to = c && c.email ? c.email : '';

      const logBase = {
        id: Date.now() + Math.floor(Math.random() * 100000) + i,
        enrollmentId: enr.id, campaignId: camp.id, contactId: enr.contactId,
        stepIndex: enr.stepIndex, subject: '', to: to, status: 'pending',
        sentAt: null, error: '', created_at: new Date().toISOString()
      };

      if (!to) {
        logBase.status = 'failed'; logBase.error = 'No email on contact';
        await supaUpsert('send_log', [logBase]);
        enr.status = 'stopped'; enr.nextSendAt = null;
        await supaUpsert('enrollments', [enr]); summary.failed++;
        continue;
      }

      const memberId = enr.fromMemberId;
      if (!memberId) {
        logBase.status = 'queued'; logBase.error = 'No sending account on enrollment';
        await supaUpsert('send_log', [logBase]);
        // push 1 hour and retry later
        enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
        await supaUpsert('enrollments', [enr]); summary.skipped++;
        continue;
      }

      if (!tokenCache[memberId]) tokenCache[memberId] = await getAccessToken(memberId);
      const tok = tokenCache[memberId];
      if (tok.error) {
        logBase.status = 'queued'; logBase.error = tok.error;
        await supaUpsert('send_log', [logBase]);
        enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
        await supaUpsert('enrollments', [enr]); summary.skipped++;
        summary.errors.push(tok.error);
        continue;
      }

      const subject = mergeTags(step.subject, c);
      const htmlBody = mergeTags(step.body, c).replace(/\n/g, '<br>');
      logBase.subject = subject;

      const sent = await gmailSend(tok.accessToken, to, subject, htmlBody);
      if (sent.error) {
        logBase.status = 'failed'; logBase.error = sent.error;
        await supaUpsert('send_log', [logBase]);
        // retry in 1h rather than dropping
        enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
        await supaUpsert('enrollments', [enr]); summary.failed++;
        summary.errors.push(sent.error);
        continue;
      }

      // Success: log + advance enrollment
      logBase.status = 'sent'; logBase.sentAt = new Date().toISOString();
      await supaUpsert('send_log', [logBase]);

      // also drop a note on the contact
      await supaUpsert('notes', [{
        id: Date.now() + Math.floor(Math.random() * 100000),
        contactId: enr.contactId,
        text: 'Drip "' + camp.name + '" step ' + (enr.stepIndex + 1) + ' sent: ' + subject,
        date: new Date().toISOString()
      }]);

      enr.stepIndex = enr.stepIndex + 1;
      if (enr.stepIndex >= camp.steps.length) {
        enr.status = 'completed'; enr.nextSendAt = null;
        summary.completed++;
      } else {
        const nextDelay = parseInt(camp.steps[enr.stepIndex].delayDays) || 0;
        enr.nextSendAt = new Date(Date.now() + nextDelay * DAY_MS).toISOString();
      }
      await supaUpsert('enrollments', [enr]);
      summary.sent++;
    }

    return res.status(200).json({ ok: true, summary: summary });
  } catch (err) {
    return res.status(500).json({ error: err.message, summary: summary });
  }
}
