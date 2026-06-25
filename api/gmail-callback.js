// OAuth callback - Google redirects here after user approves
export default async function handler(req, res) {
  const { code, state, error } = req.query;

  const supaUrl = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
  const supaKey = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : null)
    || ('https://' + req.headers.host);
  const redirectUri = baseUrl + '/api/gmail-callback';

  // Helper to send a page that posts a message to opener and closes
  const sendPage = (success, data) => {
    const dataJson = JSON.stringify(data)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/<\/script>/gi, '<\\/script>');

    const color = success ? '#6bc96a' : '#c94c4c';
    const title = success ? 'Gmail Connected!' : 'Connection Failed';
    const msg = success
      ? 'Connected as <b style="color:#c9a84c">' + (data.email || '') + '</b><br><small>This window will close...</small>'
      : (data.error || 'Unknown error');

    return res.status(200).send('<!DOCTYPE html><html><head><title>Gmail Auth</title></head>'
      + '<body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:#e0d9cc;text-align:center;">'
      + '<h2 style="color:' + color + '">' + title + '</h2>'
      + '<p>' + msg + '</p>'
      + '<script>'
      + 'try{'
      + '  var d=' + dataJson + ';'
      + '  if(window.opener) window.opener.postMessage(d,"*");'
      + '}catch(e){}'
      + 'setTimeout(function(){try{window.close();}catch(e){}},2000);'
      + '</script>'
      + '</body></html>');
  };

  if (error) return sendPage(false, { type: 'gmail_error', error: error });
  if (!code) return sendPage(false, { type: 'gmail_error', error: 'No authorization code received' });

  let memberId = '';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    memberId = decoded.memberId;
  } catch(e) {
    console.log('State parse error:', e.message);
  }

  console.log('Callback: memberId=' + memberId + ' redirectUri=' + redirectUri);

  try {
    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });

    const tokenText = await tokenResp.text();
    let tokens;
    try { tokens = JSON.parse(tokenText); } catch(e) {
      return sendPage(false, { type: 'gmail_error', error: 'Token parse error: ' + tokenText.substring(0, 100) });
    }

    console.log('Token status:', tokenResp.status, 'error:', tokens.error);
    if (tokens.error) return sendPage(false, { type: 'gmail_error', error: tokens.error_description || tokens.error });

    // Get user profile
    const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + tokens.access_token }
    });
    const profileText = await profileResp.text();
    let profile = {};
    try { profile = JSON.parse(profileText); } catch(e) {}
    console.log('Profile email:', profile.email);

    // Save to Supabase
    if (supaUrl && supaKey && memberId) {
      const record = {
        id: String(memberId),
        member_id: String(memberId),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
        email: profile.email || '',
        name: profile.name || ''
      };
      const saveResp = await fetch(supaUrl + '/rest/v1/gmail_tokens', {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': 'Bearer ' + supaKey,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify([record])
      });
      console.log('Supabase save status:', saveResp.status);
    }

    return sendPage(true, {
      type: 'gmail_connected',
      memberId: String(memberId),
      email: profile.email || '',
      name: profile.name || ''
    });

  } catch (err) {
    console.log('Callback error:', err.message);
    return sendPage(false, { type: 'gmail_error', error: err.message });
  }
}