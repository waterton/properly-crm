// /api/rental-sheet.js
// Cron endpoint: builds a fresh CSV of the whole rental ledger and emails it (as an attachment)
// to the owners. Runs weekly via cron-jobs.org with ?secret=CRON_SECRET.
// The CSV opens in Excel/Google Sheets and is sortable on any column.
//
// Env: SUPA_URL, SUPA_SERVICE_KEY (or SUPA_KEY), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CRON_SECRET.

export const config = { api: { bodyParser: false } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || '';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const RECIPIENTS = ['banff1997@gmail.com', 'eldarealtor@gmail.com'];
const INCOME_CATS = ['Rent', 'Other income'];

function supaHeaders(extra) {
  return Object.assign({ apikey: SUPA_SERVICE_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, extra || {});
}
async function supaGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return []; }
}
async function getAccessToken(rec) {
  let accessToken = rec.access_token;
  if (!accessToken || Date.now() >= (rec.expires_at - 60000)) {
    if (!rec.refresh_token) return { error: 'no refresh token' };
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: rec.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }).toString()
    });
    const nt = await rr.json();
    if (nt.error) return { error: nt.error_description || nt.error };
    accessToken = nt.access_token;
    rec.access_token = accessToken; rec.expires_at = Date.now() + ((nt.expires_in || 3600) * 1000);
    await fetch(SUPA_URL + '/rest/v1/gmail_tokens', { method: 'POST', headers: supaHeaders({ Prefer: 'resolution=merge-duplicates' }), body: JSON.stringify([rec]) });
  }
  return { accessToken: accessToken };
}
function encodeSubject(s) { s = String(s || ''); return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function csvCell(v) { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? ('"' + v.replace(/"/g, '""') + '"') : v; }
function money(n) { n = parseFloat(n) || 0; return n.toFixed(2); }
function dirFor(cat, dir) { return dir || (INCOME_CATS.indexOf(cat) >= 0 ? 'income' : 'expense'); }

async function sendCsvEmail(token, toArr, subject, html, filename, csv) {
  const boundary = 'b_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const b64csv = Buffer.from(csv, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    'To: ' + toArr.join(', '),
    'Subject: ' + encodeSubject(subject),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    '--' + boundary,
    'Content-Type: text/csv; charset=utf-8; name="' + filename + '"',
    'Content-Disposition: attachment; filename="' + filename + '"',
    'Content-Transfer-Encoding: base64',
    '',
    b64csv,
    '',
    '--' + boundary + '--',
    ''
  ].join('\r\n');
  const raw = Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw })
  });
  const data = await resp.json();
  if (data.error) return { error: data.error.message };
  return { messageId: data.id };
}
async function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const hdr = req.headers['x-cron-secret'];
  const auth = req.headers['authorization'] || '';
  const qs = (req.query && req.query.secret) || '';
  if (secret && (qs === secret || hdr === secret || auth === secret || auth === ('Bearer ' + secret))) return true;
  return false;
}

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'Unauthorized' });
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

    // Build CSV
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

    // Summary (this month + YTD)
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
    const sent = await sendCsvEmail(at.accessToken, RECIPIENTS, subject, html, filename, csv);
    if (sent.error) return res.status(200).json({ ok: false, error: sent.error });
    return res.status(200).json({ ok: true, entries: (ledger || []).length, sent_to: RECIPIENTS });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
