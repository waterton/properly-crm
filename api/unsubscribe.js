// /api/unsubscribe.js
// Public, no-login endpoint a drip recipient hits from the "Unsubscribe" link in
// a marketing email. The link carries the contact id plus a signed token so one
// recipient can't unsubscribe another by guessing ids. On a valid hit we record
// the opt-out and stop any active drip enrollments for that contact, then show a
// simple confirmation page.
//
// The matching link is built in api/run-drips.js with the SAME secret + scheme.

import crypto from 'crypto';

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;

// Secret for signing unsubscribe tokens. Server-only (never shipped to the
// browser); defaults to the service key so no new env var is required.
const UNSUB_SECRET = process.env.UNSUB_SECRET || SUPA_SERVICE_KEY;

function unsubToken(contactId) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update('unsub:' + String(contactId)).digest('hex').slice(0, 32);
}

function supaHeaders(extra) {
  return Object.assign({
    'apikey': SUPA_SERVICE_KEY,
    'Authorization': 'Bearer ' + SUPA_SERVICE_KEY,
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
async function supaPatch(path, patch) {
  return fetch(SUPA_URL + '/rest/v1/' + path, {
    method: 'PATCH',
    headers: supaHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch)
  });
}

function page(title, body) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + title + '</title></head>'
    + '<body style="font-family:-apple-system,\'Segoe UI\',Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">'
    + '<div style="max-width:520px;margin:48px auto;background:#fff;border-radius:12px;padding:36px 32px;box-shadow:0 2px 14px rgba(0,0,0,0.08);text-align:center;">'
    + '<div style="color:#c9a84c;font-size:22px;font-weight:700;margin-bottom:12px;">Palacios Baker Real Estate</div>'
    + body
    + '</div></body></html>';
}

export default async function handler(req, res) {
  const q = req.query || {};
  const contactId = q.c != null ? String(q.c) : '';
  const token = q.t != null ? String(q.t) : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!contactId || !token || token !== unsubToken(contactId)) {
    return res.status(400).send(page('Unsubscribe',
      '<p style="color:#333;font-size:16px;">This unsubscribe link is invalid or incomplete. '
      + 'If you want to stop receiving our emails, just reply to one and let us know.</p>'));
  }

  try {
    // Look up the contact's email (best-effort, for the record + display).
    let email = '';
    try {
      const rows = await supaGet('contacts?id=eq.' + encodeURIComponent(contactId) + '&select=email&limit=1');
      if (Array.isArray(rows) && rows[0] && rows[0].email) email = rows[0].email;
    } catch (e) {}

    await supaUpsert('drip_unsubs', [{ contact_id: Number(contactId) || contactId, email: email, created_at: new Date().toISOString() }]);
    // Stop any active drip enrollments so nothing else goes out.
    await supaPatch('enrollments?contactId=eq.' + encodeURIComponent(contactId) + '&status=eq.active',
      { status: 'stopped', nextSendAt: null });

    return res.status(200).send(page('Unsubscribed',
      '<p style="color:#333;font-size:17px;margin-bottom:8px;">You\'re unsubscribed.</p>'
      + '<p style="color:#666;font-size:15px;">' + (email ? email.replace(/[<>&]/g, '') + ' ' : 'You ')
      + 'will no longer receive our marketing emails. It may take a moment to take effect. '
      + 'If this was a mistake, reply to any of our emails and we\'ll add you back.</p>'));
  } catch (e) {
    return res.status(500).send(page('Unsubscribe',
      '<p style="color:#333;font-size:16px;">Something went wrong on our end. '
      + 'Please reply to one of our emails to be removed, and we\'ll take care of it.</p>'));
  }
}
