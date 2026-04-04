// YouTube search proxy — evita CORS desde el browser
const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 8766;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/yt-search') {
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const q = parsed.query.q || '';
  if (!q) {
    res.end(JSON.stringify({ error: 'no query' }));
    return;
  }

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`;

  const options = {
    hostname: 'www.youtube.com',
    path: `/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  };

  const ytReq = https.get(options, (ytRes) => {
    let data = '';
    ytRes.on('data', chunk => data += chunk);
    ytRes.on('end', () => {
      // Extraer el primer videoId del HTML de resultados
      const match = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (match) {
        res.end(JSON.stringify({ videoId: match[1] }));
      } else {
        res.end(JSON.stringify({ videoId: null }));
      }
    });
  });

  ytReq.on('error', (e) => {
    res.end(JSON.stringify({ error: e.message }));
  });

  ytReq.setTimeout(8000, () => {
    ytReq.destroy();
    res.end(JSON.stringify({ error: 'timeout' }));
  });
});

server.listen(PORT, () => {
  console.log(`YT proxy listening on port ${PORT}`);
});
