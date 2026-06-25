const http = require('node:http');

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthorized(req, token) {
  return Boolean(token && bearerToken(req) === token);
}

function webhookToken(req) {
  return String(
    req.headers['x-sociabuzz-token'] ||
    req.headers['x-webhook-token'] ||
    bearerToken(req) ||
    ''
  ).trim();
}

function isWebhookAuthorized(req, token) {
  return Boolean(token && webhookToken(req) === token);
}

function createTopupBridgeServer({ bridge, host, port, token, sociabuzz = null, sociabuzzToken = '' }) {
  if (!bridge) throw new Error('Topup bridge service is required');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'rizebot-topup-bridge' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sociabuzz/payment') {
      if (!sociabuzz || !sociabuzzToken) {
        sendJson(res, 404, { ok: false, code: 'sociabuzz-webhook-disabled' });
        return;
      }
      if (!isWebhookAuthorized(req, sociabuzzToken)) {
        sendJson(res, 401, { ok: false, code: 'unauthorized' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await sociabuzz.handleWebhookPayload(body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.message || 'bad-request' });
      }
      return;
    }

    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { ok: false, code: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/minecraft/topup/jobs') {
      const limit = Number(url.searchParams.get('limit') || 3);
      sendJson(res, 200, { ok: true, jobs: bridge.takeJobs(limit) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/minecraft/topup/results') {
      try {
        const body = await readJsonBody(req);
        const result = await bridge.completeJob(body);
        sendJson(res, result.ok ? 200 : 404, result);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.message || 'bad-request' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/minecraft/events') {
      try {
        const body = await readJsonBody(req);
        const result = await bridge.handleMinecraftEvent(body);
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.message || 'bad-request' });
      }
      return;
    }

    sendJson(res, 404, { ok: false, code: 'not-found' });
  });

  return {
    start() {
      if (!token) {
        return Promise.reject(new Error('TOPUP_BRIDGE_TOKEN is required'));
      }
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    },
    server,
  };
}

module.exports = { createTopupBridgeServer };
