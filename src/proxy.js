'use strict';
const { runTransformFn, evalTemplate } = require('./sandbox');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 路径匹配：支持 exact / prefix / glob / regex 四种方式 */
function pathMatches(pattern, path, type) {
  if (!pattern) return false;
  if (type === 'exact') return path === pattern;
  if (type === 'regex') {
    try { return new RegExp(pattern).test(path); } catch { return false; }
  }
  if (type === 'glob') {
    let re = '^';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*') {
        if (pattern[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
      } else if (ch === '?') { re += '[^/]'; }
      else { re += escapeReg(ch); }
    }
    re += '$';
    try { return new RegExp(re).test(path); } catch { return false; }
  }
  // 默认 prefix：路径作为前缀，后面任意内容命中
  const base = pattern.replace(/\/\*+$/, '');
  return path === base || path.startsWith(base + '/');
}

/** 按规则列表匹配请求 */
function matchRule(rules, url, method) {
  for (const r of rules) {
    if (!r.enabled) continue;
    const methods = (r.match && r.match.methods) || [];
    if (methods.length && !methods.includes(method)) continue;
    const pattern = r.match && r.match.path;
    if (!pattern) continue;
    if (pathMatches(pattern, url.pathname, (r.match && r.match.pathType) || 'prefix')) return r;
  }
  return null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        const err = new Error(`请求体超过大小限制（${Math.round(maxBytes / 1024 / 1024)}MB）`);
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf || !buf.length) return null;
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) {
    try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); }
  }
  if (ct.includes('x-www-form-urlencoded')) {
    const obj = {};
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) obj[k] = v;
    return obj;
  }
  return buf.toString('utf8');
}

/** 构造转发上下文（模板表达式与 JS 逻辑操作的对象） */
async function buildCtx(req, url, rule, config) {
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const headers = {};
  for (const k of Object.keys(req.headers)) headers[k.toLowerCase()] = req.headers[k];

  const maxBytes = (Number(config.maxBodySizeMb) || 20) * 1024 * 1024;
  const buf = await readBody(req, maxBytes);
  const body = parseBody(buf, headers['content-type']);

  const tgt = rule.target || {};
  const target = {
    url: String(tgt.url || ''),
    path: null,
    method: null,
    headers: { ...((tgt.headers || {})) },
    timeoutMs: Number(tgt.timeoutMs || 30000),
  };

  const ctx = {
    method: req.method,
    path: url.pathname,
    fullPath: url.pathname + url.search,
    ip: req.socket.remoteAddress || '',
    query,
    headers,
    body,
    params: {},
    target,
    _logs: [],
  };
  ctx.log = (msg) => ctx._logs.push({ level: 'log', line: String(msg) });
  return ctx;
}

/** 构造测试用的样本上下文（管理后台预览用） */
function buildSampleCtx(rule, sample) {
  const s = sample || {};
  const method = String(s.method || (rule.match && rule.match.methods && rule.match.methods[0]) || 'GET').toUpperCase();
  const rawPath = String(s.path || (rule.match && rule.match.path) || '/');
  const pathName = rawPath.includes('*') ? rawPath.replace(/[*?]/g, 'x') : rawPath;
  const query = { ...(s.query || {}) };
  const headers = {};
  for (const [k, v] of Object.entries(s.headers || {})) headers[String(k).toLowerCase()] = v;
  if (!headers['content-type'] && s.body && typeof s.body === 'object') headers['content-type'] = 'application/json';
  const tgt = rule.target || {};
  const target = {
    url: String(tgt.url || ''),
    path: null,
    method: null,
    headers: { ...(tgt.headers || {}) },
    timeoutMs: Number(tgt.timeoutMs || 30000),
  };
  const ctx = {
    method,
    path: pathName,
    fullPath: pathName,
    ip: '127.0.0.1',
    query,
    headers,
    body: s.body !== undefined ? s.body : null,
    params: {},
    target,
    _logs: [],
  };
  ctx.log = (msg) => ctx._logs.push({ level: 'log', line: String(msg) });
  return ctx;
}

/** 应用参数映射（模板 或 JS 逻辑），结果写入 ctx */
function applyTransform(rule, ctx, opts) {
  const mapping = rule.mapping || { type: 'none' };
  const type = mapping.type || 'none';
  if (type === 'template') {
    for (const sec of ['query', 'body', 'headers']) {
      const map = mapping[sec];
      if (!map || typeof map !== 'object') continue;
      for (const [name, expr] of Object.entries(map)) {
        if (sec === 'body' && !(ctx.body && typeof ctx.body === 'object')) {
          ctx._logs.push({ level: 'warn', line: `body 映射跳过：请求体不是 JSON 对象` });
          continue;
        }
        const out = evalTemplate(expr, ctx, opts);
        ctx._logs.push(...out.logs);
        if (out.result === '__REMOVE__') { delete ctx[sec][name]; continue; }
        if (out.result === undefined || out.result === null) continue;
        ctx[sec][name] = out.result;
      }
    }
    return;
  }
  if (type === 'js') {
    const script = mapping.script == null ? '' : String(mapping.script);
    if (!script.trim()) throw new Error('JS 映射未配置脚本');
    const r = runTransformFn(script, ctx, opts);
    ctx._logs.push(...r.logs);
    if (r.result && typeof r.result === 'object' && r.result !== ctx) {
      for (const k of ['query', 'body', 'headers', 'params', 'target', 'path', 'method', 'ip']) {
        if (k in r.result) ctx[k] = r.result[k];
      }
    }
    return;
  }
}

/** 根据映射后的 ctx 组装目标请求参数 */
function buildTargetRequest(ctx, rule) {
  const target = ctx.target || {};
  const base = target.url || (rule.target && rule.target.url) || '';
  if (!/^https?:\/\//i.test(base)) throw new Error(`目标地址无效: ${base}`);

  let outPath = target.path || ctx.path;
  if (!target.path) {
    const rewrite = (rule.target && rule.target.pathRewrite) || {};
    if (rewrite && typeof rewrite === 'object') {
      for (const [from, to] of Object.entries(rewrite)) {
        if (from && outPath.startsWith(from)) {
          outPath = (to || '') + outPath.slice(from.length);
          break;
        }
      }
    }
  }

  const finalUrl = new URL(outPath, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(ctx.query || {})) {
    if (v === undefined || v === null || v === '') continue;
    finalUrl.searchParams.set(k, String(v));
  }

  const outHeaders = { ...(target.headers || {}) };
  for (const [k, v] of Object.entries(ctx.headers || {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    outHeaders[lk] = v;
  }
  delete outHeaders['host'];

  let bodyOut;
  if (ctx.body === undefined || ctx.body === null) bodyOut = undefined;
  else if (Buffer.isBuffer(ctx.body)) bodyOut = ctx.body;
  else if (typeof ctx.body === 'string') bodyOut = ctx.body;
  else {
    bodyOut = JSON.stringify(ctx.body);
    if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      outHeaders['content-type'] = 'application/json; charset=utf-8';
    }
  }

  return {
    url: finalUrl.toString(),
    method: ctx.method || 'GET',
    headers: outHeaders,
    body: bodyOut,
    timeoutMs: target.timeoutMs || 30000,
  };
}

/** 转发到目标并（可选）应用响应处理脚本 */
async function forwardOnce(reqInfo, rule, ctx, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), reqInfo.timeoutMs);
  let resp;
  try {
    resp = await fetch(reqInfo.url, {
      method: reqInfo.method,
      headers: reqInfo.headers,
      body: reqInfo.body,
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`目标服务超时（${reqInfo.timeoutMs}ms）: ${new URL(reqInfo.url).host}`);
    }
    throw new Error(`请求目标服务失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  let status = resp.status;
  const outHeaders = {};
  resp.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (!HOP_BY_HOP.has(lk) && lk !== 'content-encoding') outHeaders[k] = v;
  });
  delete outHeaders['content-length'];

  let body = buf;
  const script = rule.responseScript == null ? '' : String(rule.responseScript);
  if (script.trim()) {
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const plainHeaders = {};
    resp.headers.forEach((v, k) => { plainHeaders[k] = v; });
    let parsed = buf.toString('utf8');
    if (ct.includes('json')) { try { parsed = JSON.parse(parsed); } catch { /* 保留原文本 */ } }
    const r = runTransformFn(script, { status, headers: plainHeaders, body: parsed, path: ctx.path }, opts);
    ctx._logs.push(...r.logs);
    const o = r.result;
    if (o && typeof o === 'object') {
      if (typeof o.status === 'number') status = o.status;
      if (o.body !== undefined) {
        if (typeof o.body === 'string') body = Buffer.from(o.body);
        else {
          body = Buffer.from(JSON.stringify(o.body));
          if (!ct.includes('json')) outHeaders['content-type'] = 'application/json; charset=utf-8';
        }
      }
      if (o.headers && typeof o.headers === 'object') {
        for (const [k, v] of Object.entries(o.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
      }
    }
  }

  return { status, headers: outHeaders, body };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 代理入口：匹配规则 → 构建上下文 → 参数映射 → 转发 → 响应处理 → 返回 */
async function handleProxy(req, res, { store, logs, config }) {
  const url = new URL(req.url, 'http://localhost');
  const rule = matchRule(store.list(), url, req.method);
  if (!rule) {
    return sendJson(res, 404, {
      error: 'NO_MATCH',
      message: `没有匹配的转发规则: ${req.method} ${url.pathname}`,
      hint: '请在管理后台 http://127.0.0.1:' + config.port + '/admin 中新增或启用规则',
    });
  }
  const start = Date.now();
  const opts = { timeout: Number(config.sandboxTimeoutMs) || 5000, envWhitelist: config.envWhitelist || [] };
  const baseLog = { ts: new Date().toISOString(), ruleId: rule.id, ruleName: rule.name, method: req.method, path: url.pathname, target: (rule.target && rule.target.url) || '' };
  try {
    const ctx = await buildCtx(req, url, rule, config);
    applyTransform(rule, ctx, opts);
    const reqInfo = buildTargetRequest(ctx, rule);
    const out = await forwardOnce(reqInfo, rule, ctx, opts);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
    store.recordHit(rule.id, true, Date.now() - start);
    logs.add({ ...baseLog, target: reqInfo.url, status: out.status, durationMs: Date.now() - start, ok: true });
  } catch (e) {
    store.recordHit(rule.id, false, Date.now() - start);
    logs.add({ ...baseLog, status: 0, durationMs: Date.now() - start, ok: false, error: e.message });
    if (e && e.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'BODY_TOO_LARGE', message: e.message });
    return sendJson(res, 502, { error: 'PROXY_ERROR', message: e.message });
  }
}

module.exports = {
  matchRule,
  pathMatches,
  buildCtx,
  buildSampleCtx,
  applyTransform,
  buildTargetRequest,
  handleProxy,
};
