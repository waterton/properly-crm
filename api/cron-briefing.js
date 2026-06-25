// /api/cron-briefing.js
// Called by Vercel Cron (every 15 min) or manually via ?secret= query param.
// Checks if it's time to send the daily briefing, then sends to all
// Google-connected team members via their own Gmail accounts.

const SUPA_URL = process.env.SUPA_URL;
const SUPA_KEY = process.env.SUPA_KEY;
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function (req, res) {
  // ── Security ──────────────────────────────────────────────────────────────
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // Manual testing uses ?secret=<CRON_SECRET>
  const authHeader = (req.headers['authorization'] || '').replace('Bearer ', '');
  const querySecret = req.query.secret;
  if (querySecret !== CRON_SECRET && authHeader !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ---- TEMP DEBUG: remove after diagnosing ----
  if (req.query.debug === '1') {
    const dbg = {
      has_service_key: !!SUPA_SERVICE_KEY,
      service_key_len: SUPA_SERVICE_KEY ? SUPA_SERVICE_KEY.length : 0,
      supa_url: SUPA_URL || 'MISSING'
    };
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.briefing_schedule&select=value`, {
        headers: { apikey: SUPA_SERVICE_KEY, Authorization: `Bearer ${SUPA_SERVICE_KEY}`, 'Content-Type': 'application/json' }
      });
      dbg.settings_status = r.status;
      dbg.settings_body = (await r.text()).slice(0, 300);
    } catch (e) { dbg.fetch_error = e.message; }
    return res.json(dbg);
  }

  try {
    // ── Load schedule from Supabase ─────────────────────────────────────────
    const schedRow = await supa('settings?key=eq.briefing_schedule&select=value');
    if (!schedRow.length) {
      return res.json({ skipped: true, reason: 'No schedule configured' });
    }
    const sched = schedRow[0].value;
    const { entries = [], timezone = 'America/Denver', lastSentByTime = {} } = sched;

    if (!entries.length) {
      return res.json({ skipped: true, reason: 'No schedule entries configured' });
    }

    // ── Find a matching entry for right now ─────────────────────────────────
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const todayName = DAY_NAMES[nowLocal.getDay()];
    const todayStr  = nowLocal.toISOString().split('T')[0];
    const currentMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();

    const matchingEntry = entries.find(function(e) {
      if (!e.days.includes(todayName)) return false;
      const [h, m] = e.time.split(':').map(Number);
      const slotMins = h * 60 + m;
      if (Math.abs(currentMins - slotMins) > 14) return false;
      // Not already sent for this time slot today
      if (lastSentByTime[e.time] === todayStr) return false;
      return true;
    });

    const forceMode = req.query.force === '1';

    if (!matchingEntry && !forceMode) {
      return res.json({ skipped: true, reason: 'No matching schedule for current time' });
    }

    // In force mode, use the first entry's timezone; otherwise use the matched entry
    if (!matchingEntry && forceMode) {
      // just continue — timezone already set, no lastSent check needed
    }

    // ── Load all data ───────────────────────────────────────────────────────
    const [contacts, followups, deadlines, tokens] = await Promise.all([
      supa('contacts?select=*'),
      supa('followups?select=*&done=is.false'),
      supa('deadlines?select=*'),
      supa('gmail_tokens?select=*'),
    ]);

    if (!tokens.length) {
      return res.json({ skipped: true, reason: 'No Gmail-connected users' });
    }

    // ── Build briefing data ─────────────────────────────────────────────────
    const today   = new Date();
    today.setHours(0, 0, 0, 0);
    const in7Days = new Date(today); in7Days.setDate(in7Days.getDate() + 7);

    const contactMap = {};
    contacts.forEach(c => { contactMap[c.id] = c; });

    const fullName = c => c ? `${c.first || ''} ${c.last || ''}`.trim() : 'Unknown';
    const fmtDate  = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const daysDiff = d => Math.round((new Date(d) - today) / 86400000);

    // Overdue follow-ups
    const overdueFU = followups.filter(f => {
      const diff = daysDiff(f.date);
      return diff < 0;
    });

    // Today's follow-ups
    const todayFU = followups.filter(f => daysDiff(f.date) === 0);

    // This week's deadlines
    const weekDL = deadlines.filter(d => {
      const n = daysDiff(d.date);
      return n >= 0 && n <= 7;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Pipeline snapshot
    const STAGES = ['New Lead', 'Contacted', 'Showing', 'Under Contract'];
    const pipeline = STAGES.map(s => ({
      stage: s,
      count: contacts.filter(c => c.stage === s).length,
    }));

    // ── Build HTML email ────────────────────────────────────────────────────
    const dateLabel = nowLocal.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const emailHtml = buildEmailHtml(dateLabel, overdueFU, todayFU, weekDL, pipeline, contactMap, fullName, fmtDate, daysDiff);
    const subject   = `Daily Briefing — ${dateLabel}`;

    // ── Send to each connected user ─────────────────────────────────────────
    const results = [];
    for (const token of tokens) {
      try {
        const freshToken = await refreshAccessToken(token.refresh_token);

        // Resolve email — use stored value or fetch from Gmail profile
        let toEmail = token.email;
        if (!toEmail) {
          const profileResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${freshToken}` }
          });
          const profile = await profileResp.json();
          toEmail = profile.emailAddress;

          // Cache it back to gmail_tokens for future runs
          if (toEmail) {
            await supa(`gmail_tokens?member_id=eq.${token.member_id}`, {
              method: 'PATCH',
              body: JSON.stringify({ email: toEmail }),
            });
          }
        }

        if (!toEmail) throw new Error('Could not resolve email address for member ' + token.member_id);

        await sendEmail(freshToken, toEmail, subject, emailHtml);
        results.push({ member: token.member_id, status: 'sent', to: toEmail });
      } catch (e) {
        results.push({ member: token.member_id, status: 'error', error: e.message });
      }
    }

    // ── Update lastSentByTime for this slot (skip in force/test mode) ────────
    if (!forceMode && matchingEntry) {
      const updatedLastSent = { ...lastSentByTime };
      updatedLastSent[matchingEntry.time] = todayStr;
      await supa('settings', {
        method: 'POST',
        body: JSON.stringify({
          key: 'briefing_schedule',
          value: { ...sched, lastSentByTime: updatedLastSent },
        }),
        headers: { 'Prefer': 'resolution=merge-duplicates' },
      });
    }

    return res.json({ sent: true, results });

  } catch (err) {
    console.error('cron-briefing error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function supa(path, opts = {}) {
  const url = `${SUPA_URL}/rest/v1/${path}`;
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPA_SERVICE_KEY,
      Authorization: `Bearer ${SUPA_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body || undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} ${text}`);
  if (!text || text === 'null') return [];
  try { return JSON.parse(text); } catch(e) { throw new Error(`JSON parse failed for ${path}: ${text.slice(0,100)}`); }
}

async function refreshAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Token refresh failed');
  return data.access_token;
}

async function sendEmail(accessToken, to, subject, htmlBody) {
  // RFC 2047 encode subject to handle non-ASCII characters (em dash, accents, etc.)
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const message = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ].join('\r\n');

  const encoded = Buffer.from(message).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(JSON.stringify(err));
  }
  return r.json();
}

function buildEmailHtml(dateLabel, overdueFU, todayFU, weekDL, pipeline, contactMap, fullName, fmtDate, daysDiff) {
  const accentGold = '#c9a84c';
  const bg         = '#0d0f14';
  const surface    = '#151820';
  const border     = '#2a2f45';
  const textLight  = '#e8eaf0';
  const textMuted  = '#8b90a8';
  const danger     = '#c94c4c';
  const warn       = '#c9a84c';

  const section = (title, color, rows) => rows.length === 0 ? '' : `
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};border-bottom:1px solid ${border};padding-bottom:8px;margin-bottom:12px;">${title}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>
    </div>`;

  const row = (left, right, rightColor = textMuted) => `
    <tr>
      <td style="padding:7px 0;font-size:14px;color:${textLight};border-bottom:1px solid ${border};">${left}</td>
      <td style="padding:7px 0;font-size:13px;color:${rightColor};text-align:right;border-bottom:1px solid ${border};white-space:nowrap;padding-left:16px;">${right}</td>
    </tr>`;

  const urgentRows = [
    ...overdueFU.map(f => row(
      `<b>${f.label}</b> — ${fullName(contactMap[f.contactId])}`,
      `${Math.abs(daysDiff(f.date))}d overdue`, danger
    )),
  ];

  const todayRows = todayFU.map(f => row(
    `<b>${f.label}</b> — ${fullName(contactMap[f.contactId])}`,
    'Due today', warn
  ));

  const dlRows = weekDL.map(d => {
    const n = daysDiff(d.date);
    const label = n === 0 ? 'TODAY' : `${n}d`;
    return row(
      `<b>${d.type}</b> — ${fullName(contactMap[d.contactId])}`,
      `${fmtDate(d.date)} (${label})`,
      n <= 2 ? warn : textMuted
    );
  });

  const pipeRows = pipeline
    .filter(p => p.count > 0)
    .map(p => row(`<b>${p.stage}</b>`, p.count));

  const hasUrgent = urgentRows.length > 0;
  const urgentNote = hasUrgent
    ? `<div style="background:rgba(201,76,76,0.12);border:1px solid rgba(201,76,76,0.3);border-radius:8px;padding:12px 16px;margin-bottom:28px;font-size:14px;color:${danger};font-weight:600;">⚠ ${urgentRows.length} overdue item${urgentRows.length > 1 ? 's' : ''} need attention</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${bg};font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:${surface};border:1px solid ${border};border-radius:12px 12px 0 0;padding:28px 32px;">
          <div style="font-family:'Bebas Neue',Arial,sans-serif;font-size:28px;letter-spacing:3px;color:${accentGold};">PALACIOS BAKER</div>
          <div style="font-size:11px;letter-spacing:3px;color:${textMuted};text-transform:uppercase;margin-bottom:4px;">Real Estate</div>
          <div style="font-size:22px;font-weight:700;color:${textLight};margin-top:16px;">Daily Briefing</div>
          <div style="font-size:14px;color:${textMuted};margin-top:4px;">${dateLabel}</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:${surface};border-left:1px solid ${border};border-right:1px solid ${border};padding:28px 32px;">
          ${urgentNote}
          ${section('🚨 Overdue', danger, urgentRows)}
          ${section('📋 Due Today', warn, todayRows)}
          ${section('📅 Deadlines This Week', accentGold, dlRows)}
          ${section('📊 Pipeline Snapshot', '#4c8ec9', pipeRows)}
          ${urgentRows.length === 0 && todayRows.length === 0 && dlRows.length === 0
            ? `<div style="text-align:center;padding:32px;color:${textMuted};font-size:14px;">All clear — no urgent items today. ✓</div>`
            : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${bg};border:1px solid ${border};border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <div style="font-size:12px;color:${textMuted};">Palacios Baker Real Estate CRM · Auto-generated briefing</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
