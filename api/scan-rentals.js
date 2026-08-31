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
async function gmailGetAttachment(token, msgId, attId) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgId + '/attachments/' + attId, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  return d.data ? String(d.data).replace(/-/g, '+').replace(/_/g, '/') : '';   // base64url -> base64
}
// Hand the owner-statement PDF straight to Gemini (reads text-based OR scanned PDFs natively - no
// separate OCR). Returns one object per property with its figures.
async function geminiReadStatementPdf(b64pdf, propList) {
  const prompt = 'This PDF is a monthly rental owner statement. It may cover one property with multiple units (e.g. Upstairs / Downstairs) and/or several properties. Return ONE object per property-unit line item. '
    + 'Return ONLY a JSON array: [{"property":"<address or name exactly as printed>","unit":"<unit label if the statement distinguishes one, e.g. Upstairs / Downstairs / a unit number; empty string if it does not>","rent":<gross monthly rent, number>,"management":<management fee, number>,"parking":<parking or other income, number or 0>,"repairs":[{"desc":"<short label>","amount":<number>}],"deposit":<net amount deposited to the owner, number>}]. '
    + 'Use 0 when a value is absent and [] when there are no repair/maintenance line items. Known properties: ' + propList + '.';
  const body = { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'application/pdf', data: b64pdf } }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json' } };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  const txt = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] ? d.candidates[0].content.parts[0].text : '';
  return parseArr(txt || '') || [];
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
function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function _streetNum(s) { const m = _norm(s).match(/\b(\d{2,6})\b/); return m ? m[1] : ''; }
// Forgiving property match: normalized substring either direction (so "4704 S 700 E #9" matches
// "4704 South 700 East Unit 9"), else a shared street number when it points to exactly one property.
function matchProp(text, props) {
  const t = _norm(text); if (!t) return null;
  for (const p of props) {
    const a = _norm(p.address), n = _norm(p.name);
    if (a && (t.indexOf(a) >= 0 || a.indexOf(t) >= 0)) return p;
    if (n && (t.indexOf(n) >= 0 || n.indexOf(t) >= 0)) return p;
  }
  const sn = _streetNum(text);
  if (sn) { const hits = props.filter(p => _streetNum(p.address) === sn || _streetNum(p.name) === sn); if (hits.length === 1) return hits[0]; }
  return null;
}
// Match a statement line to a unit WITHIN its property. One unit -> unambiguous. Otherwise match the
// printed unit text against the unit label, with upstairs/downstairs (and unit-number) synonyms.
function matchUnit(prop, unitText, units) {
  const mine = units.filter(u => String(u.property_id) === String(prop.id));
  if (mine.length <= 1) return mine[0] || null;
  const t = _norm(unitText); if (!t) return null;
  for (const u of mine) { const lb = _norm(u.label); if (lb && (t.indexOf(lb) >= 0 || lb.indexOf(t) >= 0)) return u; }
  if (/\bup/.test(t)) { const u = mine.find(x => /up/.test(_norm(x.label))); if (u) return u; }
  if (/\b(down|lower)/.test(t)) { const u = mine.find(x => /down|lower/.test(_norm(x.label))); if (u) return u; }
  const un = (t.match(/\b(\d{1,4}[a-z]?)\b/) || [])[1];
  if (un) { const u = mine.find(x => _norm(x.label).split(' ').indexOf(un) >= 0); if (u) return u; }
  return null;
}
// A payee's match field may hold several alternatives separated by commas (or | or newlines), e.g.
// "@freshstartmgmt.com, fresh start, owner statement". Any one hit is enough.
function matchTerms(p) { return String(p.match || '').toLowerCase().split(/[,\n|]+/).map(s => s.trim()).filter(Boolean); }
// The editable whitelist: an email is eligible only if its From / subject / body contains one of an
// ACTIVE payee's match terms. Returns that payee (so we inherit its category / kind / property pin).
function payeeFor(fromField, bodyText, payees) {
  const hay = ((fromField || '') + ' \n ' + (bodyText || '')).toLowerCase();
  for (const p of payees) {
    if (p.active === false) continue;
    if (matchTerms(p).some(t => hay.indexOf(t) >= 0)) return p;
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
  payees.forEach(p => { if (p.active !== false) matchTerms(p).forEach(m0 => { const m = m0.replace(/"/g, ''); terms.push('from:"' + m + '"'); terms.push('"' + m + '"'); }); });
  if (!terms.length) return null;
  return '(' + terms.join(' OR ') + ') newer_than:45d';
}
const SUPA_ANON = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
function cronOk(req) {
  const secret = process.env.CRON_SECRET;
  const hdr = req.headers['x-cron-secret'];
  const auth = req.headers['authorization'] || '';
  const qs = (req.query && req.query.secret) || '';
  return !!(secret && (qs === secret || hdr === secret || auth === secret || auth === ('Bearer ' + secret)));
}
// The in-app "Scan email" button triggers this with the signed-in user's session token.
async function userOk(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : '';
  if (!token || token === SUPA_ANON || token === process.env.CRON_SECRET) return false;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_ANON, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (e) { return false; }
}
async function authorized(req) { return (cronOk(req) || (await userOk(req))); }

export default async function handler(req, res) {
  if (!(await authorized(req))) return res.status(401).json({ error: 'Unauthorized' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  const result = { mailbox: RENTAL_MAILBOX, scanned: 0, added: 0, skipped: 0, unmatched: 0, freshStartPending: 0, errors: [],
    recorded: [], ignored: [], noPdf: [] };   // review details (from/subject) for the in-app triage view
  const brief = (m, extra) => Object.assign({ from: m.from || '', subject: m.subject || '', date: m.received || '' }, extra || {});
  try {
    const [props, units, payees, ledger, tokens] = await Promise.all([
      supaGet('inv_properties?select=*'),
      supaGet('inv_units?select=*'),
      supaGet('inv_payees?select=*'),
      supaGet('inv_ledger?select=id,email_ref,message_id'),
      supaGet('gmail_tokens?select=*')
    ]);
    if (!Array.isArray(payees) || !payees.filter(p => p.active !== false).length) {
      return res.status(200).json({ ok: true, note: 'no active approved payees - nothing is booked until you add some', ...result });
    }
    const seen = {}, processedMsg = {};
    (ledger || []).forEach(l => { if (l.email_ref) seen[l.email_ref] = true; if (l.message_id) processedMsg[l.message_id] = true; });

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
    const rentJobs = [];      // { msg, payee, pdf }
    for (const mref of msgs.slice(0, 40)) {
      let m; try { m = await gmailGet(at.accessToken, mref.id); } catch (e) { continue; }
      result.scanned++;
      const payee = payeeFor(m.from, (m.subject || '') + ' \n ' + m.text, payees);
      if (!payee) { result.unmatched++; if (result.ignored.length < 100) result.ignored.push(brief(m)); continue; }   // not an approved sender
      if (payee.kind === 'rent') {
        // Fresh Start rent statement: the money is split per property from the attached PDF.
        if (processedMsg[m.messageId]) { result.skipped++; if (result.recorded.length < 100) result.recorded.push(brief(m, { payee: payee.name })); continue; }
        const pdf = (m.attachments || []).find(a => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename || ''));
        if (!pdf) { result.freshStartPending++; if (result.noPdf.length < 100) result.noPdf.push(brief(m, { payee: payee.name })); continue; }
        rentJobs.push({ msg: m, payee: payee, pdf: pdf });
        continue;
      }
      if (seen[m.messageId]) { result.skipped++; if (result.recorded.length < 100) result.recorded.push(brief(m, { payee: payee.name })); continue; }   // already booked
      const prop = payee.property_id != null ? props.find(p => String(p.id) === String(payee.property_id)) : matchProp((m.subject || '') + ' ' + m.text, props);
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

    // ---- Fresh Start owner statements: read the attached PDF and split per property. ----
    const propList = props.map(p => (p.name || '') + (p.address ? (' (' + p.address + ')') : '')).join('; ');
    for (const j of rentJobs) {
      let b64 = '';
      try { b64 = await gmailGetAttachment(at.accessToken, j.msg.gmailId, j.pdf.attachmentId); } catch (e) { result.errors.push('attach: ' + e.message); }
      if (!b64) { result.errors.push('empty PDF for ' + j.msg.messageId); continue; }
      let statement = [];
      try { statement = await geminiReadStatementPdf(b64, propList); } catch (e) { result.errors.push('pdf-gemini: ' + e.message); }
      if (!Array.isArray(statement) || !statement.length) { result.freshStartPending++; continue; }
      let slotN = 0;
      const post = async (pid, uid, hoaId, cat, dir, amt, note, slot) => {
        if (num(amt) <= 0) return;
        const ref = j.msg.messageId + ':' + pid + ':' + (uid || '') + '|' + slot;   // unit in the key so up/down rows don't collide
        if (seen[ref]) { result.skipped++; return; }
        const row = {
          id: Date.now() * 1000 + (slotN++),
          date: j.msg.received || new Date().toISOString().slice(0, 10),
          property_id: pid, unit_id: uid || null, hoa_id: hoaId || null,
          category: cat, direction: dir, amount: num(amt),
          payee: (j.payee.name || 'Rental manager').slice(0, 200),
          method: null, source: 'email',
          email_ref: ref, message_id: j.msg.messageId,
          received_date: j.msg.received || null, due_date: null,
          notes: (note || '').slice(0, 300)
        };
        seen[ref] = true;
        const ok = await supaInsertOne('inv_ledger', row);
        if (ok) result.added++; else result.skipped++;
      };
      for (const sp of statement) {
        const prop = matchProp(sp.property, props);
        if (!prop) { result.unmatched++; continue; }                       // don't post blank/unmatched rows
        const unit = matchUnit(prop, sp.unit, units);
        const pid = prop.id, uid = unit ? unit.id : null, hoaId = prop.hoa_id;
        const ul = unit ? (' (' + (unit.label || '') + ')') : '';           // show which unit on the row
        const rent = num(sp.rent), mgmt = num(sp.management), parking = num(sp.parking), deposit = num(sp.deposit);
        await post(pid, uid, null, 'Rent', 'income', rent, 'Rent — statement' + ul, 'rent');
        if (parking > 0) {
          await post(pid, uid, null, 'Other income', 'income', parking, ((j.payee.name || '') + ' parking' + ul), 'parking');
          await post(pid, uid, hoaId, 'HOA', 'expense', parking, 'Parking pass-through to HOA' + ul, 'hoa_pass');
        }
        await post(pid, uid, null, 'Management', 'expense', mgmt, 'Management fee — statement' + ul, 'mgmt');
        // Repairs: prefer the PDF's own line items; otherwise derive the shortfall from the
        // statement's own numbers (rent + parking - mgmt - deposit) so the ledger reconciles.
        const items = Array.isArray(sp.repairs) ? sp.repairs.filter(x => num(x && x.amount) > 0) : [];
        let repTotal = items.reduce((s, x) => s + num(x.amount), 0);
        let repNote = items.map(x => (x.desc || 'repair') + ' ' + num(x.amount)).join('; ');
        if (repTotal <= 0 && deposit > 0) {
          const implied = Math.round((rent + parking - mgmt - deposit) * 100) / 100;
          if (implied > 1) { repTotal = implied; repNote = 'Deposit shortfall (unitemized)'; }
        }
        await post(pid, uid, null, 'Repairs', 'expense', repTotal, (repNote || 'Repairs — statement') + ul, 'repairs');
      }
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message, ...result });
  }
}
