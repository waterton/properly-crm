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
const APP_URL = process.env.APP_URL || 'https://properly-crm.vercel.app';

module.exports = async function (req, res) {
  // ── Security ──────────────────────────────────────────────────────────────
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // Manual testing uses ?secret=<CRON_SECRET>
  const authHeader = (req.headers['authorization'] || '').replace('Bearer ', '');
  const querySecret = req.query.secret;
  if (querySecret !== CRON_SECRET && authHeader !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
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
    const [contacts, followups, deadlines, tokens, transactions, notes, documents] = await Promise.all([
      supa('contacts?select=*'),
      supa('followups?select=*&done=is.false'),
      supa('deadlines?select=*'),
      supa('gmail_tokens?select=*'),
      supa('transactions?select=*'),
      supa('notes?select=*'),
      supa('documents?select=*').catch(() => []),
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

    // ── Drop orphaned / stale rows so the email matches what the app actually shows ──────────
    // A deadline or follow-up is real ONLY if it's still attached to something that exists:
    //   - its transaction still exists AND isn't closed, or
    //   - (no transaction) its contact still exists, or
    //   - it's a personal reminder (no transaction, no contact).
    // Leftover test rows whose transaction/contact was deleted are ignored - they were showing
    // up as bogus "overdue" priorities even though the CRM is empty.
    const _txById = {}; (transactions || []).forEach(t => { _txById[String(t.id)] = t; });
    const isLive = row => {
      if (row.transactionId != null) {
        const tx = _txById[String(row.transactionId)];
        if (!tx) return false;                                  // transaction deleted -> orphan
        if ((tx.status || 'active') === 'closed') return false; // closed deal -> not a live item
        return true;
      }
      if (row.contactId != null) return !!contactMap[row.contactId]; // contact must still exist
      // Personal reminder (no transaction, no contact): a one-time nudge. Once its date has
      // passed it has already fired and is "done" - the app hides it, so the email must too.
      return row.date ? daysDiff(row.date) >= 0 : true;
    };
    // A transaction deadline whose matching checklist step is checked is done - the app hides it,
    // so the email must too (keeps "earnest money overdue" from nagging after it's received).
    const _stepKeys = {
      'Earnest Money Due':      ['b3_earnest','s3_earnest'],
      'Due Diligence Deadline': ['b3_duedilig','s3_duedilig'],
      'Financing Deadline':     ['b3_financing','s3_financing'],
      // New single key + legacy "appraisal completed" keys so pre-migration deals stay hidden.
      'Appraisal Deadline':     ['b3_appr','s3_appr','b3_apprloan','s3_appraisaldone'],
    };
    // Appraisal is a real completion checkbox: once checked it's done and hides regardless of date.
    // The other date deadlines auto-track on import, so only an OVERDUE one is safe to auto-hide.
    const _completionTypes = { 'Appraisal Deadline': true };
    const stepDone = d => {
      if (d.transactionId == null || !d.date) return false;
      const tx = _txById[String(d.transactionId)];
      if (!tx || !tx.steps) return false;
      const keys = _stepKeys[d.type]; if (!keys) return false;
      if (!_completionTypes[d.type] && daysDiff(d.date) >= 0) return false;  // tracking steps: overdue only
      return keys.some(k => tx.steps[k]);
    };
    const liveDeadlines = (deadlines || []).filter(isLive).filter(d => !stepDone(d));
    const liveFollowups = (followups || []).filter(isLive);

    // Overdue follow-ups
    const overdueFU = liveFollowups.filter(f => {
      const diff = daysDiff(f.date);
      return diff < 0;
    });

    // Today's follow-ups
    const todayFU = liveFollowups.filter(f => daysDiff(f.date) === 0);

    // This week's deadlines
    const weekDL = liveDeadlines.filter(d => {
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

    // ── Contract intelligence: cross-document discrepancies + AI advisory (active deals only) ──
    const docsByTx = {};
    (documents || []).forEach(d => {
      if (!d.extracted || d.transaction_id == null) return;
      (docsByTx[String(d.transaction_id)] = docsByTx[String(d.transaction_id)] || []).push(d);
    });
    const activeTx = (transactions || []).filter(t => (t.status || 'active') !== 'closed');
    const docReview = [];   // {who, sev, msg} for the Document Review section
    const discPriorities = []; // red discrepancies that should rank in Today's Priorities
    activeTx.forEach(tx => {
      const docs = docsByTx[String(tx.id)];
      if (!docs || !docs.length) return;
      const who = tx.address || fullName(contactMap[tx.contactId]);
      const dismissed = Array.isArray(tx.dismissedRisks) ? tx.dismissedRisks : [];
      const isDone = k => k && dismissed.indexOf(k) >= 0;   // reviewed in-app -> don't nag by email
      const intel = computeTxIntelEmail(tx, docs, fmtDate);
      intel.discrepancies.forEach(r => {
        if (isDone(r.key)) return;
        docReview.push({ who, sev: r.sev, msg: r.msg });
        if (r.sev === 'red') discPriorities.push({ score: 980, sev: 'red', who, reason: r.msg });
      });
      intel.aiFlags.forEach(f => { if (!isDone(f.key)) docReview.push({ who, sev: 'ai', msg: f.msg + ' — ' + f.src }); });
    });

    const priorities = computeEmailPriorities(transactions || [], liveDeadlines, liveFollowups, notes || [], contactMap, fullName, fmtDate, daysDiff, discPriorities);
    const rundown = await geminiRundown(priorities);
    const emailHtml = buildEmailHtml(dateLabel, overdueFU, todayFU, weekDL, pipeline, contactMap, fullName, fmtDate, daysDiff, priorities, rundown, transactions || [], docReview);
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
  if (!data.access_token) throw new Error('Token refresh failed: ' + (data.error || '') + ' - ' + (data.error_description || JSON.stringify(data)));
  return data.access_token;
}

async function sendEmail(accessToken, to, subject, htmlBody) {
  // RFC 2047 encode subject to handle non-ASCII characters (em dash, accents, etc.)
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const message = [
    `From: "Palacios Baker CRM" <${to}>`,
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

// One warm AI sentence over the priorities. Grounded in the computed list; fails to '' quietly.
async function geminiRundown(priorities) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !priorities || !priorities.length) return '';
  const lines = priorities.slice(0, 15).map(p => (p.sev === 'red' ? '[urgent] ' : '') + p.who + ': ' + p.reason).join('\n');
  const prompt = 'You are a concise assistant for a busy real estate agent. Below is their ranked to-do list for today. '
    + 'Write ONE warm, natural sentence (about 25-30 words max) that summarizes the most important 1-3 items so they know their day at a glance. '
    + 'Be specific with names and timeframes. Do NOT invent anything that is not in the list.\n\nLIST:\n' + lines;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 120 } })
    });
    const d = await r.json();
    const t = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0]
      ? d.candidates[0].content.parts[0].text : '';
    return (t || '').trim();
  } catch (e) { return ''; }
}

// Server-side mirror of the app's Today's Priorities - deterministic, ranked, explainable.
function _parsePriceNum(s){ if(s==null) return 0; const n=parseFloat(String(s).replace(/[^0-9.]/g,'')); return isNaN(n)?0:n; }

// Server-side twin of the app's computeTxIntel: deterministic cross-document discrepancies plus
// the scanner's own AI redFlags. Reads each document's stored extraction (documents.extracted).
function computeTxIntelEmail(tx, docs, fmtDate) {
  const out = { discrepancies: [], aiFlags: [] };
  if (!tx || !docs || !docs.length) return out;
  const docLabel = d => {
    const e = d.extracted || {}, t = e.docType || d.doc_type || 'Document';
    return (/addendum/i.test(t) && e.addendumNumber) ? 'Addendum #' + e.addendumNumber : t;
  };
  const seen = {};
  docs.forEach(d => {
    ((d.extracted && d.extracted.redFlags) || []).forEach(f => {
      if (!f) return; const key = String(f).trim().toLowerCase();
      if (!key || seen[key]) return; seen[key] = true;
      out.aiFlags.push({ msg: String(f).trim(), src: docLabel(d), key: 'ai:' + key });
    });
  });
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  [['buyerName','Buyer name'],['sellerName','Seller name'],['address','Property address']].forEach(pair => {
    const field = pair[0], label = pair[1], vals = [];
    docs.forEach(d => { const e = d.extracted || {}; const v = (e[field] || '').trim(); if (v) vals.push({ v, n: norm(v), src: docLabel(d) }); });
    for (let i = 1; i < vals.length; i++) {
      if (vals[i].n !== vals[0].n) { out.discrepancies.push({ sev:'caution', key: 'party:'+field+':'+vals[0].n+'|'+vals[i].n, msg: `${label} differs across documents: "${vals[0].v}" (${vals[0].src}) vs "${vals[i].v}" (${vals[i].src}).` }); break; }
    }
  });
  const addNum = d => { const e = d.extracted || {}, t = e.docType || d.doc_type || ''; return /addendum/i.test(t) ? (parseInt(e.addendumNumber,10)||0) : -1; };
  const authorityFor = field => {
    let best = null, bestRank = -2;
    docs.forEach(d => { const e = d.extracted || {}; const v = (e[field] || '').toString().trim(); if (!v) return; const rank = addNum(d); if (rank > bestRank) { bestRank = rank; best = { v, src: docLabel(d) }; } });
    return best;
  };
  [['closingDate','closingDate','Closing date'],
   ['earnestMoneyDeadline','earnestDate','Earnest money deadline'],
   ['dueDiligenceDeadline','dueDiligDate','Due diligence deadline'],
   ['financingDeadline','financingDate','Financing deadline'],
   ['appraisalDeadline','appraisalDate','Appraisal deadline']].forEach(m => {
    const auth = authorityFor(m[0]); if (!auth) return;
    const txv = (tx[m[1]] || '').toString().trim();
    if (txv && auth.v && txv !== auth.v) out.discrepancies.push({ sev:'red', key: 'val:'+m[1]+':'+auth.v+'>'+txv, msg: `${m[2]}: ${auth.src} shows ${fmtDate(auth.v)}, but the transaction has ${fmtDate(txv)}. Confirm the transaction reflects the latest document.` });
  });
  const pAuth = authorityFor('purchasePrice');
  if (pAuth && tx.price) { const pa = _parsePriceNum(pAuth.v), pb = _parsePriceNum(tx.price); if (pa && pb && Math.abs(pa-pb)/pb >= 0.005) out.discrepancies.push({ sev:'red', key: 'val:price:'+pAuth.v+'>'+tx.price, msg: `Purchase price: ${pAuth.src} shows ${pAuth.v}, but the transaction has ${tx.price}.` }); }
  [['listingCommissionPct','listCommissionPct','Listing commission'],
   ['buyerCommissionPct','buyerCommissionPct','Buyer commission']].forEach(m => {
    const auth = authorityFor(m[0]); if (!auth) return;
    const txv = (tx[m[1]] != null ? String(tx[m[1]]) : '').trim();
    if (txv && auth.v && parseFloat(auth.v) !== parseFloat(txv)) out.discrepancies.push({ sev:'caution', key: 'val:'+m[1]+':'+auth.v+'>'+txv, msg: `${m[2]}: ${auth.src} shows ${auth.v}%, but the transaction has ${txv}%.` });
  });
  return out;
}

function computeEmailPriorities(transactions, deadlines, followups, notes, contactMap, fullName, fmtDate, daysDiff, extraItems) {
  const items = [];
  const active = transactions.filter(t => (t.status || 'active') !== 'closed');
  const txById = {}; transactions.forEach(t => { txById[String(t.id)] = t; });
  const who = (tx) => (tx && tx.address) ? tx.address : fullName(contactMap[tx && tx.contactId]);
  // Resolve a name via contact, else the deal's transaction (its contact or address) - avoids "Unknown".
  const whoFor = (contactId, transactionId) => {
    const c = contactMap[contactId]; if (c) return fullName(c);
    const tx = transactionId != null ? txById[String(transactionId)] : null;
    if (tx) { const tc = contactMap[tx.contactId]; if (tc) return fullName(tc); if (tx.address) return tx.address; }
    return 'a deal';
  };
  const dlLabel = { earnestDate:'Earnest money deadline', dueDiligDate:'Due diligence deadline', financingDate:'Financing deadline', appraisalDate:'Appraisal deadline' };

  // 1. Serious risk flags on active deals.
  active.forEach(tx => {
    if (!tx.closingDate) items.push({ score:1000, sev:'red', who:who(tx), reason:'No closing / settlement date set.' });
    ['earnestDate','dueDiligDate','financingDate','appraisalDate'].forEach(k => {
      if (tx[k] && tx.closingDate && tx[k] > tx.closingDate) items.push({ score:1000, sev:'red', who:who(tx), reason:(dlLabel[k]||k)+' falls after closing.' });
    });
    if (tx.contractDate && tx.financingDate) { const d = daysDiff(tx.financingDate) - daysDiff(tx.contractDate); if (d >= 0 && d < 14) items.push({ score:640, sev:'caution', who:who(tx), reason:'Financing deadline only '+d+'d after contract - tight.' }); }
  });
  // 2. Deadlines that are overdue or within ~2 days (imminent - true "today" priorities).
  deadlines.forEach(d => {
    const n = d.date ? daysDiff(d.date) : null; if (n == null || n > 2) return;
    items.push({ score:760-n*20, sev:(n<=1?'red':'caution'), who:whoFor(d.contactId, d.transactionId),
      reason:d.type+' '+(n<0?(Math.abs(n)+'d overdue'):n===0?'today':n===1?'tomorrow':'in '+n+' days')+' ('+fmtDate(d.date)+')' });
  });
  // 3. Overdue follow-ups.
  followups.forEach(f => {
    const n = f.date ? daysDiff(f.date) : null; if (n == null || n > 0) return;
    items.push({ score:820+Math.min(Math.abs(n),30)*4, sev:(n<0?'red':'caution'), who:whoFor(f.contactId, f.transactionId),
      reason:(n===0?'Follow-up due today':'Follow-up '+Math.abs(n)+'d overdue')+': '+f.label });
  });
  // 4. Deals gone quiet.
  active.filter(t => t.contractDate).forEach(tx => {
    let next = null;
    ['financingDate','dueDiligDate','appraisalDate','closingDate','earnestDate'].forEach(k => { if (tx[k]) { const n = daysDiff(tx[k]); if (n >= 0 && (next == null || n < next)) next = n; } });
    if (next == null || next > 14) return;
    let last = null;
    notes.forEach(nn => { if (String(nn.contactId) === String(tx.contactId)) { const t = new Date(nn.date).getTime(); if (!isNaN(t) && (last == null || t > last)) last = t; } });
    const since = last != null ? Math.round((Date.now() - last) / 86400000) : null;
    if (since != null && since < 7) return;
    items.push({ score:520+(14-next)*8, sev:'caution', who:who(tx), reason:'Deadline in '+next+'d, nothing logged '+(since==null?'yet':'in '+since+'d')+'.' });
  });

  (extraItems || []).forEach(it => items.push(it));
  items.sort((a, b) => b.score - a.score);
  return items;
}

function buildEmailHtml(dateLabel, overdueFU, todayFU, weekDL, pipeline, contactMap, fullName, fmtDate, daysDiff, priorities, rundown, transactions, docReview) {
  const _txById = {}; (transactions || []).forEach(t => { _txById[String(t.id)] = t; });
  const whoFor = (contactId, transactionId) => {
    const c = contactMap[contactId]; if (c) return fullName(c);
    const tx = transactionId != null ? _txById[String(transactionId)] : null;
    if (tx) { const tc = contactMap[tx.contactId]; if (tc) return fullName(tc); if (tx.address) return tx.address; }
    return 'a deal';
  };
  const accentGold = '#c9a84c';
  const bg         = '#0d0f14';
  const surface    = '#151820';
  const border     = '#2a2f45';
  const textLight  = '#e8eaf0';
  const textMuted  = '#8b90a8';
  const danger     = '#c94c4c';
  const warn       = '#c9a84c';

  const section = (title, color, rows, href) => rows.length === 0 ? '' : `
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${color};border-bottom:1px solid ${border};padding-bottom:8px;margin-bottom:12px;">${href ? `<a href="${href}" style="color:${color};text-decoration:none;">${title} &rarr;</a>` : title}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>
    </div>`;

  const row = (left, right, rightColor = textMuted) => `
    <tr>
      <td style="padding:7px 0;font-size:14px;color:${textLight};border-bottom:1px solid ${border};">${left}</td>
      <td style="padding:7px 0;font-size:13px;color:${rightColor};text-align:right;border-bottom:1px solid ${border};white-space:nowrap;padding-left:16px;">${right}</td>
    </tr>`;

  const urgentRows = [
    ...overdueFU.map(f => row(
      `<b>${f.label}</b> — ${whoFor(f.contactId, f.transactionId)}`,
      `${Math.abs(daysDiff(f.date))}d overdue`, danger
    )),
  ];

  const todayRows = todayFU.map(f => row(
    `<b>${f.label}</b> — ${whoFor(f.contactId, f.transactionId)}`,
    'Due today', warn
  ));

  const dlRows = weekDL.map(d => {
    const n = daysDiff(d.date);
    const label = n === 0 ? 'TODAY' : `${n}d`;
    return row(
      `<b>${d.type}</b> — ${whoFor(d.contactId, d.transactionId)}`,
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
          <a href="${APP_URL}" style="display:inline-block;margin-top:18px;background:${accentGold};color:${bg};text-decoration:none;font-weight:700;font-size:14px;padding:11px 24px;border-radius:8px;">Open CRM &rarr;</a>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:${surface};border-left:1px solid ${border};border-right:1px solid ${border};padding:28px 32px;">
          ${rundown ? `<div style="background:rgba(201,168,76,0.1);border-left:3px solid ${accentGold};border-radius:6px;padding:14px 16px;margin-bottom:24px;font-size:16px;color:${textLight};line-height:1.5;">${rundown}</div>` : ''}
          ${urgentNote}
          ${section("⚡ Today's Priorities", accentGold, (priorities || []).slice(0, 15).map(p => row(
            `<span style="color:${p.sev === 'red' ? danger : warn};">&#9679;</span> <b>${p.who}</b> &mdash; ${p.reason}`,
            '', textMuted
          )), APP_URL)}
          ${section('⚠ Document Review', '#c97a4c', (docReview || []).map(d => row(
            `<span style="color:${d.sev === 'red' ? danger : (d.sev === 'ai' ? accentGold : warn)};">&#9679;</span> <b>${d.who}</b> &mdash; ${d.msg}${d.sev === 'ai' ? ' <span style="color:'+textMuted+';font-size:11px;">(AI · verify)</span>' : ''}`,
            '', textMuted
          )), APP_URL)}
          ${section('🚨 Overdue', danger, urgentRows, `${APP_URL}#followups`)}
          ${section('📋 Due Today', warn, todayRows, `${APP_URL}#followups`)}
          ${section('📅 Deadlines This Week', accentGold, dlRows, `${APP_URL}#deadlines`)}
          ${section('📊 Pipeline Snapshot', '#4c8ec9', pipeRows, `${APP_URL}#dashboard`)}
          ${urgentRows.length === 0 && todayRows.length === 0 && dlRows.length === 0
            ? `<div style="text-align:center;padding:32px;color:${textMuted};font-size:14px;">All clear — no urgent items today. ✓</div>`
            : ''}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${bg};border:1px solid ${border};border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <div style="font-size:12px;color:${textMuted};"><a href="${APP_URL}" style="color:${accentGold};text-decoration:none;">Open the CRM</a> · Palacios Baker Real Estate · Auto-generated briefing</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
