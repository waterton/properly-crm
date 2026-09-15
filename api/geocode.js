// Reverse-geocode a phone's GPS coordinates into a street address for the Commercial Search
// quick-capture. The browser gets the lat/lon (with the user's permission) and posts them here; this
// proxies OpenStreetMap's Nominatim so we can send a proper identifying User-Agent (browsers can't set
// one) and stay within its usage policy. No API key needed. Signed-in users only.

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await verifyUser(req))) return res.status(401).json({ error: 'Sign in required.' });

  var lat = (req.query && req.query.lat) || (req.body && req.body.lat);
  var lon = (req.query && req.query.lon) || (req.body && req.body.lon);
  var nlat = parseFloat(lat), nlon = parseFloat(lon);
  if (isNaN(nlat) || isNaN(nlon) || nlat < -90 || nlat > 90 || nlon < -180 || nlon > 180) {
    return res.status(400).json({ error: 'Valid lat and lon are required.' });
  }

  try {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=' + nlat + '&lon=' + nlon;
    var r = await fetch(url, { headers: { 'User-Agent': 'ProperlyCRM/1.0 (+https://properly-crm.vercel.app)', 'Accept': 'application/json' } });
    if (!r.ok) { var t = await r.text(); return res.status(502).json({ error: 'Geocoder error (' + r.status + '): ' + t.substring(0, 120) }); }
    var d = await r.json();
    var a = d.address || {};
    var street = [a.house_number, a.road].filter(Boolean).join(' ');
    var city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
    var state = a.state || '';
    var zip = a.postcode || '';
    var address = [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return res.status(200).json({
      address: address || d.display_name || '',
      street: street, city: city, state: state, zip: zip,
      lat: nlat, lon: nlon, display: d.display_name || ''
    });
  } catch (e) {
    return res.status(500).json({ error: 'Reverse geocode failed: ' + (e && e.message || e) });
  }
}
