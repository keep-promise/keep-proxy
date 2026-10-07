'use strict';
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createHash, createHmac, randomUUID } = crypto;

/**
 * 服务端逻辑沙箱：基于 node:vm 的尽力隔离执行环境。
 * - 只暴露白名单内建对象与 helpers，不暴露 require/process/globalThis
 * - 通过 contextCodeGeneration.strings=false 阻断 eval / new Function 逃逸
 * - 统一超时控制，防止死循环阻塞服务
 */

const BUILTIN_GLOBALS = {
  JSON, Math, Date, Object, Array, String, Number, Boolean,
  RegExp, Map, Set, Promise, Error, TypeError, RangeError, SyntaxError, ReferenceError,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  TextEncoder, TextDecoder,
  URL, URLSearchParams,
};

function makeHelpers(envWhitelist = []) {
  const env = {};
  for (const k of envWhitelist) env[k] = process.env[k];
  return {
    uuid: () => randomUUID(),
    timestamp: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    md5: (s) => createHash('md5').update(String(s)).digest('hex'),
    sha1: (s) => createHash('sha1').update(String(s)).digest('hex'),
    sha256: (s) => createHash('sha256').update(String(s)).digest('hex'),
    hmacSha256: (key, s) => createHmac('sha256', String(key)).update(String(s)).digest('hex'),
    base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    base64Decode: (s) => { try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch { return ''; } },
    jsonParse: (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } },
    jsonStringify: (v) => JSON.stringify(v),
    randomInt: (min, max) => { const lo = Math.ceil(min); const hi = Math.floor(max); return Math.floor(Math.random() * (hi - lo)) + lo; },
    pick: (obj, keys) => { const o = {}; for (const k of keys) if (obj && k in obj) o[k] = obj[k]; return o; },
    omit: (obj, keys) => { const o = { ...obj }; for (const k of keys) delete o[k]; return o; },
    env, // 仅白名单 env，见 config.json envWhitelist
  };
}

/**
 * 在沙箱中执行一段代码。
 * @param {string} code 要执行的 JS 代码
 * @param {object} sandboxData 注入沙箱的全局变量（如 { ctx }）
 * @param {{timeout?:number, envWhitelist?:string[], filename?:string}} opts
 * @returns {{result:any, logs:Array<{level:string,line:string}>, helpers:object, elapsedMs:number}}
 */
function runCode(code, sandboxData = {}, opts = {}) {
  const timeout = opts.timeout || 5000;
  const logs = [];
  const pushLog = (level, args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
      .join(' ');
    logs.push({ level, line });
    if (logs.length > 200) logs.shift();
  };
  const consoleShim = {
    log: (...a) => pushLog('log', a),
    info: (...a) => pushLog('info', a),
    warn: (...a) => pushLog('warn', a),
    error: (...a) => pushLog('error', a),
  };
  const helpers = makeHelpers(opts.envWhitelist);

  // 把 ctx 的字段（query/body/headers/params/method/path/target/ip/helpers）平铺为全局变量，
  // 这样模板表达式里可直接写 {{query.city}}、{{helpers.timestamp()}}
  const ctxSpread = sandboxData.ctx && typeof sandboxData.ctx === 'object' ? { ...sandboxData.ctx } : {};
  const sandbox = { ...BUILTIN_GLOBALS, helpers, console: consoleShim, ...ctxSpread, ...sandboxData };
  const context = vm.createContext(sandbox);

  let script;
  try {
    script = new vm.Script(code, {
      filename: opts.filename || 'user-logic.js',
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (e) {
    throw new Error(`逻辑代码语法错误: ${e.message}`);
  }

  let result;
  const t0 = Date.now();
  try {
    result = script.runInContext(context, { timeout, displayErrors: true });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/(timeout|timed out)/i.test(msg)) {
      throw new Error(`逻辑执行超时（上限 ${timeout}ms）`);
    }
    throw new Error(`逻辑执行失败: ${msg}`);
  }
  return { result, logs, helpers, elapsedMs: Date.now() - t0 };
}

/** 执行用户写的 transform(ctx) 函数 */
function runTransformFn(code, ctx, opts = {}) {
  const wrapped = `(function(){\n'use strict';\nconst __fn = (${code});\nif (typeof __fn !== 'function') throw new Error('逻辑代码必须以函数形式导出，例如: function transform(ctx){ ... }');\nreturn __fn(ctx, helpers);\n})()`;
  return runCode(wrapped, { ctx }, opts);
}

/** 求值单个表达式 */
function evalExpr(expr, ctx, opts = {}) {
  const wrapped = `(function(){\n'use strict';\nreturn (${expr});\n})()`;
  return runCode(wrapped, { ctx }, opts);
}

/**
 * 模板字符串求值：支持 {{表达式}} 插值，无花括号时原样返回。
 * 例: "{{query.city}}" / "pre-{{query.a}}-{{helpers.timestamp()}}"
 * @returns {{result:any, logs:Array, elapsedMs:number}}
 */
function evalTemplate(str, ctx, opts = {}) {
  if (typeof str !== 'string' || !str.includes('{{') || !str.includes('}}')) {
    return { result: str, logs: [], elapsedMs: 0 };
  }
  const logs = [];
  let elapsed = 0;
  const out = str.replace(/\{\{([\s\S]*?)\}\}/g, (m, expr) => {
    const r = evalExpr(expr.trim(), ctx, opts);
    logs.push(...r.logs);
    elapsed += r.elapsedMs;
    return r.result === undefined || r.result === null ? '' : String(r.result);
  });
  return { result: out, logs, elapsedMs: elapsed };
}

module.exports = { runCode, runTransformFn, evalExpr, evalTemplate, makeHelpers };
