// /api/scan-rentals.js
// Cron endpoint: reads connected Gmail inboxes for rental/HOA/mortgage emails, extracts money
// events with Gemini, dedupes against inv_ledger by content, and auto-inserts new ones
// (source='auto'). No browser needed. Schedule 3x/day via cron-jobs.org with ?secret=CRON_SECRET.
//
// Env: SUPA_URL, SUPA_SERVICE_KEY (or SUPA_KEY), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//      GEMINI_API_KEY, CRON_SECRET.

export const config = { api: { bodyParser: false } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || '';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const INCOME_CATS = ['Rent', 'Other income'];
const EXPENSE_CATS = ['Mortgage', 'HOA', 'Utilities', 'Insurance', 'Property Tax', 'Repairs', 'Management', 'Other'];

function supaHeaders(extra) {
  return Object.assign({ apikey: SUPA_SERVICE_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, extra || {});
}
async function supaGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return []; }
}
async function supaInsertOne(table, row) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + table, { method: 'POST', headers: supaHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify([row]) });
  return r.ok;   // unique index on email_ref rejects a dup with 409 -> ok=false, which we ignore
}
async function getAccessToken(memberId, rec) {
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
function b64urlDecode(s) { try { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } }
function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) { if (p.mimeType === 'text/plain' && p.body && p.body.data) return b64urlDecode(p.body.data); }
    let acc = ''; for (const p of payload.parts) { acc += extractText(p) + '\n'; } return acc;
  }
  if (payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  return '';
}
async function gmailList(token, query) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=40&q=' + encodeURIComponent(query), { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json(); return (d.messages || []);
}
async function gmailGet(token, id) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=full', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  const hs = (d.payload && d.payload.headers) || [];
  const h = (n) => { const x = hs.find(z => z.name.toLowerCase() === n.toLowerCase()); return x ? x.value : ''; };
  return { subject: h('Subject'), from: h('From'), date: h('Date'), text: extractText(d.payload) };
}
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function normCat(c) {
  c = String(c || '').trim().toLowerCase();
  const all = INCOME_CATS.concat(EXPENSE_CATS);
  for (const a of all) if (a.toLowerCase() === c) return a;
  if (c.indexOf('rent') >= 0) return 'Rent';
  if (c.indexOf('hoa') >= 0 || c.indexOf('associ') >= 0) return 'HOA';
  if (c.indexOf('mort') >= 0 || c.indexOf('loan') >= 0) return 'Mortgage';
  if (c.indexOf('util') >= 0 || c.indexOf('electric') >= 0 || c.indexOf('water') >= 0 || c.indexOf('gas') >= 0) return 'Utilities';
  if (c.indexOf('insur') >= 0) return 'Insurance';
  if (c.indexOf('tax') >= 0) return 'Property Tax';
  if (c.indexOf('repair') >= 0 || c.indexOf('mainten') >= 0) return 'Repairs';
  if (c.indexOf('manage') >= 0) return 'Management';
  return 'Other';
}
function dirFor(cat) { return INCOME_CATS.indexOf(cat) >= 0 ? 'income' : 'expense'; }
function matchProp(text, props) {
  text = String(text || '').toLowerCase(); if (!text) return null;
  for (const p of props) {
    if (p.name && text.indexOf(String(p.name).toLowerCase()) >= 0) return p;
    if (p.address && (text.indexOf(String(p.address).toLowerCase()) >= 0 || String(p.address).toLowerCase().indexOf(text) >= 0)) return p;
  }
  return null;
}
function eref(o) { return [(o.date || ''), num(o.amount), (o.category || ''), (o.property_id || '')].join('|'); }
function parseArr(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const a = txt.indexOf('['), b = txt.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch (e) {} }
  return null;
}
function financeQuery(props) {
  const terms = ['rent', 'HOA', '"homeowners association"', 'mortgage', '"mortgage statement"', 'statement', 'payment', 'invoice', 'utility', 'utilities', 'insurance', 'escrow', '"property tax"'];
  props.forEach(p => { if (p.address) terms.push('"' + String(p.address).replace(/"/g, '') + '"'); if (p.name) terms.push('"' + String(p.name).replace(/"/g, '') + '"'); });
  return '(' + terms.join(' OR ') + ') newer_than:14d';   // rolling window; content-dedupe handles overlap
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
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  const result = { scanned: 0, added: 0, skipped: 0, errors: [] };
  try {
    const props = await supaGet('inv_properties?select=*');
    if (!Array.isArray(props) || !props.length) return res.status(200).json({ ok: true, note: 'no properties', ...result });
    const ledger = await supaGet('inv_ledger?select=id,date,amount,category,property_id,email_ref');
    const seen = {};
    (ledger || []).forEach(l => { if (l.email_ref) seen[l.email_ref] = true; seen[eref(l)] = true; });

    const tokens = await supaGet('gmail_tokens?select=*');
    if (!Array.isArray(tokens) || !tokens.length) return res.status(200).json({ ok: true, note: 'no gmail connected', ...result });

    const query = financeQuery(props);
    const chunks = [];
    for (const rec of tokens) {
      const at = await getAccessToken(rec.member_id, rec);
      if (at.error) { result.errors.push('member ' + rec.member_id + ': ' + at.error); continue; }
      let msgs = [];
      try { msgs = await gmailList(at.accessToken, query); } catch (e) { result.errors.push('list: ' + e.message); continue; }
      const ids = msgs.slice(0, 25).map(m => m.id);
      for (const id of ids) {
        try {
          const m = await gmailGet(at.accessToken, id);
          const t = (m.text || '').replace(/\r/g, '').trim(); if (!t) continue;
          result.scanned++;
          chunks.push('From: ' + m.from + ' | Date: ' + m.date + ' | Subject: ' + m.subject + '\n' + t.slice(0, 1500));
        } catch (e) {}
      }
    }
    const corpus = chunks.join('\n\n---\n\n').slice(0, 22000);
    if (!corpus) return res.status(200).json({ ok: true, note: 'no finance emails in window', ...result });

    const propList = props.map(p => (p.name || '') + (p.address ? (' (' + p.address + ')') : '')).join('; ');
    const prompt = 'You are a bookkeeping assistant for a small rental-property owner. From the emails below, extract EVERY concrete money event (rent received, HOA dues, mortgage payment, utility/insurance/tax bill, repair, management fee). '
      + 'Return ONLY a JSON array, no prose. Each item: {"date":"YYYY-MM-DD","amount": number (no symbols),"direction":"income|expense","category":"Rent|Other income|Mortgage|HOA|Utilities|Insurance|Property Tax|Repairs|Management|Other","property":"which property (address or name text, best guess, empty if unsure)","payee":"who paid or was paid","description":"short"}. '
      + 'IMPORTANT EXCLUSION: do NOT include net owner disbursements / "Payment Confirmation" / "Owner Draw" / "electronic payment ... has been issued" emails from Fresh Start Management or managebuilding.com - that rent is recorded separately, per property, from the monthly owner statements. DO still include HOA auto-drafts, mortgage payments, utility/insurance/tax bills, repairs, and Sun Key Realty rental payments. '
      + 'Only include events with a clear dollar amount and date. Rent is income; everything else is an expense. Known properties: ' + propList + '.\n\nEMAILS:\n' + corpus;

    let items = null;
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' } })
      });
      const d = await r.json();
      const txt = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] ? d.candidates[0].content.parts[0].text : '';
      items = parseArr(txt || '');
    } catch (e) { result.errors.push('gemini: ' + e.message); }
    if (!Array.isArray(items)) return res.status(200).json({ ok: true, note: 'no entries extracted', ...result });

    let counter = 0;
    for (const it of items) {
      const cat = normCat(it.category);
      const amt = num(it.amount);
      if (amt <= 0) continue;
      const prop = matchProp(it.property, props);
      const key = eref({ date: it.date || '', amount: amt, category: cat, property_id: prop ? prop.id : '' });
      if (seen[key]) { result.skipped++; continue; }
      seen[key] = true;
      const row = {
        id: Date.now() * 1000 + (counter++),
        date: (it.date || new Date().toISOString().slice(0, 10)),
        property_id: prop ? prop.id : null,
        unit_id: null, hoa_id: null,
        category: cat, direction: dirFor(cat), amount: amt,
        payee: (it.payee || '').toString().slice(0, 200),
        method: null, source: 'auto', email_ref: key,
        notes: (it.description || '').toString().slice(0, 300)
      };
      const ok = await supaInsertOne('inv_ledger', row);
      if (ok) result.added++; else result.skipped++;
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message, ...result });
  }
}
