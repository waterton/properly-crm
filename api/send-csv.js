// /api/send-csv.js
// On-demand: emails a CSV (built in the browser) as an attachment. Requires a signed-in CRM user
// (Supabase session bearer token). Sends via the first connected Gmail account.
//
// POST body: { to: ["a@b.com", ...], subject, filename, csv, html? }
// Env: SUPA_URL, SUPA_KEY, SUPA_SERVICE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

async function verifyUser(req) {
  var auth = req.headers['authorization'] || '';
  var token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
  if (!token || token === SUPA_KEY) return false;
  try {
    var r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    var u = await r.json();
    return !!(u && u.id);
  } catch (e) { return false; }
}
function supaHeaders() { return { apikey: SUPA_SERVICE_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }; }
async function supaGet(path) { const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() }); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return []; } }
async function getAccessToken(rec) {
  let at = rec.access_token;
  if (!at || Date.now() >= (rec.expires_at - 60000)) {
    if (!rec.refresh_token) return { error: 'no refresh token' };
    const rr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: rec.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }).toString() });
    const nt = await rr.json();
    if (nt.error) return { error: nt.error_description || nt.error };
    at = nt.access_token; rec.access_token = at; rec.expires_at = Date.now() + ((nt.expires_in || 3600) * 1000);
    await fetch(SUPA_URL + '/rest/v1/gmail_tokens', { method: 'POST', headers: Object.assign(supaHeaders(), { Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify([rec]) });
  }
  return { accessToken: at };
}
function encodeSubject(s) { s = String(s || ''); return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
async function sendCsv(token, toArr, subject, html, filename, csv) {
  const boundary = 'b_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const b64 = Buffer.from(csv, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    'To: ' + toArr.join(', '), 'Subject: ' + encodeSubject(subject), 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"', '',
    '--' + boundary, 'Content-Type: text/html; charset=utf-8', '', (html || 'Attached is your requested export.'), '',
    '--' + boundary, 'Content-Type: text/csv; charset=utf-8; name="' + filename + '"',
    'Content-Disposition: attachment; filename="' + filename + '"', 'Content-Transfer-Encoding: base64', '', b64, '',
    '--' + boundary + '--', ''
  ].join('\r\n');
  const raw = Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw }) });
  const data = await resp.json();
  if (data.error) return { error: data.error.message };
  return { messageId: data.id };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await verifyUser(req))) return res.status(401).json({ error: 'Sign in required.' });
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch (e) {} }
  const b = req.body || {};
  const to = Array.isArray(b.to) ? b.to.filter(function (x) { return x && x.indexOf('@') > 0; }) : [];
  if (!to.length) return res.status(400).json({ error: 'No valid recipients.' });
  if (!b.csv) return res.status(400).json({ error: 'No CSV content.' });
  try {
    const tokens = await supaGet('gmail_tokens?select=*');
    if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'No Gmail sender connected.' });
    const at = await getAccessToken(tokens[0]);
    if (at.error) return res.status(400).json({ error: at.error });
    const sent = await sendCsv(at.accessToken, to, b.subject || 'Export', b.html || '', b.filename || 'export.csv', String(b.csv));
    if (sent.error) return res.status(400).json({ error: sent.error });
    return res.status(200).json({ ok: true, sent_to: to });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
