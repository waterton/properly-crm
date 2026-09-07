// Publish a listing to WordPress via the REST API (Kadence/Gutenberg = plain posts, HTML into the
// body). Creates a new post or updates an existing one. Auth to WordPress uses an Application
// Password (WP admin -> Users -> Profile -> Application Passwords), stored server-side only.
//
// Required Vercel env vars:
//   WP_BASE_URL       e.g. https://palaciosbaker.com  (no trailing slash, no /wp-admin)
//   WP_USER           the WordPress username that owns the Application Password
//   WP_APP_PASSWORD   the generated Application Password (spaces are fine, include them)
// Optional:
//   WP_POST_TYPE      'posts' (default) or 'pages'

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// Require a logged-in Supabase user (the public anon key is NOT a user).
async function verifyUser(req) {
  var authHeader = req.headers['authorization'] || '';
  var token = authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7) : '';
  var supaUrl = process.env.SUPA_URL || 'https://fgkilooomlozhwfnvjze.supabase.co';
  var anon = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZna2lsb29vbWxvemh3Zm52anplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTc0NTIsImV4cCI6MjA5NjMzMzQ1Mn0.owQk8Vy3Vcs8n8c0sI0fXQYmjpAy14hev8lDt4g5iZE';
  if (!token || token === anon) return false;
  try {
    var r = await fetch(supaUrl + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
    if (!r.ok) return false;
    var u = await r.json();
    return !!(u && u.id);
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!(await verifyUser(req))) return res.status(401).json({ error: 'Sign in required.' });

  var base = (process.env.WP_BASE_URL || '').replace(/\/+$/, '');
  var user = process.env.WP_USER || '';
  var apppw = process.env.WP_APP_PASSWORD || '';
  if (!base || !user || !apppw) {
    return res.status(500).json({ error: 'WordPress is not configured. Set WP_BASE_URL, WP_USER, and WP_APP_PASSWORD in the environment.' });
  }

  try {
    var body = req.body || {};
    var title = String(body.title || 'Listing').slice(0, 300);
    var content = String(body.content || '');
    var slug = String(body.slug || '');
    var status = (body.status === 'publish') ? 'publish' : 'draft';   // default safe = draft
    var postType = (body.postType === 'pages') ? 'pages' : (process.env.WP_POST_TYPE === 'pages' ? 'pages' : 'posts');
    var postId = body.postId ? String(body.postId).replace(/[^0-9]/g, '') : '';

    var url = base + '/wp-json/wp/v2/' + postType + (postId ? ('/' + postId) : '');
    var auth = 'Basic ' + Buffer.from(user + ':' + apppw).toString('base64');
    var payload = { title: title, content: content, status: status };
    if (slug) payload.slug = slug;

    var wp = await fetch(url, {
      method: 'POST',   // WP REST uses POST for both create and update
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload)
    });
    var text = await wp.text();
    var data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!wp.ok) {
      var msg = (data && (data.message || data.code)) || text.substring(0, 200);
      return res.status(wp.status).json({ error: 'WordPress rejected the request (' + wp.status + '): ' + msg });
    }
    return res.status(200).json({
      id: data && data.id,
      link: data && data.link,
      status: data && data.status,
      type: postType,
      edit_link: base + '/wp-admin/post.php?post=' + (data && data.id) + '&action=edit'
    });
  } catch (e) {
    return res.status(500).json({ error: 'Publish failed: ' + (e && e.message || e) });
  }
}
