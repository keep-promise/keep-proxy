'use strict';
/**
 * 本地测试回显服务：把收到的请求原样以 JSON 返回，用于验证代理转发的映射结果。
 * 用法: node test/echo-server.js [端口，默认 9099]
 *   GET  /status/404  -> 返回指定状态码（测试响应处理）
 */
const http = require('node:http');

const port = Number(process.argv[2] || 9099);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (/^\/status\/\d{3}$/.test(u.pathname)) {
    const code = Number(u.pathname.split('/')[2]);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: code, path: u.pathname }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    if (raw) {
      try { body = JSON.parse(raw); } catch { /* 保留文本 */ }
    }
    const obj = {
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      body: body || null,
      time: new Date().toISOString(),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('[echo] 回显服务已启动: http://127.0.0.1:' + port);
});
