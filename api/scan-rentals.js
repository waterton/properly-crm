// /api/scan-rentals.js
// Cron endpoint: reads ONE mailbox (RENTAL_MAILBOX, default banff1997@gmail.com) for rental finance
// emails and books ledger rows ONLY from approved payees (the editable inv_payees whitelist). Every
// non-manual row persists its Gmail message-id and dedupes on it, so an email can never double-post,
// and personal receipts (Amazon, Google Play, ...) are ignored because they match no payee.
//
// Row rules (bulletproof, value-agnostic):
//   * A row is created only from an email that matches an ACTIVE approved payee, or by manual entry.
//   * expense payee  -> one expense row (category from the payee), stamped received_date + due_date.
//   * rent payee     -> handled by the Fresh Start PDF split (see freshStart* below); a lump rent
//                       email with no statement is left for manual review rather than guessed.
//   * dedupe key (email_ref) = message-id for a single-charge email, message-id + ':' + slot for a
//     multi-row statement, so the same email's several rows coexist but never duplicate on re-scan.
//
// Env: SUPA_URL, SUPA_SERVICE_KEY (or SUPA_KEY), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//      GEMINI_API_KEY, CRON_SECRET, RENTAL_MAILBOX (optional).

export const config = { api: { bodyParser: false } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || '';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const RENTAL_MAILBOX = (process.env.RENTAL_MAILBOX || 'banff1997@gmail.com').toLowerCase();

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
function collectAttachments(payload, out) {
  out = out || [];
  if (!payload) return out;
  if (payload.filename && payload.body && payload.body.attachmentId) {
    out.push({ filename: payload.filename, mimeType: payload.mimeType || '', attachmentId: payload.body.attachmentId, size: payload.body.size || 0 });
  }
  if (payload.parts) payload.parts.forEach(p => collectAttachments(p, out));
  return out;
}
async function getProfileEmail(token) {
  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json(); return (d.emailAddress || '').toLowerCase();
  } catch (e) { return ''; }
}
async function gmailList(token, query) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=' + encodeURIComponent(query), { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json(); return (d.messages || []);
}
async function gmailGet(token, id) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=full', { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  const hs = (d.payload && d.payload.headers) || [];
  const h = (n) => { const x = hs.find(z => z.name.toLowerCase() === n.toLowerCase()); return x ? x.value : ''; };
  const received = d.internalDate ? new Date(parseInt(d.internalDate, 10)).toISOString().slice(0, 10) : (h('Date') ? new Date(h('Date')).toISOString().slice(0, 10) : '');
  const midHeader = (h('Message-ID') || h('Message-Id') || '').replace(/[<>]/g, '').trim();
  return {
    gmailId: id, messageId: midHeader || ('gmail:' + id),
    subject: h('Subject'), from: h('From'), received: received,
    text: extractText(d.payload), attachments: collectAttachments(d.payload)
  };
}
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function normCat(c) {
  c = String(c || '').trim().toLowerCase();
  const all = INCOME_CATS.concat(EXPENSE_CATS);
  for (const a of all) if (a.toLowerCase() === c) return a;
  if (c.indexOf('rent') >= 0) return 'Rent';
  if (c.indexOf('hoa') >= 0 || c.indexOf('associ') >= 0) return 'HOA';
  if (c.indexOf('mort') >= 0 || c.indexOf('loan') >= 0) return 'Mortgage';
  if (c.indexOf('util') >= 0 || c.indexOf('electric') >= 0 || c.indexOf('water') >= 0 || c.indexOf('gas') >= 0 || c.indexOf('power') >= 0 || c.indexOf('energy') >= 0) return 'Utilities';
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
    if (p.address && text.indexOf(String(p.address).toLowerCase()) >= 0) return p;
    if (p.name && text.indexOf(String(p.name).toLowerCase()) >= 0) return p;
  }
  return null;
}
// The editable whitelist: an email is eligible only if its From or body contains an ACTIVE payee's
// match text. Returns that payee (so we inherit its category / kind / property pin) or null.
function payeeFor(fromField, bodyText, payees) {
  const hay = ((fromField || '') + ' \n ' + (bodyText || '')).toLowerCase();
  for (const p of payees) {
    if (p.active === false) continue;
    const m = String(p.match || '').toLowerCase().trim();
    if (m && hay.indexOf(m) >= 0) return p;
  }
  return null;
}
function parseArr(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const a = txt.indexOf('['), b = txt.lastIndexOf(']');
  if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch (e) {} }
  return null;
}
// Build the Gmail search from the whitelist itself, so we only pull mail from approved payees.
function payeeQuery(payees) {
  const terms = [];
  payees.forEach(p => { if (p.active !== false && p.match) { const m = String(p.match).replace(/"/g, ''); terms.push('from:"' + m + '"'); terms.push('"' + m + '"'); } });
  if (!terms.length) return null;
  return '(' + terms.join(' OR ') + ') newer_than:45d';
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
  const result = { mailbox: RENTAL_MAILBOX, scanned: 0, added: 0, skipped: 0, unmatched: 0, freshStartPending: 0, errors: [] };
  try {
    const [props, payees, ledger, tokens] = await Promise.all([
      supaGet('inv_properties?select=*'),
      supaGet('inv_payees?select=*'),
      supaGet('inv_ledger?select=id,email_ref,message_id'),
      supaGet('gmail_tokens?select=*')
    ]);
    if (!Array.isArray(payees) || !payees.filter(p => p.active !== false).length) {
      return res.status(200).json({ ok: true, note: 'no active approved payees - nothing is booked until you add some', ...result });
    }
    const seen = {};
    (ledger || []).forEach(l => { if (l.email_ref) seen[l.email_ref] = true; });

    // Pick the ONE approved mailbox. Prefer the stored email; fall back to the live profile.
    let rec = (tokens || []).find(t => String(t.email || '').toLowerCase() === RENTAL_MAILBOX);
    if (!rec) {
      for (const t of (tokens || [])) {
        const at0 = await getAccessToken(t);
        if (at0.error) continue;
        if ((await getProfileEmail(at0.accessToken)) === RENTAL_MAILBOX) { rec = t; break; }
      }
    }
    if (!rec) return res.status(200).json({ ok: true, note: 'mailbox ' + RENTAL_MAILBOX + ' is not connected', ...result });

    const at = await getAccessToken(rec);
    if (at.error) { result.errors.push(at.error); return res.status(200).json({ ok: false, ...result }); }

    const query = payeeQuery(payees);
    if (!query) return res.status(200).json({ ok: true, note: 'no payee match terms', ...result });

    let msgs = [];
    try { msgs = await gmailList(at.accessToken, query); } catch (e) { result.errors.push('list: ' + e.message); }
    const expenseJobs = [];   // { msg, payee, prop }
    for (const mref of msgs.slice(0, 40)) {
      let m; try { m = await gmailGet(at.accessToken, mref.id); } catch (e) { continue; }
      result.scanned++;
      if (seen[m.messageId]) { result.skipped++; continue; }              // already booked this email
      const payee = payeeFor(m.from, m.text, payees);
      if (!payee) { result.unmatched++; continue; }                        // not an approved sender -> ignore
      const prop = payee.property_id != null ? props.find(p => String(p.id) === String(payee.property_id)) : matchProp((m.subject || '') + ' ' + m.text, props);
      if (payee.kind === 'rent') {
        // Fresh Start rent statement: the money is split per property from the attached PDF.
        // That split is handled by the PDF reader (next step); flag it here rather than guess a lump.
        result.freshStartPending++;
        continue;
      }
      expenseJobs.push({ msg: m, payee: payee, prop: prop });
    }

    // Extract the primary charge (amount + due date) for the matched expense emails in one Gemini call.
    let extracted = [];
    if (expenseJobs.length) {
      const corpus = expenseJobs.map((j, i) => 'INDEX ' + i + ' | From: ' + j.msg.from + ' | Subject: ' + j.msg.subject + '\n' + (j.msg.text || '').replace(/\r/g, '').slice(0, 1200)).join('\n\n---\n\n').slice(0, 22000);
      const prompt = 'Each block below is a bill or payment notice from an approved payee. For each INDEX, extract the single primary charge. '
        + 'Return ONLY a JSON array: [{"i": <index number>, "amount": <number, no symbols>, "dueDate": "YYYY-MM-DD or empty", "category": "Utilities|HOA|Property Tax|Management|Insurance|Mortgage|Repairs|Other"}]. '
        + 'amount is the total amount due or charged. Omit an index only if there is no dollar amount at all.\n\n' + corpus;
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json' } })
        });
        const d = await r.json();
        const txt = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] ? d.candidates[0].content.parts[0].text : '';
        extracted = parseArr(txt || '') || [];
      } catch (e) { result.errors.push('gemini: ' + e.message); }
    }
    const byIndex = {}; extracted.forEach(x => { if (x && x.i != null) byIndex[x.i] = x; });

    let counter = 0;
    for (let i = 0; i < expenseJobs.length; i++) {
      const j = expenseJobs[i]; const ex = byIndex[i] || {};
      const amt = num(ex.amount);
      if (amt <= 0) { result.skipped++; continue; }
      const cat = ex.category ? normCat(ex.category) : normCat(j.payee.category || 'Other');
      const row = {
        id: Date.now() * 1000 + (counter++),
        date: j.msg.received || new Date().toISOString().slice(0, 10),
        property_id: j.prop ? j.prop.id : null,
        unit_id: null, hoa_id: null,
        category: cat, direction: 'expense', amount: amt,
        payee: (j.payee.name || '').toString().slice(0, 200),
        method: null, source: 'email',
        email_ref: j.msg.messageId, message_id: j.msg.messageId,
        received_date: j.msg.received || null,
        due_date: (ex.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(ex.dueDate)) ? ex.dueDate : null,
        notes: (j.msg.subject || '').toString().slice(0, 300)
      };
      seen[row.email_ref] = true;
      const ok = await supaInsertOne('inv_ledger', row);
      if (ok) result.added++; else result.skipped++;
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message, ...result });
  }
}
