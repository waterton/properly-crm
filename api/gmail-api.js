// Gmail API proxy - handles inbox, threads, send, attachments
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, memberId, query, threadId, messageId, to, subject, body, attachmentId, replyTo } = req.body;
  const supaUrl = process.env.SUPA_URL;
  const supaKey = process.env.SUPA_KEY;
  const baseUrl = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : process.env.APP_URL;

  try {
    // Get fresh access token
    const authResp = await fetch(baseUrl + '/api/gmail-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', memberId })
    });
    const authData = await authResp.json();
    if (!authData.access_token) return res.status(401).json({ error: 'Not connected. Please connect Gmail first.' });
    const token = authData.access_token;

    const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    if (action === 'inbox') {
      // Fetch recent emails
      const q = query || 'in:inbox';
      const listResp = await fetch(`${gmailBase}/messages?maxResults=25&q=${encodeURIComponent(q)}`, { headers });
      const listData = await listResp.json();
      if (!listData.messages) return res.status(200).json({ messages: [] });

      // Fetch message details in parallel (limit to 15)
      const msgs = await Promise.all(
        listData.messages.slice(0, 15).map(async (m) => {
          const msgResp = await fetch(`${gmailBase}/messages/${m.id}?format=metadata&metadataHeaders=From,To,Subject,Date`, { headers });
          return msgResp.json();
        })
      );

      const parsed = msgs.map(m => {
        const hdrs = {};
        (m.payload && m.payload.headers || []).forEach(h => { hdrs[h.name] = h.value; });
        return {
          id: m.id,
          threadId: m.threadId,
          from: hdrs['From'] || '',
          to: hdrs['To'] || '',
          subject: hdrs['Subject'] || '(No subject)',
          date: hdrs['Date'] || '',
          snippet: m.snippet || '',
          unread: m.labelIds && m.labelIds.includes('UNREAD'),
          hasAttachment: m.payload && m.payload.parts && m.payload.parts.some(p => p.filename && p.filename.length > 0)
        };
      });
      return res.status(200).json({ messages: parsed });
    }

    if (action === 'thread') {
      // Get full thread
      const tResp = await fetch(`${gmailBase}/threads/${threadId}?format=full`, { headers });
      const tData = await tResp.json();

      const messages = (tData.messages || []).map(m => {
        const hdrs = {};
        (m.payload && m.payload.headers || []).forEach(h => { hdrs[h.name] = h.value; });

        // Extract body
        let bodyText = '';
        let bodyHtml = '';
        const extractBody = (part) => {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            bodyText = Buffer.from(part.body.data, 'base64').toString('utf8');
          }
          if (part.mimeType === 'text/html' && part.body && part.body.data) {
            bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf8');
          }
          if (part.parts) part.parts.forEach(extractBody);
        };
        if (m.payload) extractBody(m.payload);

        // Get attachments
        const attachments = [];
        const getAttachments = (part) => {
          if (part.filename && part.filename.length > 0 && part.body) {
            attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
          }
          if (part.parts) part.parts.forEach(getAttachments);
        };
        if (m.payload) getAttachments(m.payload);

        return {
          id: m.id,
          from: hdrs['From'] || '',
          to: hdrs['To'] || '',
          subject: hdrs['Subject'] || '',
          date: hdrs['Date'] || '',
          bodyText, bodyHtml, attachments,
          unread: m.labelIds && m.labelIds.includes('UNREAD')
        };
      });

      // Mark as read
      await fetch(`${gmailBase}/messages/${messages[messages.length-1].id}/modify`, {
        method: 'POST', headers,
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
      });

      return res.status(200).json({ messages });
    }

    if (action === 'attachment') {
      // Fetch attachment data for scanning
      const attResp = await fetch(`${gmailBase}/messages/${messageId}/attachments/${attachmentId}`, { headers });
      const attData = await attResp.json();
      return res.status(200).json({ data: attData.data, size: attData.size });
    }

    if (action === 'send') {
      // Send email
      const emailLines = [
        'To: ' + to,
        'Subject: ' + subject,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        body
      ];
      if (replyTo) {
        emailLines.unshift('In-Reply-To: ' + replyTo);
        emailLines.unshift('References: ' + replyTo);
      }
      const raw = Buffer.from(emailLines.join('\r\n')).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const sendResp = await fetch(`${gmailBase}/messages/send`, {
        method: 'POST', headers,
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) })
      });
      const sendData = await sendResp.json();
      if (sendData.error) return res.status(400).json({ error: sendData.error.message });
      return res.status(200).json({ success: true, messageId: sendData.id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('gmail-api error:', err);
    return res.status(500).json({ error: err.message });
  }
}
