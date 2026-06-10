exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    var body = JSON.parse(event.body);
    var apiKey = process.env.GEMINI_API_KEY;

    console.log('GEMINI_API_KEY present:', !!apiKey);
    console.log('API key starts with:', apiKey ? apiKey.substring(0,8) : 'MISSING');

    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'GEMINI_API_KEY environment variable is not set' } })
      };
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
      generationConfig: { temperature: 0.1, maxOutputTokens: body.max_tokens || 2000 }
    };

    var model = 'gemini-2.0-flash';
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
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error || { message: 'Gemini returned status ' + response.status } })
      };
    }

    var text = data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      ? data.candidates[0].content.parts[0].text : '';

    console.log('Extracted text length:', text.length);

    var converted = { content: [{ type: 'text', text: text }] };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(converted)
    };

  } catch (err) {
    console.log('Function error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } })
    };
  }
};
