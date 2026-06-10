export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    var body = req.body;
    var apiKey = process.env.GEMINI_API_KEY;

    console.log('GEMINI_API_KEY present:', !!apiKey);
    console.log('API key starts with:', apiKey ? apiKey.substring(0,8) : 'MISSING');

    if (!apiKey) {
      return res.status(500).json({ error: { message: 'GEMINI_API_KEY environment variable is not set' } });
    }

    var parts = [];
    if (Array.isArray(body.messages[0].content)) {
      body.messages[0].content.forEach(function(item) {
        if (item.type === 'image') {
          parts.push({ inlineData: { mimeType: item.source.media_type, data: item.source.data } });
        } else if (item.type === 'document') {
          parts.push({ inlineData: { mimeType: 'application/pdf', data: item.source.data } });
        } else if (item.type === 'text') {
          parts.push({ text: item.text });
        }
      });
    } else {
      parts.push({ text: body.messages[0].content });
    }

    var geminiBody = {
      contents: [{ parts: parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: body.max_tokens || 2000,
        responseMimeType: 'application/json'
      }
    };

    var model = 'gemini-2.5-flash';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

    console.log('Calling Gemini model:', model);
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    var data = await response.json();
    console.log('Gemini status:', response.status);
    console.log('Gemini response keys:', Object.keys(data).join(','));

    if (!response.ok) {
      console.log('Gemini error:', JSON.stringify(data.error || data));
      return res.status(200).json({ error: data.error || { message: 'Gemini returned status ' + response.status } });
    }

    var text = data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      ? data.candidates[0].content.parts[0].text : '';

    console.log('Extracted text length:', text.length);

    var converted = { content: [{ type: 'text', text: text }] };

    return res.status(200).json(converted);

  } catch (err) {
    console.log('Function error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
}
