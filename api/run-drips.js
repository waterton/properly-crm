// /api/run-drips.js
// Combined daily cron: processes drip enrollments + sends morning briefing.
// Triggered by Vercel Cron at 0 14 * * * (7am Mountain / 2pm UTC).
//
// Env vars required:
//   SUPA_URL, SUPA_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Optional:
//   CRON_SECRET       - security token Vercel sends automatically
//   DRIP_AGENT_NAME   - defaults to 'Randy Baker'
//   BRIEFING_EMAILS   - comma-separated recipient emails
//                       (defaults to all connected Gmail accounts)

export const config = { api: { bodyParser: false } };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AGENT_NAME = process.env.DRIP_AGENT_NAME || 'Randy Baker';
const DAY_MS = 86400000;

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
  return { accessToken: accessToken, email: rec.email, memberId: memberId };
}

// Subject headers must be RFC 2047 encoded or non-ASCII (Spanish accents) arrives mangled.
function encodeSubject(s) {
  s = String(s || '');
  return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

async function gmailSend(accessToken, to, subject, htmlBody, cc) {
  const lines = ['To: ' + to];
  if (cc) lines.push('Cc: ' + cc);
  lines.push(
    'Subject: ' + encodeSubject(subject),
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    htmlBody || ''
  );
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

function mergeTags(text, c) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{\s*first\s*\}\}/gi, (c && c.first) || 'there')
    .replace(/\{\{\s*last\s*\}\}/gi, (c && c.last) || '')
    .replace(/\{\{\s*property\s*\}\}/gi, (c && c.property) || 'your property search')
    .replace(/\{\{\s*price\s*\}\}/gi, (c && c.price) || '')
    .replace(/\{\{\s*agent\s*\}\}/gi, AGENT_NAME);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function todayMtn() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayMtn() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / DAY_MS);
}

function cName(c) {
  if (!c) return 'Unknown';
  return ((c.first || '') + ' ' + (c.last || '')).trim() || c.email || 'Unknown';
}

// ===================== TRANSACTION REMINDERS =====================
// Transactional, not marketing: no unsubscribe footer. One email per deadline,
// To: the client, Cc: the team - so you see the exact message the client got.

const DEADLINE_LABEL = {
  'Earnest Money Due':         { en: 'Earnest Money Due',         es: 'Depósito de garantía' },
  'Due Diligence Deadline':    { en: 'Due Diligence Deadline',    es: 'Fecha límite de diligencia debida' },
  'Financing Deadline':        { en: 'Financing Deadline',        es: 'Fecha límite de financiamiento' },
  'Appraisal Deadline':        { en: 'Appraisal Deadline',        es: 'Fecha límite de avalúo' },
  'Closing Date':              { en: 'Closing Date',              es: 'Fecha de cierre' },
  'Closing / Settlement Date': { en: 'Closing / Settlement Date', es: 'Fecha de cierre' },
  'Inspection Period Ends':    { en: 'Inspection Period Ends',    es: 'Fin del período de inspección' },
  'Financing Contingency':     { en: 'Financing Contingency',     es: 'Contingencia de financiamiento' },
  'Offer Expiration':          { en: 'Offer Expiration',          es: 'Vencimiento de la oferta' },
  'Final Walkthrough':         { en: 'Final Walkthrough',         es: 'Inspección final' },
  'Pre-Approval Expires':      { en: 'Pre-Approval Expires',      es: 'Vencimiento de la precalificación' }
};

function dlLabel(type, lang) {
  const m = DEADLINE_LABEL[type];
  if (m) return m[lang] || m.en;
  return type || (lang === 'es' ? 'Fecha límite' : 'Deadline');
}

function fmtDateLang(iso, lang) {
  if (!iso) return '-';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });
}

function whenPhrase(n, lang) {
  if (lang === 'es') return n === 0 ? 'hoy' : n === 1 ? 'mañana' : 'en ' + n + ' días';
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days';
}

function buildReminder(c, dl, tx, n) {
  const lang = (c && c.lang === 'es') ? 'es' : 'en';
  const label = dlLabel(dl.type, lang);
  const addr = (tx && tx.address) ? tx.address : ((c && c.property) || '');
  const when = whenPhrase(n, lang);
  const dateStr = fmtDateLang(dl.date, lang);
  const first = (c && c.first) || (lang === 'es' ? 'cliente' : 'there');
  if (lang === 'es') {
    return {
      lang: lang,
      subject: 'Recordatorio: ' + label + (addr ? ' - ' + addr : '') + ' (' + when + ')',
      body: '<p>Hola ' + first + ',</p>' +
            '<p>Un recordatorio de que <b>' + label + '</b>' + (addr ? ' para <b>' + addr + '</b>' : '') +
            ' es <b>' + when + '</b> (' + dateStr + ').</p>' +
            '<p>Si tiene alguna pregunta o necesita algo, simplemente responda a este correo.</p>' +
            '<p>' + AGENT_NAME + '<br>Palacios Baker Real Estate</p>'
    };
  }
  return {
    lang: lang,
    subject: 'Reminder: ' + label + (addr ? ' - ' + addr : '') + ' (' + when + ')',
    body: '<p>Hi ' + first + ',</p>' +
          '<p>A quick reminder that the <b>' + label + '</b>' + (addr ? ' for <b>' + addr + '</b>' : '') +
          ' is <b>' + when + '</b> (' + dateStr + ').</p>' +
          '<p>If you have any questions or need anything, just reply to this email.</p>' +
          '<p>' + AGENT_NAME + '<br>Palacios Baker Real Estate</p>'
  };
}

function contactEmails(c) {
  const out = [];
  if (!c) return out;
  if (c.email) out.push(c.email);
  let extra = c.emails;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch (e) { extra = []; } }
  if (Array.isArray(extra)) {
    extra.forEach(e => {
      const v = (e && e.value) ? e.value : e;
      if (v && typeof v === 'string' && out.indexOf(v) === -1) out.push(v);
    });
  }
  return out.filter(Boolean);
}

async function processReminders(result) {
  const settings = await supaGet('reminder_settings?limit=100');
  if (!Array.isArray(settings)) {
    result.reminders.errors.push('Could not read reminder_settings (check SUPA_SERVICE_KEY)');
    return;
  }
  const def = settings.find(s => !s.deadlineType) || { daysBefore: [3, 1], enabled: true };
  const byType = {};
  settings.forEach(s => { if (s.deadlineType) byType[s.deadlineType] = s; });

  let maxDays = 0;
  [def].concat(Object.keys(byType).map(k => byType[k])).forEach(s => {
    (s.daysBefore || []).forEach(d => { if (d > maxDays) maxDays = d; });
  });

  const today = todayMtn();
  const until = new Date(new Date(today + 'T00:00:00').getTime() + maxDays * DAY_MS)
    .toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

  const dls = await supaGet('deadlines?date=gte.' + today + '&date=lte.' + until + '&limit=500');
  if (!Array.isArray(dls) || !dls.length) return;

  const tokens = await supaGet('gmail_tokens?select=member_id,email&limit=50');
  const teamEmails = (Array.isArray(tokens) ? tokens : []).map(t => t.email).filter(Boolean);
  const defaultSender = (Array.isArray(tokens) && tokens[0]) ? tokens[0].member_id : null;
  const tokenCache = {};

  for (let i = 0; i < dls.length; i++) {
    const dl = dls[i];
    result.reminders.checked++;
    const n = daysUntil(dl.date);
    if (n === null || n < 0) continue;

    const set = byType[dl.type] || def;
    if (set.enabled === false) continue;
    if ((set.daysBefore || []).indexOf(n) === -1) continue;

    // Closed deals don't need reminding.
    let tx = null;
    if (dl.transactionId != null) {
      const txs = await supaGet('transactions?id=eq.' + encodeURIComponent(dl.transactionId) + '&limit=1');
      tx = (Array.isArray(txs) && txs[0]) ? txs[0] : null;
      if (tx && tx.status === 'closed') { result.reminders.skipped++; continue; }
    }

    const cs = dl.contactId != null
      ? await supaGet('contacts?id=eq.' + encodeURIComponent(dl.contactId) + '&limit=1')
      : [];
    const c = (Array.isArray(cs) && cs[0]) ? cs[0] : null;

    const clientEmails = contactEmails(c);
    // No client address? Still tell the team, so someone knows to call.
    const to = clientEmails.length ? clientEmails.join(', ') : teamEmails.join(', ');
    const cc = clientEmails.length ? teamEmails.join(', ') : '';
    if (!to) { result.reminders.skipped++; continue; }

    const senderId = dl.assignedTo || (tx && tx.assignedTo) || defaultSender;
    if (!senderId) { result.reminders.errors.push('No sending account for deadline ' + dl.id); continue; }
    if (!tokenCache[senderId]) tokenCache[senderId] = await getAccessToken(senderId);
    const tok = tokenCache[senderId];
    if (tok.error) { result.reminders.errors.push(tok.error); continue; }

    const msg = buildReminder(c, dl, tx, n);
    const logRow = {
      id: Date.now() + Math.floor(Math.random() * 100000) + i,
      deadlineId: dl.id,
      transactionId: dl.transactionId || null,
      contactId: dl.contactId || null,
      deadlineType: dl.type || '',
      deadlineDate: dl.date,
      daysBefore: n,
      sentTo: to + (cc ? ' | cc: ' + cc : ''),
      status: 'pending',
      error: '',
      sentAt: new Date().toISOString()
    };

    // Claim the reminder BEFORE sending. The unique index on (deadlineId, daysBefore)
    // makes a duplicate send impossible even if the cron overlaps or is re-triggered.
    const claim = await supaUpsert('reminder_log', [logRow]);
    if (!claim.ok) { result.reminders.skipped++; continue; }

    const sent = await gmailSend(tok.accessToken, to, msg.subject, msg.body, cc);
    logRow.status = sent.error ? 'failed' : 'sent';
    logRow.error = sent.error || '';
    await supaUpsert('reminder_log', [logRow]);

    if (sent.error) { result.reminders.failed++; result.reminders.errors.push(sent.error); }
    else { result.reminders.sent++; }
  }
}

async function buildBriefing() {
  const today = todayMtn();
  const in7  = new Date(Date.now() +  7 * DAY_MS).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const in14 = new Date(Date.now() + 14 * DAY_MS).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const in30 = new Date(Date.now() + 30 * DAY_MS).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

  const [contacts, followups, deadlines, transactions, activeEnr] = await Promise.all([
    supaGet('contacts?limit=500'),
    supaGet('followups?done=eq.false&order=date.asc&limit=200'),
    supaGet('deadlines?order=date.asc&limit=200'),
    supaGet('transactions?order=closingDate.asc&limit=100'),
    supaGet('enrollments?status=eq.active&limit=200')
  ]);

  const cMap = {};
  (contacts || []).forEach(c => { cMap[String(c.id)] = c; });

  const fuDue  = (followups || []).filter(f => f.date && f.date <= today);
  const fuSoon = (followups || []).filter(f => f.date && f.date > today && f.date <= in7);
  const dlSoon = (deadlines || []).filter(d => d.date && d.date >= today && d.date <= in14);
  const txClose = (transactions || []).filter(t => t.closingDate && t.closingDate >= today && t.closingDate <= in30);
  const pipeline = (transactions || []).filter(t => t.stage !== 'Closed');

  const dayName = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Denver'
  });

  const css = `
    body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;}
    .wrap{max-width:600px;margin:20px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.1);}
    .hdr{background:#1a1d24;padding:26px 28px 18px;}
    .hdr h1{color:#c9a84c;font-size:20px;margin:0 0 4px;}
    .hdr p{color:#9a8f7a;font-size:13px;margin:0;}
    .counts{display:flex;gap:12px;padding:16px 28px;background:#f9f8f5;border-bottom:1px solid #eee;flex-wrap:wrap;}
    .cbox{flex:1;min-width:100px;text-align:center;background:#fff;border-radius:8px;padding:10px;border:1px solid #eee;}
    .cnum{font-size:22px;font-weight:700;color:#c9a84c;}
    .clbl{font-size:11px;color:#999;margin-top:2px;}
    .sec{padding:18px 28px;border-bottom:1px solid #eee;}
    .sec:last-of-type{border-bottom:none;}
    .stitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#999;margin:0 0 10px;}
    .item{padding:7px 0;border-bottom:1px solid #f5f5f5;display:flex;gap:9px;align-items:flex-start;}
    .item:last-child{border-bottom:none;}
    .dot{width:7px;height:7px;border-radius:50%;margin-top:5px;flex-shrink:0;}
    .dr{background:#c94c4c;} .dg{background:#c9a84c;} .db{background:#6bc97a;}
    .im{font-size:13px;color:#1a1d24;font-weight:600;line-height:1.3;}
    .is{font-size:12px;color:#888;margin-top:1px;}
    .empty{color:#bbb;font-size:13px;font-style:italic;}
    .ftr{background:#f9f8f5;padding:14px 28px;text-align:center;font-size:11px;color:#bbb;}
    a{color:#c9a84c;}
  `;

  function sec(title, body) {
    return '<div class="sec"><div class="stitle">' + title + '</div>' + body + '</div>';
  }
  function itm(dotCls, main, sub) {
    return '<div class="item"><div class="dot ' + dotCls + '"></div><div><div class="im">' + main + '</div>' + (sub ? '<div class="is">' + sub + '</div>' : '') + '</div></div>';
  }

  const counts = '<div class="counts">'
    + '<div class="cbox"><div class="cnum">' + fuDue.length + '</div><div class="clbl">Due / Overdue</div></div>'
    + '<div class="cbox"><div class="cnum">' + pipeline.length + '</div><div class="clbl">Active Deals</div></div>'
    + '<div class="cbox"><div class="cnum">' + txClose.length + '</div><div class="clbl">Closing Soon</div></div>'
    + '<div class="cbox"><div class="cnum">' + (Array.isArray(activeEnr) ? activeEnr.length : 0) + '</div><div class="clbl">Drip Enrolled</div></div>'
    + '</div>';

  const fuDueBody = fuDue.length === 0
    ? '<div class="empty">No overdue reminders.</div>'
    : fuDue.slice(0, 8).map(f => {
        const c = cMap[String(f.contactId)];
        const d = daysUntil(f.date);
        const tag = d < 0 ? ' <b style="color:#c94c4c">[' + Math.abs(d) + 'd overdue]</b>' : ' <b style="color:#c9a84c">[Today]</b>';
        return itm('dr', f.label + tag, cName(c) + (f.notes ? ' — ' + f.notes : ''));
      }).join('');

  const fuSoonBody = fuSoon.length === 0
    ? '<div class="empty">Nothing else due this week.</div>'
    : fuSoon.slice(0, 6).map(f => {
        const c = cMap[String(f.contactId)];
        return itm('dg', f.label, cName(c) + ' — ' + fmtDate(f.date));
      }).join('');

  const dlBody = dlSoon.length === 0
    ? '<div class="empty">No deadlines in the next 14 days.</div>'
    : dlSoon.slice(0, 8).map(d => {
        const c = cMap[String(d.contactId)];
        const days = daysUntil(d.date);
        return itm(days <= 3 ? 'dr' : 'dg', (d.type || 'Deadline') + ' — ' + fmtDate(d.date), cName(c) + (days === 0 ? ' (TODAY)' : ' (' + days + 'd)'));
      }).join('');

  const txBody = txClose.length === 0
    ? '<div class="empty">No closings in the next 30 days.</div>'
    : txClose.slice(0, 8).map(t => {
        const c = cMap[String(t.contactId)];
        const days = daysUntil(t.closingDate);
        return itm(days <= 7 ? 'dr' : days <= 14 ? 'dg' : 'db',
          (t.address || 'Transaction') + (t.price ? ' &mdash; ' + t.price : ''),
          cName(c) + ' &mdash; Closes ' + fmtDate(t.closingDate) + ' (' + days + 'd)');
      }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
    + '<div class="wrap">'
    + '<div class="hdr"><h1>Good morning &mdash; Here\'s Your Day</h1><p>' + dayName + ' &nbsp;&middot;&nbsp; Palacios Baker Real Estate</p></div>'
    + counts
    + sec('Follow-ups Due Today &amp; Overdue', fuDueBody)
    + sec('Coming Up This Week', fuSoonBody)
    + sec('Upcoming Deadlines (Next 14 Days)', dlBody)
    + sec('Closings in the Next 30 Days', txBody)
    + '<div class="ftr">Properly CRM &nbsp;&middot;&nbsp; <a href="https://properly-crm.vercel.app">Open CRM</a></div>'
    + '</div></body></html>';
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
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
  const result = {
    drips: { checked: 0, sent: 0, failed: 0, completed: 0, skipped: 0, errors: [] },
    reminders: { checked: 0, sent: 0, failed: 0, skipped: 0, errors: [] }
  };

  // 1. Process drip enrollments
  try {
    const due = await supaGet(
      'enrollments?status=eq.active&nextSendAt=lte.' + encodeURIComponent(nowIso) + '&order=nextSendAt.asc&limit=100'
    );

    if (Array.isArray(due) && due.length) {
      const campaigns = await supaGet('campaigns?limit=500');
      const campById = {};
      (campaigns || []).forEach(c => {
        if (typeof c.steps === 'string') { try { c.steps = JSON.parse(c.steps); } catch (e) { c.steps = []; } }
        if (!Array.isArray(c.steps)) c.steps = [];
        campById[String(c.id)] = c;
      });

      const tokenCache = {};

      for (let i = 0; i < due.length; i++) {
        const enr = due[i];
        result.drips.checked++;
        const camp = campById[String(enr.campaignId)];
        if (!camp || !camp.steps.length) {
          enr.status = 'stopped'; enr.nextSendAt = null;
          await supaUpsert('enrollments', [enr]); result.drips.skipped++; continue;
        }
        const step = camp.steps[enr.stepIndex];
        if (!step) {
          enr.status = 'completed'; enr.nextSendAt = null;
          await supaUpsert('enrollments', [enr]); result.drips.completed++; continue;
        }

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
          await supaUpsert('enrollments', [enr]); result.drips.failed++; continue;
        }

        const memberId = enr.fromMemberId;
        if (!memberId) {
          logBase.status = 'queued'; logBase.error = 'No sending account';
          await supaUpsert('send_log', [logBase]);
          enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
          await supaUpsert('enrollments', [enr]); result.drips.skipped++; continue;
        }

        if (!tokenCache[memberId]) tokenCache[memberId] = await getAccessToken(memberId);
        const tok = tokenCache[memberId];
        if (tok.error) {
          logBase.status = 'queued'; logBase.error = tok.error;
          await supaUpsert('send_log', [logBase]);
          enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
          await supaUpsert('enrollments', [enr]); result.drips.skipped++;
          result.drips.errors.push(tok.error); continue;
        }

        const subject = mergeTags(step.subject, c);
        const htmlBody = mergeTags(step.body, c).replace(/\n/g, '<br>');
        logBase.subject = subject;

        const sent = await gmailSend(tok.accessToken, to, subject, htmlBody);
        if (sent.error) {
          logBase.status = 'failed'; logBase.error = sent.error;
          await supaUpsert('send_log', [logBase]);
          enr.nextSendAt = new Date(Date.now() + 3600000).toISOString();
          await supaUpsert('enrollments', [enr]); result.drips.failed++;
          result.drips.errors.push(sent.error); continue;
        }

        logBase.status = 'sent'; logBase.sentAt = new Date().toISOString();
        await supaUpsert('send_log', [logBase]);
        await supaUpsert('notes', [{
          id: Date.now() + Math.floor(Math.random() * 100000),
          contactId: enr.contactId,
          text: 'Drip "' + camp.name + '" step ' + (enr.stepIndex + 1) + ' sent: ' + subject,
          date: new Date().toISOString()
        }]);

        enr.stepIndex += 1;
        if (enr.stepIndex >= camp.steps.length) {
          enr.status = 'completed'; enr.nextSendAt = null; result.drips.completed++;
        } else {
          const nextDelay = parseInt(camp.steps[enr.stepIndex].delayDays) || 0;
          enr.nextSendAt = new Date(Date.now() + nextDelay * DAY_MS).toISOString();
        }
        await supaUpsert('enrollments', [enr]);
        result.drips.sent++;
      }
    }
  } catch (err) {
    result.drips.errors.push('Drip error: ' + err.message);
  }

  // 2. Transaction deadline reminders (transactional - separate from drips)
  try {
    await processReminders(result);
  } catch (err) {
    result.reminders.errors.push('Reminder error: ' + err.message);
  }

  return res.status(200).json({ ok: true, result });
}
