// OAuth callback - Google redirects here after user approves
export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:#e0d9cc;text-align:center;">
        <h2 style="color:#c94c4c;">Gmail connection cancelled</h2>
        <p>You can close this window and try again from the CRM.</p>
        <script>window.opener && window.opener.postMessage({type:'gmail_error',error:'${error}'},'*');setTimeout(()=>window.close(),2000);</script>
      </body></html>
    `);
  }

  let memberId = '';
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    memberId = decoded.memberId;
  } catch(e) {}

  // Exchange code for tokens via our gmail-auth function
  const baseUrl = process.env.APP_URL
    || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : null)
    || (req.headers.host ? 'https://' + req.headers.host : null)
    || 'https://properly-crm.vercel.app';
  try {
    const resp = await fetch(baseUrl + '/api/gmail-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'exchange', code, memberId })
    });
    const data = await resp.json();

    if (data.error) {
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:#e0d9cc;text-align:center;">
          <h2 style="color:#c94c4c;">Connection failed</h2>
          <p>${data.error}</p>
          <script>window.opener && window.opener.postMessage({type:'gmail_error',error:'${data.error}'},'*');setTimeout(()=>window.close(),3000);</script>
        </body></html>
      `);
    }

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0d0f14;color:#e0d9cc;text-align:center;">
        <h2 style="color:#6bc96a;">Gmail Connected!</h2>
        <p style="color:#8a8a7a;">Connected as <strong style="color:#c9a84c;">${data.email}</strong></p>
        <p style="font-size:13px;color:#5a5a4a;">This window will close automatically...</p>
        <script>
          window.opener && window.opener.postMessage({
            type: 'gmail_connected',
            memberId: '${memberId}',
            email: '${data.email}',
            name: '${data.name}'
          }, '*');
          setTimeout(() => window.close(), 2000);
        </script>
      </body></html>
    `);
  } catch(err) {
    return res.status(500).send(`<html><body>Error: ${err.message}<script>setTimeout(()=>window.close(),3000);</script></body></html>`);
  }
}
