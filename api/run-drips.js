// /api/run-drips.js — Drip campaign engine (v2) + transaction deadline reminders.
//
// Meant to be called every ~15 minutes (cron-job.org: /api/run-drips?secret=CRON_SECRET).
// Each run:
//   1. Inbound check (always, read-only): looks at new mail in every connected Gmail account and
//      - stops a campaign when the contact replies to one of its emails (+ a task for the whole team)
//      - pauses campaigns when someone on the team emails an enrolled contact personally, or the
//        contact starts a new email to us
//      - notes out-of-office auto-replies without stopping anything
//      - unsubscribes "stop / remove me" replies (+ a task so a person double-checks)
//      - puts an enrollment on hold when its email bounces
//   2. Sends campaign steps that are due (only when Sending Controls: master + drips are on), following
//      each campaign's rules: send time, skip weekends, one campaign email per person per day, the
//      contact's language (English / Spanish version of each email).
//      Reminder steps (call / text / card) become a task instead of an email.
//   3. Transaction deadline reminders (unchanged, only when Sending Controls: reminders is on).
//   4. Writes a health record (settings.drip_health) that the CRM shows as a banner.
//
// POST {action:'test', messageId, lang, first}  -> sends a test of one email to the signed-in user.
//
// Env: SUPA_URL, SUPA_SERVICE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CRON_SECRET
// Optional: DRIP_AGENT_NAME, SITE_URL, UNSUB_SECRET

import crypto from 'crypto';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const SUPA_URL = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || SUPA_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AGENT_NAME = process.env.DRIP_AGENT_NAME || 'Randy Baker';
const DAY_MS = 86400000;
const TZ = 'America/Denver';
const MAX_SENDS_PER_RUN = 40;          // keeps one run well inside the function time limit

const SITE_URL = (process.env.SITE_URL || 'https://properly-crm.vercel.app').replace(/\/+$/, '');
const UNSUB_SECRET = process.env.UNSUB_SECRET || SUPA_SERVICE_KEY;

const DEFAULT_RULES = { reply: true, pause: true, pauseDays: 10, weekends: true, time: '07:00', oneADay: true, fromMemberId: null };
function rulesOf(camp) {
  const r = Object.assign({}, DEFAULT_RULES, (camp && camp.rules) || {});
  if (!/^\d{1,2}:\d{2}$/.test(String(r.time))) r.time = '07:00';
  r.pauseDays = parseInt(r.pauseDays) || 10;
  return r;
}

// Steps: {type:'email', wait, messageId} | {type:'task', wait, kind, who, note}
// Older campaigns stored {delayDays, messageId, subject, body}; normalize those.
function normSteps(steps) {
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch (e) { steps = []; } }
  if (!Array.isArray(steps)) return [];
  return steps.map(s => {
    s = s || {};
    const wait = s.wait != null ? (parseInt(s.wait) || 0) : (parseInt(s.delayDays) || 0);
    if (s.type === 'task') return { type: 'task', wait: wait, kind: s.kind || 'Call', who: s.who == null ? 'all' : s.who, note: s.note || '' };
    return { type: 'email', wait: wait, messageId: s.messageId != null ? s.messageId : null };
  });
}

// ---------- unsubscribe + click tracking ----------
function unsubToken(contactId) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update('unsub:' + String(contactId)).digest('hex').slice(0, 32);
}
function unsubUrl(contactId) {
  return SITE_URL + '/api/portal?action=unsubscribe&c=' + encodeURIComponent(contactId) + '&t=' + unsubToken(contactId);
}
function applyUnsubscribe(html, contactId, lang) {
  const url = contactId != null ? unsubUrl(contactId) : '#';
  let out = String(html || '');
  if (/\{\{\s*unsubscribe\s*\}\}/i.test(out)) return out.replace(/\{\{\s*unsubscribe\s*\}\}/gi, url);
  const es = lang === 'es';
  const footer = '<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e5e5;'
    + 'font-size:12px;color:#999;text-align:center;font-family:Arial,sans-serif;">'
    + (es ? 'Recibe este correo porque es contacto de Palacios Baker Real Estate.<br>' : 'You received this because you are a contact of Palacios Baker Real Estate.<br>')
    + '<a href="' + url + '" style="color:#999;">' + (es ? 'Cancelar la suscripción' : 'Unsubscribe from these emails') + '</a></div>';
  return out + footer;
}
// Must match api/portal.js (action=click).
function clickToken(logId, url) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update('click:' + String(logId) + ':' + url).digest('hex').slice(0, 24);
}
// Route every http(s) link through /api/portal?action=click so clicks are counted. Unsubscribe,
// mailto: and tel: links are left alone.
function trackLinks(html, logId) {
  return String(html || '').replace(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi, function (m, q, url) {
    if (/action=unsubscribe/.test(url)) return m;
    const real = url.replace(/&amp;/g, '&');
    return 'href=' + q + SITE_URL + '/api/portal?action=click&l=' + encodeURIComponent(logId)
      + '&u=' + encodeURIComponent(real) + '&t=' + clickToken(logId, real) + q;
  });
}

// ---------- Supabase ----------
function supaHeaders(extra) {
  return Object.assign({
    'apikey': SUPA_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPA_SERVICE_KEY,
    'Content-Type': 'application/json', 'Accept': 'application/json'
  }, extra || {});
}
async function supaGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: supaHeaders() });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return []; }
}
async function supaUpsert(table, rows) {
  return fetch(SUPA_URL + '/rest/v1/' + table, {
    method: 'POST', headers: supaHeaders({ 'Prefer': 'resolution=merge-duplicates' }), body: JSON.stringify(rows)
  });
}
async function supaPatch(path, body, returnRows) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    method: 'PATCH', headers: supaHeaders({ 'Prefer': returnRows ? 'return=representation' : 'return=minimal' }), body: JSON.stringify(body)
  });
  if (!returnRows) return r.ok;
  try { return await r.json(); } catch (e) { return []; }
}
async function getSetting(key) {
  const rows = await supaGet('settings?key=eq.' + encodeURIComponent(key) + '&select=value');
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}
async function setSetting(key, value) { return supaUpsert('settings', [{ key: key, value: value }]); }
// Ids: ms timestamp * 1000 + a counter — unique across runs and never collides with the app's Date.now() ids.
let _idSeq = Math.floor(Math.random() * 1000);
function newSmallId() { _idSeq = (_idSeq + 1) % 1000; return Date.now() * 1000 + _idSeq; }
function inList(ids) { return '(' + ids.map(x => encodeURIComponent(String(x))).join(',') + ')'; }

// ---------- Gmail ----------
async function getAccessToken(memberId) {
  const rows = await supaGet('gmail_tokens?member_id=eq.' + encodeURIComponent(memberId));
  if (!Array.isArray(rows) || !rows[0]) return { error: 'Gmail not connected for this account' };
  const rec = rows[0];
  let accessToken = rec.access_token;
  if (!accessToken || Date.now() >= (rec.expires_at - 60000)) {
    if (!rec.refresh_token) return { error: 'Gmail connection expired — reconnect ' + (rec.email || 'the account'), email: rec.email };
    const rr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: rec.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }).toString()
    });
    const nt = await rr.json();
    if (nt.error) return { error: 'Gmail connection expired for ' + (rec.email || 'the account') + ' — reconnect it (' + (nt.error_description || nt.error) + ')', email: rec.email };
    accessToken = nt.access_token;
    rec.access_token = accessToken;
    rec.expires_at = Date.now() + ((nt.expires_in || 3600) * 1000);
    await supaUpsert('gmail_tokens', [rec]);
  }
  return { accessToken: accessToken, email: rec.email, memberId: memberId, name: rec.name };
}
async function gmailGet(accessToken, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { 'Authorization': 'Bearer ' + accessToken } });
  return r.json();
}

function encodeSubject(s) {
  s = String(s || '');
  return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}
// Base64 data: images become inline CID attachments (webmail strips data: URIs).
function extractInlineImages(html) {
  const images = [];
  if (!html) return { html: '', images: images };
  let n = 0;
  const rewritten = String(html).replace(/src\s*=\s*(["'])data:([^;,"']+);base64,([^"']+)\1/gi, function (_m, q, mime, b64) {
    n += 1;
    const cid = 'img' + n + '@properlycrm';
    images.push({ cid: cid, mime: mime.trim(), b64: b64.replace(/\s+/g, '') });
    return 'src=' + q + 'cid:' + cid + q;
  });
  return { html: rewritten, images: images };
}
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n').trim(); }

let SEND_CTRL = null;
async function gmailSend(accessToken, to, subject, htmlBody, cc) {
  if (SEND_CTRL && SEND_CTRL.testMode) { to = SEND_CTRL.testEmail || to; cc = undefined; subject = '[TEST] ' + subject; }
  const { html, images } = extractInlineImages(htmlBody || '');
  const headerLines = ['To: ' + to];
  if (cc) headerLines.push('Cc: ' + cc);
  headerLines.push('Subject: ' + encodeSubject(subject), 'MIME-Version: 1.0');
  let mime;
  if (images.length) {
    const boundary = 'pbx_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
    const parts = ['--' + boundary, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(html, 'utf8').toString('base64'))];
    images.forEach(function (img) {
      parts.push('--' + boundary, 'Content-Type: ' + (img.mime || 'image/png'), 'Content-Transfer-Encoding: base64',
        'Content-ID: <' + img.cid + '>', 'Content-Disposition: inline', '', wrap76(img.b64));
    });
    parts.push('--' + boundary + '--');
    mime = headerLines.concat(['Content-Type: multipart/related; boundary="' + boundary + '"', '', parts.join('\r\n')]).join('\r\n');
  } else {
    mime = headerLines.concat(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(html, 'utf8').toString('base64'))]).join('\r\n');
  }
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw })
  });
  const data = await resp.json();
  if (data.error) return { error: data.error.message };
  return { messageId: data.id, threadId: data.threadId };
}

// {first} and {{first}} both work.
function mergeTags(text, c) {
  if (!text) return '';
  const t = (name) => new RegExp('\\{\\{?\\s*' + name + '\\s*\\}?\\}', 'gi');
  return String(text)
    .replace(t('first'), (c && c.first) || (c && c.lang === 'es' ? 'amigo' : 'there'))
    .replace(t('last'), (c && c.last) || '')
    .replace(t('property'), (c && c.property) || '')
    .replace(t('price'), (c && c.price) || '')
    .replace(t('agent'), AGENT_NAME);
}

// ---------- Mountain-time scheduling (mirrored in app.js: dripNextSend) ----------
function todayMtn() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDaysStr(ds, n) {
  const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dowStr(ds) { return new Date(ds + 'T12:00:00Z').getUTCDay(); }
function tzOffsetMin(utcMs) {   // Mountain wall clock minus UTC, in minutes (e.g. -420)
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utcMs)).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((wall - utcMs) / 60000);
}
function mtnToUtcMs(ds, hm) {
  const [h, m] = String(hm).split(':').map(Number);
  const guess = Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10), h, m);
  let t = guess - tzOffsetMin(guess) * 60000;
  t = guess - tzOffsetMin(t) * 60000;
  return t;
}
function mtnDateOf(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); }
// The send moment for "wait N days after fromDate", honoring send time + skip weekends, never in the past.
function nextSendAt(fromDate, waitDays, rules) {
  let ds = addDaysStr(fromDate, parseInt(waitDays) || 0);
  const ok = (d) => !(rules.weekends && (dowStr(d) === 0 || dowStr(d) === 6));
  while (!ok(ds)) ds = addDaysStr(ds, 1);
  let t = mtnToUtcMs(ds, rules.time);
  let guard = 0;
  while (t < Date.now() - 60000 && guard++ < 10) { ds = addDaysStr(ds, 1); while (!ok(ds)) ds = addDaysStr(ds, 1); t = mtnToUtcMs(ds, rules.time); }
  return new Date(t).toISOString();
}
function fmtShort(ms) { return new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }); }

function cName(c) { if (!c) return 'Unknown'; return ((c.first || '') + ' ' + (c.last || '')).trim() || c.email || 'Unknown'; }
function addrList(h) { return String(h || '').toLowerCase().match(/[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}/g) || []; }
function hdr(msg, name) {
  const hs = (msg && msg.payload && msg.payload.headers) || [];
  const h = hs.find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

async function logEvent(row) {
  const r = Object.assign({ id: newSmallId(), status: 'ok', created_at: new Date().toISOString() }, row);
  await supaUpsert('send_log', [r]);
  return r;
}
// A task (follow-up) for the whole team (assignedTo = null) or one member.
async function createTask(contactId, label, notes, pri, assignedTo) {
  await supaUpsert('followups', [{
    id: newSmallId(), contactId: contactId, transactionId: null, label: label, date: todayMtn(),
    pri: pri || 'hot', done: false, assignedTo: assignedTo == null || assignedTo === 'all' ? null : Number(assignedTo), notes: notes || ''
  }]);
}

function nowHmMtn() { return new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayMtn() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / DAY_MS);
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

// Fill {{tags}} in a custom reminder template. Same tags shown in the Reminder Types editor.
function renderReminderTemplate(text, ctx) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{\s*first\s*\}\}/gi, ctx.first)
    .replace(/\{\{\s*last\s*\}\}/gi, ctx.last)
    .replace(/\{\{\s*property\s*\}\}/gi, ctx.property)
    .replace(/\{\{\s*address\s*\}\}/gi, ctx.property)
    .replace(/\{\{\s*date\s*\}\}/gi, ctx.dateStr)
    .replace(/\{\{\s*when\s*\}\}/gi, ctx.when)
    .replace(/\{\{\s*type\s*\}\}/gi, ctx.label)
    .replace(/\{\{\s*agent\s*\}\}/gi, AGENT_NAME);
}

function buildReminder(c, dl, tx, n, set) {
  const lang = (c && c.lang === 'es') ? 'es' : 'en';
  const label = dlLabel(dl.type, lang);
  const addr = (tx && tx.address) ? tx.address : ((c && c.property) || '');
  const when = whenPhrase(n, lang);
  const dateStr = fmtDateLang(dl.date, lang);
  const first = (c && c.first) || (lang === 'es' ? 'cliente' : 'there');

  // Custom per-type template wins over the automatic wording, but STRICTLY by language:
  // a Spanish contact only ever gets the Spanish template. If none was written, we fall
  // through to the generic Spanish wording below - never the English template.
  if (set) {
    const subj = (lang === 'es') ? set.subjectEs : set.subjectEn;
    const bodyRaw = (lang === 'es') ? set.bodyEs : set.bodyEn;
    if (subj || bodyRaw) {
      const ctx = { first: first, last: (c && c.last) || '', property: addr, dateStr: dateStr, when: when, label: label };
      const bodyHtml = renderReminderTemplate(bodyRaw, ctx).replace(/\n/g, '<br>');
      return {
        lang: lang,
        subject: renderReminderTemplate(subj || ('Reminder: ' + label + ' (' + when + ')'), ctx),
        body: bodyHtml || ('<p>' + renderReminderTemplate(subj, ctx) + '</p>')
      };
    }
  }

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

  // Preload existing log rows for these deadlines so we can tell "already sent" (skip) apart
  // from "tried and failed" (retry). Keyed by deadlineId|daysBefore; a 'sent' row wins.
  const logByKey = {};
  const dlIds = dls.map(d => d.id).filter(x => x != null);
  if (dlIds.length) {
    const logs = await supaGet('reminder_log?deadlineId=in.(' + dlIds.join(',') + ')&limit=2000');
    (Array.isArray(logs) ? logs : []).forEach(r => {
      const k = r.deadlineId + '|' + r.daysBefore;
      if (!logByKey[k] || r.status === 'sent') logByKey[k] = r;
    });
  }

  const tokens = await supaGet('gmail_tokens?select=member_id,email&limit=50');
  const defaultSender = (Array.isArray(tokens) && tokens[0]) ? tokens[0].member_id : null;
  const tokenCache = {};

  // Team addresses come from the shared team table (real inboxes), not gmail_tokens.
  const team = await supaGet('team?select=id,email&limit=50');
  const teamById = {};
  (Array.isArray(team) ? team : []).forEach(t => { if (t.email) teamById[String(t.id)] = t.email; });
  const teamEmails = Object.keys(teamById).map(k => teamById[k]);
  const memberEmail = (id) => (id != null && teamById[String(id)]) ? teamById[String(id)] : '';

  for (let i = 0; i < dls.length; i++) {
    const dl = dls[i];
    result.reminders.checked++;
    const n = daysUntil(dl.date);
    if (n === null || n < 0) continue;

    // Generated workflow tasks (they carry a stepKey) are internal coordination items — they show
    // in-app and in the agent briefing but must never auto-email the client. Party-based routing
    // (via dl.owner) is a later slice; skip them here.
    if (dl.stepKey) { result.reminders.skipped++; continue; }

    const personal = (dl.contactId == null && dl.transactionId == null);
    const typeSet = byType[dl.type];         // explicit config for THIS type, or undefined
    const set = typeSet || def;              // used for the enabled flag / fallback
    if (set.enabled === false) continue;
    // Which days-before to use. IMPORTANT: check the TYPE's own config, not `set` - `set`
    // falls back to `def` (e.g. [3,1]), which would hijack a personal reminder's day-of rule.
    //  - the type's own timing if it was explicitly configured;
    //  - otherwise a personal reminder fires on its own date (day-of), since it's a to-do;
    //  - otherwise a transaction deadline uses the default advance timing (e.g. 3, 1).
    let days;
    if (typeSet && typeSet.daysBefore && typeSet.daysBefore.length) days = typeSet.daysBefore;
    else if (personal) days = [0];
    else days = (def.daysBefore || []);
    if (days.indexOf(n) === -1) continue;

    // Optional per-reminder time: on the send-day, hold until the clock reaches it. Earlier
    // cron runs skip (staying pending); a later run at/after the time sends it. Blank = send now.
    // Reminders with no time of their own wait until 7:00 am Mountain. This job now runs every
    // 15 minutes, and without this they'd go out just after midnight.
    if (nowHmMtn() < (dl.time ? String(dl.time).slice(0, 5) : '07:00')) { result.reminders.skipped++; continue; }

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
    let to, cc;
    if (clientEmails.length) {
      // Client reminder: To the client, Cc the team so you see the exact message sent.
      to = clientEmails.join(', ');
      cc = teamEmails.join(', ');
    } else {
      // Personal / client-less reminder: goes to whoever it's assigned to (falls back to
      // the whole team if unassigned, or if that member has no address on file).
      to = memberEmail(dl.assignedTo) || teamEmails.join(', ');
      cc = '';
    }
    if (!to) { result.reminders.skipped++; continue; }

    const senderId = dl.assignedTo || (tx && tx.assignedTo) || defaultSender;
    if (!senderId) { result.reminders.errors.push('No sending account for deadline ' + dl.id); continue; }
    if (!tokenCache[senderId]) tokenCache[senderId] = await getAccessToken(senderId);
    const tok = tokenCache[senderId];
    if (tok.error) { result.reminders.errors.push(tok.error); continue; }

    const msg = buildReminder(c, dl, tx, n, set);
    // Already sent successfully? Leave it alone. A failed/pending row does NOT block a retry.
    const logKey = dl.id + '|' + n;
    const prior = logByKey[logKey];
    if (prior && prior.status === 'sent') { result.reminders.skipped++; continue; }

    const logRow = {
      // Reuse the prior row's id when retrying so we update it in place (the unique index on
      // deadlineId+daysBefore would reject a second insert); otherwise a fresh id.
      id: prior ? prior.id : (Date.now() + Math.floor(Math.random() * 100000) + i),
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

    // For a brand-new reminder, claim BEFORE sending: the unique index on (deadlineId,
    // daysBefore) makes a concurrent double-send impossible. (A retry reuses the existing row.)
    if (!prior) {
      const claim = await supaUpsert('reminder_log', [logRow]);
      if (!claim.ok) { result.reminders.skipped++; continue; }  // another run just claimed it
    }

    const sent = await gmailSend(tok.accessToken, to, msg.subject, msg.body, cc);
    logRow.status = sent.error ? 'failed' : 'sent';
    logRow.error = sent.error || '';
    await supaUpsert('reminder_log', [logRow]);
    logByKey[logKey] = logRow;

    if (sent.error) { result.reminders.failed++; result.reminders.errors.push(sent.error); }
    else { result.reminders.sent++; }
  }
}

// ===================== DRIP: INBOUND (replies, bounces, personal emails) =====================
const AUTO_SUBJ = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (my|the) (desk|office)|on vacation|respuesta autom[aá]tica|fuera de (la )?oficina|ausente)/i;
const STOP_RE = /^\W*(stop|unsubscribe|remove me|take me off|please remove|no more emails|do not email|don'?t email|baja|cancelar|ya no me (env[ií]en|manden)|no me (env[ií]en|manden))/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system))/i;

async function processInbound(result, health) {
  const R = result.inbound;
  // Who is enrolled (active or paused) — only their mail matters.
  const live = await supaGet('enrollments?status=in.(active,paused)&select=id,campaignId,contactId,status,stepIndex,nextSendAt,pausedUntil&limit=5000');
  const threads = await supaGet('send_log?kind=eq.email&status=eq.sent&threadId=not.is.null&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 180 * DAY_MS).toISOString()) + '&select=id,threadId,enrollmentId,contactId,campaignId,fromEmail,subject&limit=10000');
  const enrolled = Array.isArray(live) ? live : [];
  const threadMap = {};
  (Array.isArray(threads) ? threads : []).forEach(t => { threadMap[t.threadId] = t; });

  const tokens = await supaGet('gmail_tokens?select=member_id,email,name&limit=50');
  const cursor = (await getSetting('drip_inbound_cursor')) || {};
  const nowSec = Math.floor(Date.now() / 1000);
  if (!enrolled.length && !Object.keys(threadMap).length) {
    (Array.isArray(tokens) ? tokens : []).forEach(t => { cursor[t.member_id] = nowSec; });
    await setSetting('drip_inbound_cursor', cursor);
    return;
  }

  const contactIds = Array.from(new Set(enrolled.map(e => String(e.contactId)).concat(Object.values(threadMap).map(t => String(t.contactId)))));
  const contacts = [];
  for (let i = 0; i < contactIds.length; i += 150) {
    const chunk = await supaGet('contacts?id=in.' + inList(contactIds.slice(i, i + 150)) + '&select=id,first,last,email,emails,lang');
    if (Array.isArray(chunk)) contacts.push.apply(contacts, chunk);
  }
  const cById = {}, cByEmail = {};
  contacts.forEach(c => { cById[String(c.id)] = c; contactEmails(c).forEach(e => { cByEmail[e.toLowerCase()] = c; }); });
  const enrByContact = {};
  enrolled.forEach(e => { (enrByContact[String(e.contactId)] = enrByContact[String(e.contactId)] || []).push(e); });

  const camps = await supaGet('campaigns?select=id,name,rules&limit=500');
  const campById = {};
  (Array.isArray(camps) ? camps : []).forEach(c => { campById[String(c.id)] = c; });

  const team = await supaGet('team?select=id,first,last,email&limit=50');
  const teamEmails = {};
  (Array.isArray(team) ? team : []).forEach(t => { if (t.email) teamEmails[t.email.toLowerCase()] = t; });
  (Array.isArray(tokens) ? tokens : []).forEach(t => { if (t.email) teamEmails[t.email.toLowerCase()] = teamEmails[t.email.toLowerCase()] || { first: t.name || t.email }; });

  const today = todayMtn();
  const pauseContact = async (cid, why, exceptEnrId) => {
    const list = enrByContact[String(cid)] || [];
    for (const e of list) {
      if (String(e.id) === String(exceptEnrId)) continue;
      const rules = rulesOf(campById[String(e.campaignId)]);
      if (!rules.pause || e.status !== 'active') continue;
      const until = new Date(mtnToUtcMs(addDaysStr(today, rules.pauseDays), rules.time)).toISOString();
      await supaPatch('enrollments?id=eq.' + e.id, { status: 'paused', pausedUntil: until, reason: why + ' — paused until ' + fmtShort(Date.parse(until)), updated_at: new Date().toISOString() });
      e.status = 'paused';
      R.paused++;
    }
  };

  for (const tk of (Array.isArray(tokens) ? tokens : [])) {
    const tok = await getAccessToken(tk.member_id);
    if (tok.error) { R.errors.push(tok.error); continue; }
    const since = (cursor[tk.member_id] || (nowSec - 3600)) - 300;   // 5 min overlap; duplicates are filtered below
    let ids = [], pageToken = '', pages = 0;
    do {
      const q = encodeURIComponent('after:' + since + ' -in:drafts -in:spam -in:trash -in:chats');
      const lst = await gmailGet(tok.accessToken, 'messages?maxResults=100&q=' + q + (pageToken ? '&pageToken=' + pageToken : ''));
      if (lst.error) { R.errors.push('Gmail list (' + tk.email + '): ' + (lst.error.message || '')); break; }
      (lst.messages || []).forEach(m => ids.push(m));
      pageToken = lst.nextPageToken || '';
    } while (pageToken && ++pages < 4);
    cursor[tk.member_id] = nowSec;
    if (!ids.length) continue;

    // Skip messages we already handled (and the campaign emails we sent ourselves).
    const seen = {};
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await supaGet('send_log?gmailId=in.' + inList(ids.slice(i, i + 100).map(m => m.id)) + '&select=gmailId');
      (Array.isArray(rows) ? rows : []).forEach(r => { seen[r.gmailId] = true; });
    }

    for (const ref of ids) {
      if (seen[ref.id]) continue;
      R.checked++;
      const m = await gmailGet(tok.accessToken, 'messages/' + ref.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=X-Autoreply&metadataHeaders=X-Autorespond&metadataHeaders=Precedence');
      if (!m || m.error) continue;
      const labels = m.labelIds || [];
      const thread = threadMap[m.threadId];
      const subject = hdr(m, 'Subject');
      const snippet = String(m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 240);
      const fromAddr = (addrList(hdr(m, 'From'))[0]) || '';

      if (labels.indexOf('SENT') !== -1) {
        // Automated mail (deadline reminders, tests) isn't a personal conversation.
        if (/^(\[TEST\]|Reminder:|Recordatorio:)/i.test(subject)) continue;
        // Someone on the team emailed people personally -> pause their campaigns.
        const rcpts = addrList(hdr(m, 'To') + ',' + hdr(m, 'Cc'));
        const who = (teamEmails[(tok.email || '').toLowerCase()] || {}).first || tok.email;
        const done = {};
        for (const a of rcpts) {
          const c = cByEmail[a];
          if (!c || done[c.id]) continue;
          done[c.id] = true;
          if (!(enrByContact[String(c.id)] || []).some(e => e.status === 'active')) continue;
          await pauseContact(c.id, who + ' emailed them ' + fmtShort(Date.now()));
          await logEvent({ kind: 'pause', contactId: c.id, gmailId: ref.id, threadId: m.threadId, subject: subject, note: who + ' emailed them personally — campaigns paused', fromEmail: tok.email });
        }
        continue;
      }

      // Bounce for one of our campaign emails.
      if (BOUNCE_FROM.test(hdr(m, 'From')) && thread) {
        await supaPatch('enrollments?id=eq.' + thread.enrollmentId, { status: 'bounced', nextSendAt: null, reason: 'Email bounced — the address may be wrong', updated_at: new Date().toISOString() });
        await logEvent({ kind: 'bounce', contactId: thread.contactId, campaignId: thread.campaignId, enrollmentId: thread.enrollmentId, gmailId: ref.id, threadId: m.threadId, subject: subject, note: snippet, status: 'failed' });
        R.bounced++;
        continue;
      }

      const c = thread ? cById[String(thread.contactId)] : cByEmail[fromAddr];
      if (!c) continue;
      if (teamEmails[fromAddr]) continue;   // our own address replying in the thread

      const auto = (hdr(m, 'Auto-Submitted') && !/^no$/i.test(hdr(m, 'Auto-Submitted'))) || hdr(m, 'X-Autoreply') || hdr(m, 'X-Autorespond')
        || /auto_reply|auto-reply/i.test(hdr(m, 'Precedence')) || AUTO_SUBJ.test(subject);
      if (auto) {
        await logEvent({ kind: 'autoreply', contactId: c.id, campaignId: thread ? thread.campaignId : null, enrollmentId: thread ? thread.enrollmentId : null, gmailId: ref.id, threadId: m.threadId, subject: subject, note: 'Automatic reply (out of office) — campaign continues' });
        R.autoreplies++;
        continue;
      }

      if (STOP_RE.test(snippet)) {
        await supaUpsert('drip_unsubs', [{ contact_id: c.id, email: fromAddr || c.email || '', created_at: new Date().toISOString() }]);
        await supaPatch('enrollments?contactId=eq.' + c.id + '&status=in.(active,paused)', { status: 'unsubscribed', nextSendAt: null, reason: 'Replied asking to stop', updated_at: new Date().toISOString() });
        await logEvent({ kind: 'unsubscribe', contactId: c.id, campaignId: thread ? thread.campaignId : null, enrollmentId: thread ? thread.enrollmentId : null, gmailId: ref.id, threadId: m.threadId, subject: subject, note: snippet });
        await createTask(c.id, cName(c) + ' asked to stop campaign emails — please double-check', '“' + snippet + '”', 'warn', null);
        R.unsubscribed++;
        continue;
      }

      if (thread) {
        const camp = campById[String(thread.campaignId)];
        const rules = rulesOf(camp);
        if (rules.reply) {
          await supaPatch('enrollments?id=eq.' + thread.enrollmentId + '&status=in.(active,paused)', { status: 'stopped', nextSendAt: null, reason: 'Replied ' + fmtShort(Date.now()) + ': “' + snippet.slice(0, 120) + '”', updated_at: new Date().toISOString() });
        }
        await pauseContact(c.id, 'Replied to another campaign', thread.enrollmentId);
        await logEvent({ kind: 'reply', contactId: c.id, campaignId: thread.campaignId, enrollmentId: thread.enrollmentId, gmailId: ref.id, threadId: m.threadId, subject: subject, note: snippet, fromEmail: fromAddr });
        await createTask(c.id, cName(c) + ' replied to “' + (camp ? camp.name : 'a campaign') + '” — follow up', '“' + snippet + '” (reply is in ' + (thread.fromEmail || tok.email) + ')', 'hot', null);
        R.replies++;
        continue;
      }

      // A brand-new email from an enrolled contact: a real conversation -> pause their campaigns.
      if ((enrByContact[String(c.id)] || []).some(e => e.status === 'active')) {
        await pauseContact(c.id, 'They emailed us ' + fmtShort(Date.now()));
        await logEvent({ kind: 'conversation', contactId: c.id, gmailId: ref.id, threadId: m.threadId, subject: subject, note: snippet, fromEmail: fromAddr });
        R.conversations++;
      }
    }
  }
  await setSetting('drip_inbound_cursor', cursor);
  health.lastInboundCheck = new Date().toISOString();
}

// ===================== DRIP: SENDING =====================
async function getDefaultDripSender() {
  const v = await getSetting('default_drip_sender');
  return v && v.memberId ? String(v.memberId) : null;
}

async function resumePaused() {
  const rows = await supaGet('enrollments?status=eq.paused&pausedUntil=lte.' + encodeURIComponent(new Date().toISOString()) + '&select=id,campaignId,nextSendAt&limit=500');
  if (!Array.isArray(rows) || !rows.length) return;
  const camps = await supaGet('campaigns?select=id,rules&limit=500');
  const byId = {}; (Array.isArray(camps) ? camps : []).forEach(c => { byId[String(c.id)] = c; });
  for (const e of rows) {
    const rules = rulesOf(byId[String(e.campaignId)]);
    const next = (!e.nextSendAt || Date.parse(e.nextSendAt) < Date.now()) ? nextSendAt(todayMtn(), 0, rules) : e.nextSendAt;
    await supaPatch('enrollments?id=eq.' + e.id + '&status=eq.paused', { status: 'active', pausedUntil: null, reason: null, nextSendAt: next, updated_at: new Date().toISOString() });
  }
}

async function processDrips(result, health) {
  const R = result.drips;
  await resumePaused();
  const nowIso = new Date().toISOString();
  const due = await supaGet('enrollments?status=eq.active&nextSendAt=lte.' + encodeURIComponent(nowIso) + '&order=nextSendAt.asc&limit=200');
  if (!Array.isArray(due) || !due.length) return;

  const camps = await supaGet('campaigns?select=id,name,live,rules,steps&limit=500');
  const campById = {};
  (Array.isArray(camps) ? camps : []).forEach(c => { c.steps = normSteps(c.steps); campById[String(c.id)] = c; });

  const needMsg = {};
  due.forEach(e => { const c = campById[String(e.campaignId)]; const s = c && c.steps[e.stepIndex]; if (s && s.type === 'email' && s.messageId != null) needMsg[String(s.messageId)] = true; });
  const msgById = {};
  if (Object.keys(needMsg).length) {
    const msgs = await supaGet('drip_messages?id=in.' + inList(Object.keys(needMsg)) + '&select=id,name,subject,html,subject_es,html_es');
    (Array.isArray(msgs) ? msgs : []).forEach(m => { msgById[String(m.id)] = m; });
  }
  const cids = Array.from(new Set(due.map(e => String(e.contactId))));
  const cById = {};
  for (let i = 0; i < cids.length; i += 150) {
    const chunk = await supaGet('contacts?id=in.' + inList(cids.slice(i, i + 150)) + '&select=id,first,last,email,emails,lang,property,price');
    (Array.isArray(chunk) ? chunk : []).forEach(c => { cById[String(c.id)] = c; });
  }
  const unsubs = await supaGet('drip_unsubs?select=contact_id&limit=10000');
  const unsubSet = {}; (Array.isArray(unsubs) ? unsubs : []).forEach(u => { unsubSet[String(u.contact_id)] = true; });
  const todayStartIso = new Date(mtnToUtcMs(todayMtn(), '00:00')).toISOString();
  const sentRows = await supaGet('send_log?kind=eq.email&status=eq.sent&sentAt=gte.' + encodeURIComponent(todayStartIso) + '&select=contactId&limit=5000');
  const sentToday = {}; (Array.isArray(sentRows) ? sentRows : []).forEach(r => { sentToday[String(r.contactId)] = true; });

  const defaultSender = await getDefaultDripSender();
  const tokenCache = {};
  let sends = 0;
  const today = todayMtn();

  for (const enr of due) {
    if (sends >= MAX_SENDS_PER_RUN) break;
    const camp = campById[String(enr.campaignId)];
    if (!camp) { await supaPatch('enrollments?id=eq.' + enr.id, { status: 'removed', nextSendAt: null, reason: 'Campaign was deleted' }); continue; }
    if (!camp.live) { R.skipped++; continue; }           // Draft: wait, nothing sends
    const rules = rulesOf(camp);
    const step = camp.steps[enr.stepIndex];
    if (!step) { await supaPatch('enrollments?id=eq.' + enr.id, { status: 'done', nextSendAt: null, updated_at: nowIso }); R.completed++; continue; }
    R.checked++;
    if (unsubSet[String(enr.contactId)]) {
      await supaPatch('enrollments?id=eq.' + enr.id, { status: 'unsubscribed', nextSendAt: null, reason: 'Unsubscribed', updated_at: nowIso }); R.skipped++; continue;
    }
    const c = cById[String(enr.contactId)];
    if (!c) { await supaPatch('enrollments?id=eq.' + enr.id, { status: 'removed', nextSendAt: null, reason: 'Contact was deleted' }); continue; }

    // Claim this step so an overlapping run can't send it twice.
    const claimed = await supaPatch('enrollments?id=eq.' + enr.id + '&status=eq.active&stepIndex=eq.' + enr.stepIndex + '&nextSendAt=lte.' + encodeURIComponent(nowIso),
      { nextSendAt: new Date(Date.now() + 30 * 60000).toISOString() }, true);
    if (!Array.isArray(claimed) || !claimed.length) continue;

    const advance = async () => {
      const ni = enr.stepIndex + 1;
      if (ni >= camp.steps.length) { await supaPatch('enrollments?id=eq.' + enr.id, { stepIndex: ni, status: 'done', nextSendAt: null, updated_at: new Date().toISOString() }); R.completed++; }
      else await supaPatch('enrollments?id=eq.' + enr.id, { stepIndex: ni, nextSendAt: nextSendAt(today, camp.steps[ni].wait, rules), updated_at: new Date().toISOString() });
    };
    const release = async (atIso) => supaPatch('enrollments?id=eq.' + enr.id, { nextSendAt: atIso });

    if (step.type === 'task') {
      const kindLbl = { Call: 'Call', Text: 'Text', Card: 'Send a handwritten card to', Other: 'Reach out to' }[step.kind] || step.kind;
      await createTask(c.id, kindLbl + ' ' + cName(c) + ' (' + camp.name + ')', step.note || '', 'warn', step.who);
      await logEvent({ kind: 'task', contactId: c.id, campaignId: camp.id, enrollmentId: enr.id, stepIndex: enr.stepIndex, subject: kindLbl + ' ' + cName(c), note: step.note || '' });
      await advance();
      R.tasks++;
      continue;
    }

    if (rules.oneADay && sentToday[String(c.id)]) { await release(nextSendAt(today, 1, rules)); R.deferred++; continue; }

    const to = contactEmails(c)[0] || '';
    if (!to) {
      await supaPatch('enrollments?id=eq.' + enr.id, { status: 'bounced', nextSendAt: null, reason: 'No email address on file', updated_at: nowIso });
      R.failed++; continue;
    }
    const msg = step.messageId != null ? msgById[String(step.messageId)] : null;
    if (!msg || !msg.html) {
      await release(new Date(Date.now() + 6 * 3600000).toISOString());
      health.problems.push('“' + camp.name + '” step ' + (enr.stepIndex + 1) + ' has no email design — sends are waiting');
      R.failed++; continue;
    }
    const memberId = String(rules.fromMemberId || defaultSender || enr.fromMemberId || '');
    if (!memberId) { await release(enr.nextSendAt); health.problems.push('No sending account is set for campaigns'); R.failed++; continue; }
    if (!tokenCache[memberId]) tokenCache[memberId] = await getAccessToken(memberId);
    const tok = tokenCache[memberId];
    if (tok.error) {
      await release(enr.nextSendAt);   // stays due; goes out on the first run after reconnecting
      health.gmailOk = false; health.gmailError = tok.error; health.held++;
      R.held++; continue;
    }

    const lang = (String(c.lang || '').toLowerCase() === 'es' && msg.html_es) ? 'es' : 'en';
    const subject = mergeTags(lang === 'es' ? (msg.subject_es || msg.subject) : msg.subject, c);
    const logId = newSmallId();
    let html = mergeTags(lang === 'es' ? msg.html_es : msg.html, c);
    html = trackLinks(applyUnsubscribe(html, c.id, lang), logId);

    const sent = await gmailSend(tok.accessToken, to, subject, html);
    if (sent.error) {
      await logEvent({ id: logId, kind: 'email', status: 'failed', error: sent.error, enrollmentId: enr.id, campaignId: camp.id, contactId: c.id, stepIndex: enr.stepIndex, subject: subject, to: to, lang: lang, messageId: msg.id, fromEmail: tok.email });
      await release(new Date(Date.now() + 2 * 3600000).toISOString());
      health.lastError = sent.error; R.failed++; continue;
    }
    await logEvent({ id: logId, kind: 'email', status: 'sent', sentAt: new Date().toISOString(), enrollmentId: enr.id, campaignId: camp.id, contactId: c.id, stepIndex: enr.stepIndex, subject: subject, to: to, lang: lang, messageId: msg.id, threadId: sent.threadId, gmailId: sent.messageId, fromEmail: tok.email });
    sentToday[String(c.id)] = true;
    await advance();
    sends++; R.sent++;
  }
  if (Object.keys(tokenCache).length && !Object.values(tokenCache).some(t => t.error)) { health.gmailOk = true; health.gmailError = ''; }
}

// ===================== AUTH + HANDLER =====================
async function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const h = req.headers['x-cron-secret'];
  const auth = req.headers['authorization'] || '';
  const qs = (req.query && req.query.secret) || '';
  if (secret && (qs === secret || h === secret || auth === secret || auth === ('Bearer ' + secret))) return { ok: true, cron: true };
  if (!secret) return { ok: false };
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token === SUPA_KEY) return { ok: false };
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return { ok: false };
    const u = await r.json();
    return u && u.id ? { ok: true, email: u.email } : { ok: false };
  } catch (e) { return { ok: false }; }
}
async function getSendControls() {
  const def = { master: false, reminders: false, drips: false, briefing: false, testMode: true, testEmail: '' };
  try { const v = await getSetting('sending_controls'); if (v) return Object.assign(def, v); } catch (e) {}
  return def;
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', ch => { d += ch; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Send one email to the signed-in user so they can see exactly what contacts will get.
async function sendTest(body, who) {
  const to = who.email || body.to;
  if (!to) return { error: 'No address to send the test to' };
  const rows = await supaGet('drip_messages?id=eq.' + encodeURIComponent(body.messageId) + '&select=id,subject,html,subject_es,html_es');
  const msg = Array.isArray(rows) && rows[0];
  if (!msg) return { error: 'Email not found' };
  const lang = body.lang === 'es' && msg.html_es ? 'es' : 'en';
  const fake = { first: body.first || 'Randy', last: '', lang: lang };
  const sender = String(body.fromMemberId || (await getDefaultDripSender()) || '');
  if (!sender) return { error: 'No sending account is set' };
  const tok = await getAccessToken(sender);
  if (tok.error) return { error: tok.error };
  SEND_CTRL = null;   // a test always goes to the requester
  const sent = await gmailSend(tok.accessToken, to, '[TEST] ' + mergeTags(lang === 'es' ? (msg.subject_es || msg.subject) : msg.subject, fake),
    applyUnsubscribe(mergeTags(lang === 'es' ? msg.html_es : msg.html, fake), null, lang));
  return sent.error ? { error: sent.error } : { ok: true, to: to, from: tok.email, lang: lang };
}

export default async function handler(req, res) {
  const who = await authorized(req);
  if (!who.ok) return res.status(401).json({ error: 'Unauthorized' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  const action = (req.query && req.query.action) || body.action || 'run';
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' });

  if (action === 'test') {
    try { const r = await sendTest(body, who); return res.status(r.error ? 400 : 200).json(r); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const CTRL = await getSendControls();
  SEND_CTRL = CTRL;
  const result = {
    inbound: { checked: 0, replies: 0, autoreplies: 0, unsubscribed: 0, bounced: 0, paused: 0, conversations: 0, errors: [] },
    drips: { checked: 0, sent: 0, failed: 0, completed: 0, skipped: 0, deferred: 0, held: 0, tasks: 0, errors: [] },
    reminders: { checked: 0, sent: 0, failed: 0, skipped: 0, errors: [] }
  };
  const prev = (await getSetting('drip_health')) || {};
  const health = { at: new Date().toISOString(), gmailOk: prev.gmailOk !== false, gmailError: prev.gmailError || '', held: 0, problems: [],
    lastInboundCheck: prev.lastInboundCheck || null, lastSendRun: prev.lastSendRun || null, lastError: '',
    sending: !!(CTRL.master && CTRL.drips), testMode: !!CTRL.testMode };

  // 1. Replies / bounces / personal emails — read-only, runs even when sending is off.
  try { await processInbound(result, health); } catch (e) { result.inbound.errors.push('Inbound error: ' + e.message); }

  // 2. Campaign sends.
  if (CTRL.master && CTRL.drips) {
    try {
      // Check the sending account up front so the banner is right even when nothing is due.
      const sender = await getDefaultDripSender();
      if (sender) { const t = await getAccessToken(sender); health.senderEmail = t.email || ''; health.gmailOk = !t.error; health.gmailError = t.error || ''; }
      await processDrips(result, health);
      if (result.drips.sent || result.drips.failed || result.drips.tasks) health.lastSendRun = { at: new Date().toISOString(), sent: result.drips.sent, failed: result.drips.failed, tasks: result.drips.tasks };
    } catch (e) { result.drips.errors.push('Drip error: ' + e.message); health.lastError = e.message; }
  }

  // 3. Transaction reminders (separate from drips).
  try { if (CTRL.master && CTRL.reminders) await processReminders(result); }
  catch (e) { result.reminders.errors.push('Reminder error: ' + e.message); }

  try { await setSetting('drip_health', health); } catch (e) {}
  return res.status(200).json({ ok: true, sending: health.sending, result: result, health: health });
}
