'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { RuleStore } = require('./src/rule-store');
const { handleProxy } = require('./src/proxy');
const { createAdminHandler } = require('./src/admin-api');
const { RingBuffer } = require('./src/ring-buffer');

const ROOT = __dirname;

function loadConfig() {
  const def = { port: 8080, adminToken: '', logLimit: 500, sandboxTimeoutMs: 5000, maxBodySizeMb: 20, envWhitelist: [] };
  try {
    const p = path.join(ROOT, 'config.json');
    return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    console.warn('[config] 读取 config.json 失败，使用默认配置:', e.message);
    return def;
  }
}

const config = loadConfig();
const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const store = new RuleStore(path.join(dataDir, 'rules.json'));
const logs = new RingBuffer(Number(config.logLimit) || 500);
const handleAdmin = createAdminHandler({ store, logs, config });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return handleAdmin(req, res, url);
    }
    return await handleProxy(req, res, { store, logs, config });
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'INTERNAL', message: String((err && err.message) || err) }));
  }
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, () => {
  console.log('==============================================');
  console.log('  Keep Proxy Gateway 已启动');
  console.log(`  管理后台: http://127.0.0.1:${config.port}/admin`);
  console.log(`  代理入口: http://127.0.0.1:${config.port}/<规则匹配路径>`);
  console.log(`  数据文件: ${path.join(dataDir, 'rules.json')}`);
  if (config.adminToken) console.log('  管理后台已启用 Token 鉴权');
  console.log('==============================================');
});
