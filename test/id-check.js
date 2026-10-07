'use strict';
// 静态一致性校验：app.js 中 $('#id') 引用的 id 必须存在于 index.html 或在 app.js 模板中创建
const fs = require('fs');
const app = fs.readFileSync('D:/keep/keep-proxy-gateway/public/app.js', 'utf8');
const html = fs.readFileSync('D:/keep/keep-proxy-gateway/public/index.html', 'utf8');
const idsInApp = [...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
const created = new Set([...app.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const inHtml = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const missing = [...new Set(idsInApp)].filter((id) => !created.has(id) && !inHtml.has(id));
console.log('app.js 中 #id 引用数:', idsInApp.length);
console.log('未找到的 id:', missing.length ? JSON.stringify(missing) : '无');
process.exit(0);
