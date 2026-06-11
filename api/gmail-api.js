// Gmail API proxy - handles inbox, threads, send, attachments
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body if string
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch(e) {}
  }

  const { action, memberId, query, threadId, messageId, to, subject, body, attachmentId, replyTo } = req.body || {};
  // Use env vars with hardcoded fallbacks
  const supaUrl = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
  const supaKey = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  console.log('gmail-api called:', action, 'memberId:', memberId);
  console.log('Env check - SUPA_URL:', !!supaUrl, 'SUPA_KEY:', !!supaKey, 'CLIENT_ID:', !!clientId, 'CLIENT_SECRET:', !!clientSecret);

  if (!memberId) return res.status(400).json({ error: 'memberId required' });
  if (!supaUrl || !supaKey) return res.status(500).json({ error: 'SUPA_URL and SUPA_KEY environment variables not set in Vercel' });
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables not set in Vercel' });

  try {
    // Get token directly from Supabase instead of calling another function
    const tokenResp = await fetch(supaUrl + '/rest/v1/gmail_tokens?member_id=eq.' + memberId, {
      headers: {
        'apikey': supaKey,
        'Authorization': 'Bearer ' + supaKey,
        'Accept': 'application/json'
      }
    });

    const tokenRawText = await tokenResp.text();
    console.log('Token lookup status:', tokenResp.status, 'body preview:', tokenRawText.substring(0, 100));

    let tokenData;
    try {
      tokenData = JSON.parse(tokenRawText);
    } catch(e) {
      return res.status(500).json({
        error: 'Supabase returned invalid response (status ' + tokenResp.status + '). Check SUPA_URL and SUPA_KEY in Vercel environment variables. Preview: ' + tokenRawText.substring(0, 100)
      });
    }

    if (!Array.isArray(tokenData) || !tokenData[0]) {
      return res.status(401).json({ error: 'Gmail not connected for this member. Please connect Gmail first. Supabase response: ' + JSON.stringify(tokenData).substring(0, 100) });
    }

    let tokenRecord = tokenData[0];
    let accessToken = tokenRecord.access_token;

    // Refresh token if expired or close to expiry
    if (!accessToken || Date.now() >= (tokenRecord.expires_at - 60000)) {
      console.log('Refreshing token...');
      if (!tokenRecord.refresh_token) {
        return res.status(401).json({ error: 'No refresh token. Please reconnect Gmail.' });
      }
      const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: tokenRecord.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token'
        }).toString()
      });
      const newTokens = await refreshResp.json();
      if (newTokens.error) {
        return res.status(401).json({ error: 'Token refresh failed: ' + newTokens.error_description });
      }
      accessToken = newTokens.access_token;
      tokenRecord.access_token = accessToken;
      tokenRecord.expires_at = Date.now() + ((newTokens.expires_in || 3600) * 1000);
      // Save updated token
      await fetch(supaUrl + '/rest/v1/gmail_tokens', {
        method: 'POST',
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([tokenRecord])
      });
    }

    const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const headers = { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' };

    if (action === 'inbox') {
      const q = query || 'in:inbox';
      console.log('Fetching inbox, query:', q);
      const listResp = await fetch(`${gmailBase}/messages?maxResults=20&q=${encodeURIComponent(q)}`, { headers });
      const listRawText = await listResp.text();
      console.log('List response status:', listResp.status, 'preview:', listRawText.substring(0, 200));
      let listData;
      try { listData = JSON.parse(listRawText); } catch(e) {
        return res.status(500).json({ error: 'Gmail list parse error: ' + listRawText.substring(0, 200) });
      }
      if (listData.error) return res.status(400).json({ error: listData.error.message });
      if (!listData.messages) return res.status(200).json({ messages: [] });

      const msgs = await Promise.all(
        listData.messages.slice(0, 15).map(async (m) => {
          // Use format=metadata without header filter - gets all headers
          const msgResp = await fetch(`${gmailBase}/messages/${m.id}?format=metadata`, { headers });
          const msgData = await msgResp.json();
          return msgData;
        })
      );

      // Log first message headers for debugging
      if (msgs[0] && msgs[0].payload && msgs[0].payload.headers) {
        console.log('First message headers:', JSON.stringify(msgs[0].payload.headers));
      } else {
        console.log('First message structure:', JSON.stringify(Object.keys(msgs[0] || {})));
        console.log('First message payload keys:', JSON.stringify(Object.keys((msgs[0] && msgs[0].payload) || {})));
      }

      const parsed = msgs.filter(m => m && m.id).map(m => {
        const hdrs = {};
        ((m.payload && m.payload.headers) || []).forEach(h => {
          hdrs[h.name] = h.value;
          hdrs[h.name.toLowerCase()] = h.value; // case-insensitive fallback
        });
        const hasParts = m.payload && m.payload.parts;
        return {
          id: m.id,
          threadId: m.threadId,
          from: hdrs['From'] || hdrs['from'] || '',
          to: hdrs['To'] || hdrs['to'] || '',
          subject: hdrs['Subject'] || hdrs['subject'] || '(No subject)',
          date: hdrs['Date'] || hdrs['date'] || '',
          snippet: m.snippet || '',
          unread: m.labelIds && m.labelIds.includes('UNREAD'),
          hasAttachment: hasParts && m.payload.parts.some(p => p.filename && p.filename.length > 0)
        };
      });
      return res.status(200).json({ messages: parsed });
    }

    if (action === 'thread') {
      const tResp = await fetch(`${gmailBase}/threads/${threadId}?format=full`, { headers });
      const tData = await tResp.json();
      if (tData.error) return res.status(400).json({ error: tData.error.message });

      const messages = (tData.messages || []).map(m => {
        const hdrs = {};
        ((m.payload && m.payload.headers) || []).forEach(h => {
          hdrs[h.name] = h.value;
          hdrs[h.name.toLowerCase()] = h.value;
        });

        let bodyText = '';
        let bodyHtml = '';
        const extractBody = (part) => {
          if (!part) return;
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            try { bodyText = Buffer.from(part.body.data, 'base64').toString('utf8'); } catch(e) {}
          }
          if (part.mimeType === 'text/html' && part.body && part.body.data) {
            try { bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf8'); } catch(e) {}
          }
          if (part.parts) part.parts.forEach(extractBody);
        };
        if (m.payload) extractBody(m.payload);

        const attachments = [];
        const getAttachments = (part) => {
          if (!part) return;
          if (part.filename && part.filename.length > 0 && part.body) {
            attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
          }
          if (part.parts) part.parts.forEach(getAttachments);
        };
        if (m.payload) getAttachments(m.payload);

        return { id: m.id, from: hdrs['From']||hdrs['from']||'', to: hdrs['To']||hdrs['to']||'', subject: hdrs['Subject']||hdrs['subject']||'(No subject)', date: hdrs['Date']||hdrs['date']||'', bodyText, bodyHtml, attachments, unread: m.labelIds && m.labelIds.includes('UNREAD') };
      });

      // Mark thread as read
      if (messages.length) {
        await fetch(`${gmailBase}/messages/${messages[messages.length-1].id}/modify`, {
          method: 'POST', headers,
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
        });
      }
      return res.status(200).json({ messages });
    }

    if (action === 'attachment') {
      const attResp = await fetch(`${gmailBase}/messages/${messageId}/attachments/${attachmentId}`, { headers });
      const attData = await attResp.json();
      if (attData.error) return res.status(400).json({ error: attData.error.message });
      return res.status(200).json({ data: attData.data, size: attData.size });
    }

    if (action === 'send') {
      const emailLines = [
        'To: ' + to,
        'Subject: ' + subject,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        body || ''
      ];
      if (replyTo) {
        emailLines.unshift('References: ' + replyTo);
        emailLines.unshift('In-Reply-To: ' + replyTo);
      }
      const raw = Buffer.from(emailLines.join('\r\n'))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const sendBody = { raw };
      if (threadId) sendBody.threadId = threadId;

      const sendResp = await fetch(`${gmailBase}/messages/send`, {
        method: 'POST', headers,
        body: JSON.stringify(sendBody)
      });
      const sendData = await sendResp.json();
      if (sendData.error) return res.status(400).json({ error: sendData.error.message });
      return res.status(200).json({ success: true, messageId: sendData.id });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('gmail-api error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
}
