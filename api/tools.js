// /api/tools.js
// Combined utility endpoint. Three unrelated helpers share one serverless function
// (to stay under the deployment function limit); each is selected by ?action=.
// Their original paths (/api/geocode, /api/send-csv, /api/rental-sheet) still work
// via rewrites in vercel.json, so no caller — app or external cron — has to change.
//
//   action=geocode       GET  ?lat&lon          -> reverse-geocode (signed-in user)
//   action=send-csv      POST { to, subject, filename, csv, html } (signed-in user)
//   action=rental-sheet  GET  ?secret=CRON_SECRET -> weekly ledger CSV email (cron)
//
// Env: SUPA_URL, SUPA_KEY, SUPA_SERVICE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CRON_SECRET.

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const RECIPIENTS = ['banff1997@gmail.com', 'eldarealtor@gmail.com'];
const INCOME_CATS = ['Rent', 'Other income'];

// ── shared helpers ──────────────────────────────────────────────────────────
function supaHeaders(extra) {
  return Object.assign({ apikey: SUPA_SERVICE_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, extra || {});
}
async function supaGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return []; }
}
async function verifyUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
  if (!token || token === SUPA_KEY) return false;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (e) { return false; }
}
function authorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  const hdr = req.headers['x-cron-secret'];
  const auth = req.headers['authorization'] || '';
  const qs = (req.query && req.query.secret) || '';
  return !!(secret && (qs === secret || hdr === secret || auth === secret || auth === ('Bearer ' + secret)));
}
async function getAccessToken(rec) {
  let at = rec.access_token;
  if (!at || Date.now() >= (rec.expires_at - 60000)) {
    if (!rec.refresh_token) return { error: 'no refresh token' };
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: rec.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }).toString()
    });
    const nt = await rr.json();
    if (nt.error) return { error: nt.error_description || nt.error };
    at = nt.access_token; rec.access_token = at; rec.expires_at = Date.now() + ((nt.expires_in || 3600) * 1000);
    await fetch(SUPA_URL + '/rest/v1/gmail_tokens', { method: 'POST', headers: supaHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify([rec]) });
  }
  return { accessToken: at };
}
function encodeSubject(s) { s = String(s || ''); return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
async function sendCsvAttachment(token, toArr, subject, html, filename, csv) {
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

// ── action: geocode ─────────────────────────────────────────────────────────
async function doGeocode(req, res) {
  if (!(await verifyUser(req))) return res.status(401).json({ error: 'Sign in required.' });
  const lat = (req.query && req.query.lat) || (req.body && req.body.lat);
  const lon = (req.query && req.query.lon) || (req.body && req.body.lon);
  const nlat = parseFloat(lat), nlon = parseFloat(lon);
  if (isNaN(nlat) || isNaN(nlon) || nlat < -90 || nlat > 90 || nlon < -180 || nlon > 180) {
    return res.status(400).json({ error: 'Valid lat and lon are required.' });
  }
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=' + nlat + '&lon=' + nlon;
    const r = await fetch(url, { headers: { 'User-Agent': 'ProperlyCRM/1.0 (+https://properly-crm.vercel.app)', 'Accept': 'application/json' } });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: 'Geocoder error (' + r.status + '): ' + t.substring(0, 120) }); }
    const d = await r.json();
    const a = d.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
    const state = a.state || '';
    const zip = a.postcode || '';
    const address = [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return res.status(200).json({ address: address || d.display_name || '', street: street, city: city, state: state, zip: zip, lat: nlat, lon: nlon, display: d.display_name || '' });
  } catch (e) {
    return res.status(500).json({ error: 'Reverse geocode failed: ' + (e && e.message || e) });
  }
}

// ── action: send-csv ────────────────────────────────────────────────────────
async function doSendCsv(req, res) {
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
    const sent = await sendCsvAttachment(at.accessToken, to, b.subject || 'Export', b.html || '', b.filename || 'export.csv', String(b.csv));
    if (sent.error) return res.status(400).json({ error: sent.error });
    return res.status(200).json({ ok: true, sent_to: to });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── action: rental-sheet (cron) ─────────────────────────────────────────────
function csvCell(v) { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? ('"' + v.replace(/"/g, '""') + '"') : v; }
function money(n) { n = parseFloat(n) || 0; return n.toFixed(2); }
function dirFor(cat, dir) { return dir || (INCOME_CATS.indexOf(cat) >= 0 ? 'income' : 'expense'); }
async function doRentalSheet(req, res) {
  if (!authorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [props, units, hoas, ledger, tokens] = await Promise.all([
      supaGet('inv_properties?select=*'),
      supaGet('inv_units?select=*'),
      supaGet('inv_hoa?select=*'),
      supaGet('inv_ledger?select=*&order=date.asc,id.asc'),
      supaGet('gmail_tokens?select=*')
    ]);
    const propById = {}; (props || []).forEach(p => propById[String(p.id)] = p);
    const unitById = {}; (units || []).forEach(u => unitById[String(u.id)] = u);
    const hoaById = {}; (hoas || []).forEach(h => hoaById[String(h.id)] = h);

    const header = ['Date', 'Property', 'Unit', 'HOA', 'Category', 'Direction', 'Amount', 'Payee', 'Source', 'Notes'];
    const rows = [header.join(',')];
    (ledger || []).forEach(l => {
      const p = l.property_id != null ? propById[String(l.property_id)] : null;
      const u = l.unit_id != null ? unitById[String(l.unit_id)] : null;
      const h = l.hoa_id != null ? hoaById[String(l.hoa_id)] : null;
      rows.push([
        csvCell(l.date), csvCell(p ? (p.name || p.address) : ''), csvCell(u ? u.label : ''), csvCell(h ? h.name : ''),
        csvCell(l.category), csvCell(dirFor(l.category, l.direction)), money(l.amount), csvCell(l.payee), csvCell(l.source), csvCell(l.notes)
      ].join(','));
    });
    const csv = rows.join('\r\n');

    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const yr = String(now.getFullYear());
    let mi = 0, me = 0, yi = 0, ye = 0;
    (ledger || []).forEach(l => {
      const amt = parseFloat(l.amount) || 0; const d = dirFor(l.category, l.direction); const dt = (l.date || '');
      if (dt.slice(0, 7) === ym) { if (d === 'income') mi += amt; else me += amt; }
      if (dt.slice(0, 4) === yr) { if (d === 'income') yi += amt; else ye += amt; }
    });
    const fmt = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dateLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const html = '<div style="font-family:Arial,sans-serif;color:#1a1a1a;">'
      + '<h2 style="margin:0 0 6px;">Rental Portfolio — Weekly Ledger</h2>'
      + '<div style="color:#666;margin-bottom:14px;">' + dateLabel + '</div>'
      + '<table style="border-collapse:collapse;font-size:14px;">'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">This month income</td><td style="padding:3px 0;font-weight:700;color:#1a7f37;">' + fmt(mi) + '</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">This month expenses</td><td style="padding:3px 0;font-weight:700;color:#b3261e;">' + fmt(me) + '</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">This month net</td><td style="padding:3px 0;font-weight:700;">' + fmt(mi - me) + '</td></tr>'
      + '<tr><td colspan="2" style="height:8px;"></td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">YTD income</td><td style="padding:3px 0;font-weight:700;color:#1a7f37;">' + fmt(yi) + '</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">YTD expenses</td><td style="padding:3px 0;font-weight:700;color:#b3261e;">' + fmt(ye) + '</td></tr>'
      + '<tr><td style="padding:3px 14px 3px 0;color:#666;">YTD net</td><td style="padding:3px 0;font-weight:700;">' + fmt(yi - ye) + '</td></tr>'
      + '</table>'
      + '<p style="color:#666;font-size:13px;margin-top:16px;">Full ledger attached as a CSV (' + ((ledger || []).length) + ' entries). Open it in Excel or Google Sheets and sort on any column.</p>'
      + '</div>';

    if (!Array.isArray(tokens) || !tokens.length) return res.status(200).json({ ok: false, error: 'no gmail sender connected' });
    const at = await getAccessToken(tokens[0]);
    if (at.error) return res.status(200).json({ ok: false, error: at.error });
    const filename = 'rental-ledger-' + now.toISOString().slice(0, 10) + '.csv';
    const subject = 'Rental Portfolio Ledger — ' + dateLabel;
    const sent = await sendCsvAttachment(at.accessToken, RECIPIENTS, subject, html, filename, csv);
    if (sent.error) return res.status(200).json({ ok: false, error: sent.error });
    return res.status(200).json({ ok: true, entries: (ledger || []).length, sent_to: RECIPIENTS });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';
  if (action === 'geocode') return doGeocode(req, res);
  if (action === 'send-csv') return doSendCsv(req, res);
  if (action === 'rental-sheet') return doRentalSheet(req, res);
  return res.status(404).json({ error: 'Unknown tool action.' });
}
