'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runTransformFn, evalTemplate } = require('./sandbox');
const { applyTransform, buildSampleCtx } = require('./proxy');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createAdminHandler({ store, logs, config }) {
  const assets = {};
  for (const f of ['index.html', 'app.js', 'style.css']) {
    const p = path.join(PUBLIC_DIR, f);
    try {
      assets[f] = { data: fs.readFileSync(p), type: MIME['.' + f.split('.').pop()] || 'application/octet-stream' };
    } catch (e) {
      console.warn('[admin] 缺少静态资源', f, e.message);
    }
  }

  function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function sendAsset(res, asset) {
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
    res.end(asset.data);
  }

  function authed(req) {
    if (!config.adminToken) return true;
    return (req.headers.authorization || '') === 'Bearer ' + config.adminToken;
  }

  async function readJson(req) {
    const buf = await readBody(req, 5 * 1024 * 1024);
    if (!buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  }

  function normalize(data) {
    const rule = { ...data };
    rule.name = String(rule.name || '').trim() || '未命名规则';
    rule.enabled = rule.enabled !== false;
    rule.match = {
      path: String((rule.match && rule.match.path) || ''),
      pathType: (rule.match && rule.match.pathType) || 'prefix',
      methods: Array.isArray(rule.match && rule.match.methods) ? rule.match.methods : [],
    };
    rule.target = {
      url: String((rule.target && rule.target.url) || ''),
      pathRewrite: { ...((rule.target && rule.target.pathRewrite) || {}) },
      headers: { ...((rule.target && rule.target.headers) || {}) },
      timeoutMs: Number((rule.target && rule.target.timeoutMs) || 30000),
    };
    const mt = (rule.mapping && rule.mapping.type) || 'none';
    if (mt === 'template') {
      rule.mapping = {
        type: 'template',
        query: { ...((rule.mapping && rule.mapping.query) || {}) },
        body: { ...((rule.mapping && rule.mapping.body) || {}) },
        headers: { ...((rule.mapping && rule.mapping.headers) || {}) },
      };
    } else if (mt === 'js') {
      rule.mapping = { type: 'js', script: String((rule.mapping && rule.mapping.script) || '') };
    } else {
      rule.mapping = { type: 'none' };
    }
    rule.responseScript = String(rule.responseScript || '');
    return rule;
  }

  function validate(rule) {
    if (!rule.match || !rule.match.path) return '请填写匹配路径';
    if (!rule.target || !/^https?:\/\//i.test(rule.target.url)) return '请填写有效的目标服务地址（http/https）';
    if (rule.mapping && rule.mapping.type === 'js' && !String(rule.mapping.script || '').trim()) return 'JS 逻辑脚本不能为空';
    return null;
  }

  const optsOf = () => ({ timeout: Number(config.sandboxTimeoutMs) || 5000, envWhitelist: config.envWhitelist || [] });

  function mappedView(ctx) {
    return {
      method: ctx.method,
      path: ctx.path,
      query: ctx.query,
      headers: ctx.headers,
      body: ctx.body,
      target: ctx.target,
    };
  }

  async function handle(req, res, url) {
    const segs = url.pathname.split('/').filter(Boolean);
    if (!segs.length || segs[0] !== 'admin') return sendJson(res, 404, { error: 'NOT_FOUND' });

    if (segs.length === 1) {
      const a = assets['index.html'];
      if (a) return sendAsset(res, a);
      return sendJson(res, 404, { error: 'ASSET_MISSING' });
    }
    if (segs.length === 2) {
      const a = assets[segs[1]];
      if (a) return sendAsset(res, a);
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (segs[1] !== 'api') return sendJson(res, 404, { error: 'NOT_FOUND' });
    if (!authed(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED', message: '需要管理 Token，请在 config.json 中配置 adminToken' });

    const m = req.method;
    const r = segs.slice(2);
    try {
      // ---- 概览 / 配置 ----
      if (r.length === 1 && r[0] === 'stats' && m === 'GET') return sendJson(res, 200, store.statView());
      if (r.length === 1 && r[0] === 'config' && m === 'GET') {
        return sendJson(res, 200, {
          port: config.port,
          logLimit: config.logLimit,
          sandboxTimeoutMs: config.sandboxTimeoutMs,
          maxBodySizeMb: config.maxBodySizeMb,
          envWhitelist: config.envWhitelist || [],
          dataFile: path.join(__dirname, '..', 'data', 'rules.json'),
          hasToken: !!config.adminToken,
        });
      }

      // ---- 规则 CRUD ----
      if (r.length === 1 && r[0] === 'rules' && m === 'GET') return sendJson(res, 200, store.list());
      if (r.length === 1 && r[0] === 'rules' && m === 'POST') {
        const data = await readJson(req);
        const err = validate(data);
        if (err) return sendJson(res, 400, { error: 'INVALID_RULE', message: err });
        return sendJson(res, 201, store.create(normalize(data)));
      }

      // ---- 规则预览（未保存也可测试映射）----
      if (r.length === 2 && r[0] === 'rules' && r[1] === 'preview' && m === 'POST') {
        const data = await readJson(req);
        const rule = normalize(data.rule || {});
        const ctx = buildSampleCtx(rule, data.sample || {});
        ctx._logs = [];
        applyTransform(rule, ctx, optsOf());
        return sendJson(res, 200, { mapped: mappedView(ctx), logs: ctx._logs });
      }

      // ---- 规则详情操作 ----
      if (r.length === 2 && r[0] === 'rules') {
        const id = r[1];
        if (m === 'PUT') {
          const data = await readJson(req);
          const err = validate(data);
          if (err) return sendJson(res, 400, { error: 'INVALID_RULE', message: err });
          const up = store.update(id, normalize(data));
          if (!up) return sendJson(res, 404, { error: 'NOT_FOUND', message: '规则不存在' });
          return sendJson(res, 200, up);
        }
        if (m === 'DELETE') {
          const ok = store.remove(id);
          return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'NOT_FOUND', message: '规则不存在' });
        }
      }
      if (r.length === 3 && r[0] === 'rules') {
        const id = r[1];
        const act = r[2];
        if (act === 'toggle' && m === 'POST') {
          const up = store.toggle(id);
          if (!up) return sendJson(res, 404, { error: 'NOT_FOUND' });
          return sendJson(res, 200, up);
        }
        if (act === 'duplicate' && m === 'POST') {
          const up = store.duplicate(id);
          if (!up) return sendJson(res, 404, { error: 'NOT_FOUND' });
          return sendJson(res, 201, up);
        }
        if (act === 'test' && m === 'POST') {
          const rule = store.get(id);
          if (!rule) return sendJson(res, 404, { error: 'NOT_FOUND' });
          const data = await readJson(req);
          const ctx = buildSampleCtx(rule, data.sample || {});
          ctx._logs = [];
          applyTransform(rule, ctx, optsOf());
          return sendJson(res, 200, { mapped: mappedView(ctx), logs: ctx._logs });
        }
      }

      // ---- 逻辑调试 ----
      if (r.length === 2 && r[0] === 'logic' && r[1] === 'test' && m === 'POST') {
        const data = await readJson(req);
        const script = String(data.script || '');
        if (!script.trim()) return sendJson(res, 400, { error: 'EMPTY_SCRIPT', message: '逻辑代码为空' });
        const rule = { match: { path: '/', pathType: 'prefix', methods: [] }, target: { url: 'http://target.invalid', headers: {}, timeoutMs: 30000 } };
        const ctx = buildSampleCtx(rule, data.sample || {});
        const r0 = runTransformFn(script, ctx, optsOf());
        return sendJson(res, 200, { result: r0.result, logs: r0.logs, elapsedMs: r0.elapsedMs, ctx: mappedView(ctx) });
      }
      if (r.length === 2 && r[0] === 'logic' && r[1] === 'expr' && m === 'POST') {
        const data = await readJson(req);
        const rule = { match: { path: '/', pathType: 'prefix', methods: [] }, target: { url: 'http://target.invalid', headers: {}, timeoutMs: 30000 } };
        const ctx = buildSampleCtx(rule, data.sample || {});
        const r0 = evalTemplate(String(data.expr || ''), ctx, optsOf());
        return sendJson(res, 200, { result: r0.result, logs: r0.logs, elapsedMs: r0.elapsedMs });
      }

      // ---- 日志 ----
      if (r.length === 1 && r[0] === 'logs' && m === 'GET') {
        const ruleId = url.searchParams.get('ruleId');
        const limit = Number(url.searchParams.get('limit') || 200);
        let list = logs.list();
        if (ruleId) list = list.filter((l) => l.ruleId === ruleId);
        return sendJson(res, 200, list.slice(0, limit));
      }
      if (r.length === 1 && r[0] === 'logs' && m === 'DELETE') {
        logs.clear();
        return sendJson(res, 200, { ok: true });
      }

      // ---- 重载规则文件 ----
      if (r.length === 1 && r[0] === 'reload' && m === 'POST') {
        return sendJson(res, 200, { ok: true, count: store.reload() });
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: (e && e.message) || String(e) });
    }
  }

  return handle;
}

module.exports = { createAdminHandler };
