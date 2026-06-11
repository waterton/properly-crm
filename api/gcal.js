export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb'
    }
  }
};

// Google Calendar API - create, update, delete events
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch(e) {}
  }

  const { action, memberId, event, eventId, calendarId } = req.body || {};
  const supaUrl = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
  const supaKey = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const cal = calendarId || 'primary';

  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  try {
    // Get token from Supabase
    const tokenResp = await fetch(supaUrl + '/rest/v1/gmail_tokens?member_id=eq.' + memberId, {
      headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey, 'Accept': 'application/json' }
    });
    const tokenRaw = await tokenResp.text();
    let tokenData;
    try { tokenData = JSON.parse(tokenRaw); } catch(e) {
      return res.status(500).json({ error: 'Supabase error: ' + tokenRaw.substring(0, 100) });
    }
    if (!Array.isArray(tokenData) || !tokenData[0]) {
      return res.status(401).json({ error: 'Gmail not connected. Please connect Gmail first to enable calendar sync.' });
    }

    let tokenRecord = tokenData[0];
    let accessToken = tokenRecord.access_token;

    // Refresh if expired
    if (!accessToken || Date.now() >= (tokenRecord.expires_at - 60000)) {
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
      if (newTokens.error) return res.status(401).json({ error: 'Token refresh failed: ' + newTokens.error_description });
      accessToken = newTokens.access_token;
      tokenRecord.access_token = accessToken;
      tokenRecord.expires_at = Date.now() + ((newTokens.expires_in || 3600) * 1000);
      await fetch(supaUrl + '/rest/v1/gmail_tokens', {
        method: 'POST',
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([tokenRecord])
      });
    }

    const calBase = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal);
    const headers = { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' };

    if (action === 'create') {
      // Build Google Calendar event from CRM event data
      const gcalEvent = buildGCalEvent(event);
      const resp = await fetch(calBase + '/events', {
        method: 'POST', headers,
        body: JSON.stringify(gcalEvent)
      });
      const data = await resp.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ success: true, gcalId: data.id, link: data.htmlLink });
    }

    if (action === 'update') {
      const gcalEvent = buildGCalEvent(event);
      const resp = await fetch(calBase + '/events/' + eventId, {
        method: 'PUT', headers,
        body: JSON.stringify(gcalEvent)
      });
      const data = await resp.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ success: true, gcalId: data.id, link: data.htmlLink });
    }

    if (action === 'delete') {
      await fetch(calBase + '/events/' + eventId, { method: 'DELETE', headers });
      return res.status(200).json({ success: true });
    }

    if (action === 'list') {
      // List upcoming events for display in CRM
      const now = new Date().toISOString();
      const resp = await fetch(calBase + '/events?maxResults=50&orderBy=startTime&singleEvents=true&timeMin=' + encodeURIComponent(now), { headers });
      const data = await resp.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      const events = (data.items || []).map(e => ({
        gcalId: e.id,
        title: e.summary || '(No title)',
        date: e.start.date || (e.start.dateTime ? e.start.dateTime.substring(0,10) : ''),
        time: e.start.dateTime ? e.start.dateTime.substring(11,16) : '',
        endTime: e.end.dateTime ? e.end.dateTime.substring(11,16) : '',
        description: e.description || '',
        link: e.htmlLink,
        location: e.location || ''
      }));
      return res.status(200).json({ events });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildGCalEvent(ev) {
  // Build date/time objects
  let start, end;
  if (ev.time) {
    start = { dateTime: ev.date + 'T' + ev.time + ':00', timeZone: 'America/Denver' };
    const endTime = ev.endTime || addHour(ev.time);
    end = { dateTime: ev.date + 'T' + endTime + ':00', timeZone: 'America/Denver' };
  } else {
    start = { date: ev.date };
    end = { date: ev.date };
  }

  return {
    summary: ev.title,
    description: buildDescription(ev),
    start,
    end,
    location: ev.address || ev.location || '',
    colorId: getColorId(ev.type),
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 30 }
      ]
    }
  };
}

function addHour(time) {
  const parts = time.split(':');
  let h = parseInt(parts[0]) + 1;
  if (h >= 24) h = 23;
  return String(h).padStart(2,'0') + ':' + parts[1];
}

function buildDescription(ev) {
  const lines = ['Created by Properly CRM - Palacios Baker Real Estate'];
  if (ev.clientName) lines.push('Client: ' + ev.clientName);
  if (ev.address) lines.push('Property: ' + ev.address);
  if (ev.notes) lines.push('Notes: ' + ev.notes);
  if (ev.type) lines.push('Type: ' + ev.type);
  return lines.join('\n');
}

function getColorId(type) {
  const colors = {
    deadline: '11',      // red
    followup: '10',      // green
    closing: '11',       // red
    showing: '7',        // teal
    consultation: '9',   // blueberry
    openhouse: '6',      // banana
    call: '8',           // graphite
    meeting: '9',        // blueberry
    transaction: '5',    // banana
    custom: '1'          // lavender
  };
  return colors[type] || '1';
}
