import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { config } from 'dotenv';
import { Buffer } from 'buffer';

config();

const PORT           = process.env.PORT || 3001;
const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const ML_API_URL     = process.env.ML_API_URL || 'http://localhost:5000';

function setCORS(res, origin) {
  res.setHeader('Access-Control-Allow-Origin',  origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function proxyToML(req, res, path, body) {
  const mlUrl = new URL(ML_API_URL);
  const isHttps = mlUrl.protocol === 'https:';
  const options = {
    hostname: mlUrl.hostname,
    port:     mlUrl.port || (isHttps ? 443 : 80),
    path:     path,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxyReq = httpsRequest(options, proxyRes => {
    let data = '';
    proxyRes.on('data', c => { data += c; });
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  proxyReq.on('error', err => {
    console.error('ML API proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ML API unavailable: ' + err.message }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

function proxyToGroq(req, res, body) {
  if (!GROQ_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GROQ_API_KEY not configured' }));
    return;
  }

  const payload = JSON.parse(body);
  const groqBody = JSON.stringify({
    model:       payload.model       || 'llama-3.3-70b-versatile',
    messages:    payload.messages    || [],
    temperature: payload.temperature ?? 0.4,
    max_tokens:  payload.max_tokens  ?? 1200,
  });

  const options = {
    hostname: 'api.groq.com',
    path:     '/openai/v1/chat/completions',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${GROQ_API_KEY}`,
      'Content-Length': Buffer.byteLength(groqBody),
    },
  };

  const proxyReq = httpsRequest(options, proxyRes => {
    let data = '';
    proxyRes.on('data', c => { data += c; });
    proxyRes.on('end', () => {
      if (proxyRes.statusCode !== 200) console.error('Groq error:', data);
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });

  proxyReq.on('error', err => {
    console.error('Groq proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  proxyReq.write(groqBody);
  proxyReq.end();
}

const server = createServer((req, res) => {
  const origin = req.headers['origin'] || '*';

  if (req.method === 'OPTIONS') {
    setCORS(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  setCORS(res, origin);

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ml_api: ML_API_URL,
        groq_configured: !!GROQ_API_KEY,
        time: new Date().toISOString()
      }));
      return;
    }

    // ML API proxy endpoints
    if (req.method === 'POST' && urlPath === '/predict') {
      proxyToML(req, res, '/predict', body);
      return;
    }
    if (req.method === 'GET' && urlPath === '/symptoms') {
      proxyToML(req, res, '/symptoms', '');
      return;
    }
    if (req.method === 'POST' && urlPath === '/triage') {
      proxyToML(req, res, '/triage', body);
      return;
    }

    // Groq chat endpoint (handle query params)
    const urlPath = req.url.split('?')[0];
    if (req.method === 'POST' && urlPath === '/chat') {
      proxyToGroq(req, res, body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
});

server.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`ML API: ${ML_API_URL}`);
  console.log(`Groq API: ${GROQ_API_KEY ? 'configured' : 'NOT configured'}`);
});

const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
if (DOMAIN) {
  setInterval(() => {
    httpsRequest({ hostname: DOMAIN, path: '/', method: 'GET' }, r => console.log(`Keep-alive: ${r.statusCode}`)).on('error', () => {}).end();
  }, 14 * 60 * 1000);
  console.log(`Keep-alive enabled for ${DOMAIN}`);
}