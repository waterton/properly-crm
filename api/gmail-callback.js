// OAuth callback - DIAGNOSTIC VERSION (temporary - we'll revert after)
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

  var diag = {
    step: 'start',
    baseUrl: baseUrl,
    redirectUri: redirectUri,
    host_header: req.headers.host || '',
    memberId: '',
    token_http_status: null,
    token_error: null,
    has_access_token: false,
    has_refresh_token: false,
    profile_email: '',
    save_http_status: null,
    save_body: ''
  };

  const showDiag = function (ok) {
    const color = ok ? '#6bc96a' : '#c94c4c';
    const title = ok ? 'Save Diagnostic' : 'Connection Diagnostic';
    var rows = '';
    Object.keys(diag).forEach(function (k) {
      rows += '<tr><td style="padding:4px 12px;color:#8b90a8;text-align:right;">' + k +
              '</td><td style="padding:4px 12px;color:#e8eaf0;font-family:monospace;">' +
              String(diag[k]).replace(/</g, '&lt;') + '</td></tr>';
    });
    return res.status(200).send('<!DOCTYPE html><html><head><title>Gmail Auth Diagnostic</title></head>'
      + '<body style="font-family:sans-serif;padding:32px;background:#0d0f14;color:#e0d9cc;">'
      + '<h2 style="color:' + color + ';text-align:center;">' + title + '</h2>'
      + '<table style="margin:0 auto;border-collapse:collapse;background:#151820;border-radius:8px;">'
      + rows + '</table>'
      + '<p style="text-align:center;margin-top:20px;"><button onclick="window.close()" '
      + 'style="padding:8px 20px;background:#c9a84c;border:none;border-radius:6px;cursor:pointer;">Close</button></p>'
      + '</body></html>');
  };

  if (error) { diag.step = 'google_returned_error'; diag.token_error = error; return showDiag(false); }
  if (!code) { diag.step = 'no_code'; return showDiag(false); }

  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    diag.memberId = decoded.memberId;
  } catch (e) { diag.memberId = '(state decode FAILED: ' + e.message + ')'; }

  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    diag.token_http_status = tokenResp.status;
    const tokenText = await tokenResp.text();
    var tokens = {};
    try { tokens = JSON.parse(tokenText); } catch (e) { diag.token_error = 'parse: ' + tokenText.slice(0, 120); return showDiag(false); }
    if (tokens.error) { diag.token_error = tokens.error + ' - ' + (tokens.error_description || ''); return showDiag(false); }
    diag.has_access_token = !!tokens.access_token;
    diag.has_refresh_token = !!tokens.refresh_token;

    const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + tokens.access_token }
    });
    var profile = {};
    try { profile = JSON.parse(await profileResp.text()); } catch (e) {}
    diag.profile_email = profile.email || '';

    if (supaUrl && supaKey && diag.memberId && String(diag.memberId).indexOf('FAILED') === -1) {
      const record = {
        id: String(diag.memberId),
        member_id: String(diag.memberId),
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
      diag.save_http_status = saveResp.status;
      diag.save_body = (await saveResp.text()).slice(0, 200);
      diag.step = 'save_attempted';
    } else {
      diag.step = 'SAVE SKIPPED (memberId missing or bad)';
    }

    return showDiag(true);

  } catch (err) {
    diag.step = 'exception';
    diag.token_error = err.message;
    return showDiag(false);
  }
}