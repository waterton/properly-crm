// Gmail OAuth + Calendar handler v2
// Handles: /api/gmail-auth?action=url&memberId=X  -> returns auth URL
//          /api/gmail-auth?action=callback&code=X&memberId=X -> exchanges code for tokens
//          /api/gmail-auth?action=refresh&memberId=X -> refreshes access token
//          /api/gmail-auth?action=revoke&memberId=X -> revokes access

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar'
].join(' ');

// In-memory token store per member (Vercel functions are stateless so we use Supabase)
async function supabaseRequest(supaUrl, supaKey, method, path, body) {
  const resp = await fetch(supaUrl + '/rest/v1/' + path, {
    method: method,
    headers: {
      'apikey': supaKey,
      'Authorization': 'Bearer ' + supaKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body for POST requests
  if (req.method === 'POST' && typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch(e) {}
  }

  console.log('gmail-auth called:', req.method, 'action:', req.query.action || (req.body && req.body.action));

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const supaUrl = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
 const supaKey = process.env.SUPA_SERVICE_KEY || process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
  // Build base URL - try multiple sources
  var baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : null)
    || (req.headers.host ? 'https://' + req.headers.host : null)
    || 'https://properly-crm.vercel.app';
  console.log('Using baseUrl:', baseUrl);

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set' });
  }

  const action = req.query.action || (req.body && req.body.action);
  const memberId = req.query.memberId || (req.body && req.body.memberId);

  try {
    if (action === 'url') {
      // Generate OAuth URL
      const redirectUri = baseUrl + '/api/gmail-callback';
      const state = Buffer.from(JSON.stringify({ memberId })).toString('base64');
      // 'select_account' is essential: with 'consent' alone Google silently uses whichever
      // Google account is already signed into the browser. Connecting Elda's Gmail while
      // signed in as Randy handed over Randy's mailbox and filed it under Elda's member id.
      const authParams = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'select_account consent',
        state: state
      };
      // Pre-highlight the expected account in the chooser (still overridable by the user).
      const hint = req.query.hint || req.query.login_hint;
      if (hint) authParams.login_hint = hint;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(authParams);
      return res.status(200).json({ url: authUrl });
    }

    if (action === 'exchange') {
      // Exchange auth code for tokens
      const { code } = req.body;
      const redirectUri = baseUrl + '/api/gmail-callback';
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenResp.json();
      if (tokens.error) return res.status(400).json({ error: tokens.error_description });

      // Get user email
      const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': 'Bearer ' + tokens.access_token }
      });
      const profile = await profileResp.json();

      // Store tokens in Supabase
      if (supaUrl && supaKey) {
        await supabaseRequest(supaUrl, supaKey, 'POST', 'gmail_tokens', [{
          id: String(memberId),
          member_id: String(memberId),
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + (tokens.expires_in * 1000),
          email: profile.email,
          name: profile.name
        }]);
      }

      return res.status(200).json({
        success: true,
        email: profile.email,
        name: profile.name
      });
    }

    if (action === 'refresh') {
      // Get stored tokens
      const stored = await supabaseRequest(supaUrl, supaKey, 'GET', 'gmail_tokens?member_id=eq.' + memberId);
      if (!stored || !stored[0]) return res.status(404).json({ error: 'No tokens found for member' });
      const t = stored[0];

      // Refresh if expired
      if (Date.now() >= t.expires_at - 60000) {
        const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            refresh_token: t.refresh_token,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token'
          })
        });
        const newTokens = await refreshResp.json();
        if (!newTokens.error) {
          t.access_token = newTokens.access_token;
          t.expires_at = Date.now() + (newTokens.expires_in * 1000);
          await supabaseRequest(supaUrl, supaKey, 'POST', 'gmail_tokens', [t]);
        }
      }
      return res.status(200).json({ access_token: t.access_token, email: t.email });
    }

    if (action === 'revoke') {
      const stored = await supabaseRequest(supaUrl, supaKey, 'GET', 'gmail_tokens?member_id=eq.' + memberId);
      if (stored && stored[0]) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + stored[0].access_token, { method: 'POST' });
        await supabaseRequest(supaUrl, supaKey, 'DELETE', 'gmail_tokens?member_id=eq.' + memberId);
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('gmail-auth error:', err);
    return res.status(500).json({ error: err.message });
  }
}
