// /api/portal.js — Client-facing transaction portal (read-only, self-serve magic link).
//
// Security model: clients NEVER touch Supabase directly and are NOT in the app's auth pool.
// This function is the only door. It uses the service key server-side, and every response is
// scoped to a single contact resolved from a signed, expiring token. It returns status + dates
// only — never price, commissions, internal notes, or any other client's data.
//
//   action=request  { email }  -> if the email matches a contact, emails them a magic link. Always
//                                  returns a generic ok (never reveals whether the email exists).
//   action=summary  { token }  -> validates the token and returns that one contact's sanitized deal.

const crypto = require('crypto');

const SUPA_URL         = process.env.SUPA_URL;
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const CLIENT_ID        = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET    = process.env.GOOGLE_CLIENT_SECRET;
const APP_URL          = process.env.APP_URL || 'https://properly-crm.vercel.app';
// Token-signing secret. Prefer a dedicated PORTAL_SECRET; fall back to CRON_SECRET so the portal
// still works if only that is set.
const SECRET           = process.env.PORTAL_SECRET || process.env.CRON_SECRET || '';  // fail closed if unset (no hardcoded default)
const TOKEN_TTL_DAYS   = 7;

module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Unsubscribe from marketing drips ──────────────────────────────────────
  // Public GET from the "Unsubscribe" link in a drip email. Kept here (rather
  // than its own function) to stay under the serverless-function limit. It uses
  // its OWN signed token (service key based), so it does not depend on the
  // portal's PORTAL_SECRET being configured.
  if ((req.query && req.query.action) === 'unsubscribe') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const cid = req.query.c != null ? String(req.query.c) : '';
    const tok = req.query.t != null ? String(req.query.t) : '';
    if (!cid || !tok || tok !== unsubToken(cid)) {
      return res.status(400).send(unsubPage('Unsubscribe',
        'This unsubscribe link is invalid or incomplete. If you want to stop receiving our emails, just reply to one and let us know.'));
    }
    try {
      let email = '';
      try {
        const rows = await supa('contacts?select=email&id=eq.' + encodeURIComponent(cid) + '&limit=1');
        if (Array.isArray(rows) && rows[0] && rows[0].email) email = rows[0].email;
      } catch (e) {}
      await fetch(`${SUPA_URL}/rest/v1/drip_unsubs`, {
        method: 'POST', headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify([{ contact_id: Number(cid) || cid, email: email, created_at: new Date().toISOString() }])
      });
      await fetch(`${SUPA_URL}/rest/v1/enrollments?contactId=eq.` + encodeURIComponent(cid) + `&status=eq.active`, {
        method: 'PATCH', headers: svcHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ status: 'stopped', nextSendAt: null })
      });
      return res.status(200).send(unsubPage('Unsubscribed',
        (email ? email.replace(/[<>&]/g, '') + ' ' : 'You ')
        + 'will no longer receive our marketing emails. If this was a mistake, reply to any of our emails and we\'ll add you back.',
        'You\'re unsubscribed.'));
    } catch (e) {
      return res.status(500).send(unsubPage('Unsubscribe',
        'Something went wrong on our end. Please reply to one of our emails to be removed and we\'ll take care of it.'));
    }
  }

  // Fail closed: never sign/verify tokens without a real secret configured.
  if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

  if (req.method === 'POST' && typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch (e) {}
  }
  const q = req.query || {};
  const body = req.body || {};
  const action = q.action || body.action;

  try {
    if (action === 'request') {
      const email = (q.email || body.email || '').trim().toLowerCase();
      // Always respond the same way, whether or not the email is on file (no account enumeration).
      const generic = { ok: true };
      if (!email || email.indexOf('@') < 0) return res.status(200).json(generic);

      const rows = await supa('contacts?select=id,first,last,email,lang&email=ilike.' + encodeURIComponent(email));
      const contact = Array.isArray(rows) ? rows.find(c => (c.email || '').trim().toLowerCase() === email) : null;
      if (!contact) return res.status(200).json(generic);

      const token = signToken(contact.id);
      const link = APP_URL.replace(/\/$/, '') + '/portal?token=' + encodeURIComponent(token);
      try { await sendMagicLink(contact, link); } catch (e) { console.error('portal email failed:', e.message); }
      return res.status(200).json(generic);
    }

    if (action === 'summary') {
      const token = q.token || body.token || '';
      const data = verifyToken(token);
      if (!data) return res.status(401).json({ ok: false, error: 'link_expired' });

      const cid = data.cid;
      const [contacts, txs, team] = await Promise.all([
        supa('contacts?select=id,first,last,lang,property&id=eq.' + encodeURIComponent(cid)),
        supa('transactions?select=*&contactId=eq.' + encodeURIComponent(cid)),
        supa('team?select=*').catch(() => []),
      ]);
      const contact = (contacts || [])[0];
      if (!contact) return res.status(404).json({ ok: false, error: 'not_found' });

      const payload = buildClientView(contact, txs || [], team || []);
      return res.status(200).json({ ok: true, ...payload });
    }

    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('portal error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};

// ── Sanitized client view (status + dates only) ──────────────────────────────
function buildClientView(contact, txs, team) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dnum = d => Math.round((new Date(d) - today) / 86400000);
  const teamById = {};
  (team || []).forEach(m => { teamById[String(m.id)] = m; });

  // Milestones we're willing to show a client, in chronological order of the deal.
  const MS = [
    ['contractDate',   'Under Contract',    'Bajo Contrato'],
    ['earnestDate',    'Earnest Money Due', 'Depósito de Garantía'],
    ['dueDiligDate',   'Inspection / Due Diligence', 'Inspección'],
    ['appraisalDate',  'Appraisal',         'Avalúo'],
    ['financingDate',  'Financing Approval','Aprobación de Financiamiento'],
    ['closingDate',    'Closing',           'Cierre'],
  ];

  const active = txs.filter(t => (t.status || 'active') !== 'closed');
  const shown = active.length ? active : txs; // if nothing active, show what exists

  const deals = shown.map(tx => {
    const milestones = MS
      .filter(m => tx[m[0]])
      .map(m => ({ label_en: m[1], label_es: m[2], date: tx[m[0]], done: dnum(tx[m[0]]) < 0 }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const next = milestones.find(m => !m.done) || null;
    const agent = tx.assignedTo != null ? teamById[String(tx.assignedTo)] : null;
    return {
      address: tx.address || contact.property || '',
      status_en: (tx.status || 'active') === 'closed' ? 'Closed' : 'In Progress',
      status_es: (tx.status || 'active') === 'closed' ? 'Cerrado' : 'En Progreso',
      milestones,
      next_en: next ? next.label_en : 'Awaiting next step',
      next_es: next ? next.label_es : 'Esperando el siguiente paso',
      next_date: next ? next.date : '',
      agent_name: agent ? (agent.name || [agent.first, agent.last].filter(Boolean).join(' ')) : '',
      agent_phone: agent ? (agent.phone || '') : '',
    };
  });

  return {
    client_name: contact.first || '',
    lang: contact.lang === 'es' ? 'es' : 'en',
    deals,
  };
}

// ── Signed, expiring tokens (stateless — no extra table) ─────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signToken(cid) {
  const exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
  const payload = b64url(JSON.stringify({ cid: String(cid), exp }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return payload + '.' + sig;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let dataObj;
  try { dataObj = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }
  catch (e) { return null; }
  if (!dataObj || !dataObj.exp || Date.now() > dataObj.exp) return null;
  return dataObj;
}

// ── Supabase (service key, server-side only) ─────────────────────────────────
async function supa(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}`, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} ${text}`);
  if (!text || text === 'null') return [];
  try { return JSON.parse(text); } catch (e) { throw new Error(`JSON parse failed: ${text.slice(0, 100)}`); }
}

// Service-key headers for writes (unsubscribe records the opt-out + stops enrollments).
function svcHeaders(extra) {
  return Object.assign({ apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}`, 'Content-Type': 'application/json' }, extra || {});
}
// Unsubscribe token — MUST match api/run-drips.js (same secret + scheme).
function unsubToken(cid) {
  return crypto.createHmac('sha256', process.env.UNSUB_SECRET || SUPA_SERVICE_KEY)
    .update('unsub:' + String(cid)).digest('hex').slice(0, 32);
}
function unsubPage(title, msg, heading) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + '</title></head>'
    + '<body style="font-family:-apple-system,\'Segoe UI\',Arial,sans-serif;background:#f4f4f4;margin:0;padding:0;">'
    + '<div style="max-width:520px;margin:48px auto;background:#fff;border-radius:12px;padding:36px 32px;box-shadow:0 2px 14px rgba(0,0,0,0.08);text-align:center;">'
    + '<div style="color:#c9a84c;font-size:22px;font-weight:700;margin-bottom:12px;">Palacios Baker Real Estate</div>'
    + (heading ? '<p style="color:#333;font-size:17px;margin-bottom:8px;font-weight:600;">' + heading + '</p>' : '')
    + '<p style="color:#666;font-size:15px;line-height:1.5;">' + msg + '</p>'
    + '</div></body></html>';
}

// ── Send the magic-link email via a connected Gmail account ──────────────────
async function sendMagicLink(contact, link) {
  const tokens = await supa('gmail_tokens?select=*&limit=1');
  if (!tokens.length) throw new Error('No Gmail-connected sender available');
  const t = tokens[0];
  const accessToken = await refreshAccessToken(t.refresh_token);
  const fromEmail = t.email || null;
  const es = contact.lang === 'es';
  const subject = es ? 'Su enlace de acceso — Palacios Baker' : 'Your access link — Palacios Baker';
  const html = magicLinkHtml(contact.first || '', link, es);
  await sendEmail(accessToken, fromEmail, contact.email, subject, html);
}

async function refreshAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + (data.error || '') + ' ' + (data.error_description || ''));
  return data.access_token;
}

async function sendEmail(accessToken, fromEmail, to, subject, htmlBody) {
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const headers = [];
  if (fromEmail) headers.push(`From: "Palacios Baker Real Estate" <${fromEmail}>`);
  headers.push(`To: ${to}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', htmlBody);
  const message = headers.join('\r\n');
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!r.ok) throw new Error(JSON.stringify(await r.json()));
  return r.json();
}

function magicLinkHtml(name, link, es) {
  const gold = '#c9a84c', bg = '#0d0f14', surface = '#151820', text = '#e8eaf0', muted = '#8b90a8';
  const greeting = es ? `Hola ${name || ''},` : `Hi ${name || ''},`;
  const line = es
    ? 'Toque el botón para ver el estado de su transacción. El enlace es válido por 7 días.'
    : 'Tap the button below to view your transaction status. This link is valid for 7 days.';
  const btn = es ? 'Ver mi transacción' : 'View my transaction';
  const ignore = es ? 'Si no solicitó esto, puede ignorar este correo.' : "If you didn't request this, you can ignore this email.";
  return `<!DOCTYPE html><html><body style="margin:0;background:${bg};font-family:Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:32px 16px;"><tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${surface};border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-size:24px;letter-spacing:3px;color:${gold};font-weight:700;">PALACIOS BAKER</div>
          <div style="font-size:11px;letter-spacing:3px;color:${muted};text-transform:uppercase;margin-bottom:24px;">Real Estate</div>
          <div style="font-size:16px;color:${text};margin-bottom:8px;">${greeting}</div>
          <div style="font-size:15px;color:${muted};line-height:1.5;margin-bottom:24px;">${line}</div>
          <a href="${link}" style="display:inline-block;background:${gold};color:${bg};text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:8px;">${btn} &rarr;</a>
          <div style="font-size:12px;color:${muted};margin-top:24px;">${ignore}</div>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}
