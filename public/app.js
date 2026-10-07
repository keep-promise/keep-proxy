'use strict';

/* ================= 状态 ================= */
const state = {
  view: 'overview',
  token: localStorage.getItem('kpg_token') || '',
  rules: [],
  stats: null,
  logs: [],
  autoRefresh: false,
  editor: null,
  _refreshTimer: null,
};

/* ================= 工具函数 ================= */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
};
const pretty = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ================= API ================= */
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers['authorization'] = 'Bearer ' + state.token;
  let r;
  try {
    r = await fetch('/admin/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error('无法连接服务端：' + e.message);
  }
  if (r.status === 401) {
    toast('管理 Token 无效，请在设置中配置', 'error');
    openSettings();
    throw new Error('unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || ('HTTP ' + r.status));
  return data;
}

/* ================= 数据加载 ================= */
async function loadData() {
  try {
    const [rules, stats, logs] = await Promise.all([api('GET', '/rules'), api('GET', '/stats'), api('GET', '/logs?limit=200')]);
    state.rules = rules;
    state.stats = stats;
    state.logs = logs;
    setServerStatus(true);
  } catch (e) {
    setServerStatus(false);
  }
}

async function refreshData() {
  try {
    const [rules, stats] = await Promise.all([api('GET', '/rules'), api('GET', '/stats')]);
    state.rules = rules;
    state.stats = stats;
    setServerStatus(true);
    if (state.view === 'rules') renderRulesTable();
    else if (state.view === 'overview') renderOverview();
  } catch (e) {
    setServerStatus(false);
  }
}

async function refreshLogs() {
  try {
    state.logs = await api('GET', '/logs?limit=200');
    if (state.view === 'logs') renderLogsTable();
  } catch (e) { /* 忽略 */ }
}

function setServerStatus(ok) {
  const dot = $('#srv-dot');
  const txt = $('#srv-text');
  if (!dot) return;
  dot.className = 'dot ' + (ok ? 'ok' : 'bad');
  txt.textContent = ok ? '服务运行中' : '无法连接服务';
}

/* ================= 视图路由 ================= */
function switchView(view) {
  state.view = view;
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = { overview: '概览', rules: '转发规则', playground: '逻辑调试', logs: '请求日志' };
  $('#page-title').textContent = titles[view] || '概览';
  render();
  if (view === 'overview') loadData().then(() => { if (state.view === 'overview') render(); });
  if (view === 'rules') refreshData();
  if (view === 'logs') refreshLogs();
}

function render() {
  const view = $('#view');
  const top = $('#topbar-actions');
  if (state.view === 'overview') { top.innerHTML = ''; view.innerHTML = overviewHtml(); bindOverview(); }
  else if (state.view === 'rules') {
    top.innerHTML = '<button class="btn btn-primary" id="btn-new-rule">+ 新建规则</button>';
    view.innerHTML = rulesHtml(); bindRules(); renderRulesTable();
  } else if (state.view === 'playground') { top.innerHTML = ''; view.innerHTML = playgroundHtml(); bindPlayground(); }
  else if (state.view === 'logs') { top.innerHTML = ''; view.innerHTML = logsHtml(); bindLogs(); renderLogsTable(); }
}

/* ================= 概览 ================= */
function overviewHtml() {
  const s = state.stats || { totalRules: 0, enabledRules: 0, totalHits: 0, totalErrors: 0, rules: [] };
  const arch = `
  <svg viewBox="0 0 900 190" role="img" aria-label="转发链路架构图">
    <defs>
      <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker>
      <marker id="arrB" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#2563eb"/></marker>
    </defs>
    <g font-family="inherit">
      <rect x="20" y="65" width="150" height="64" rx="10" fill="#e2e8f0" stroke="#94a3b8"/>
      <text x="95" y="94" text-anchor="middle" fill="#334155" font-size="14" font-weight="600">调用方</text>
      <text x="95" y="113" text-anchor="middle" fill="#64748b" font-size="11">HTTP 请求</text>

      <line x1="170" y1="97" x2="212" y2="97" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>

      <rect x="218" y="42" width="218" height="110" rx="12" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
      <text x="327" y="72" text-anchor="middle" fill="#1d4ed8" font-size="14" font-weight="700">Keep Proxy 网关</text>
      <text x="327" y="92" text-anchor="middle" fill="#475569" font-size="11">1. 规则匹配（路径/方法）</text>
      <text x="327" y="108" text-anchor="middle" fill="#475569" font-size="11">2. 参数映射（模板/JS 逻辑）</text>
      <text x="327" y="124" text-anchor="middle" fill="#475569" font-size="11">3. 服务端沙箱执行</text>
      <text x="327" y="141" text-anchor="middle" fill="#64748b" font-size="11">监听端口 :8080（config.json 可改）</text>

      <line x1="436" y1="97" x2="478" y2="97" stroke="#2563eb" stroke-width="2" marker-end="url(#arrB)"/>

      <rect x="484" y="65" width="170" height="64" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
      <text x="569" y="94" text-anchor="middle" fill="#166534" font-size="14" font-weight="600">目标服务</text>
      <text x="569" y="113" text-anchor="middle" fill="#64748b" font-size="11">业务 / 第三方 API</text>

      <line x1="654" y1="97" x2="696" y2="97" stroke="#64748b" stroke-width="2" marker-end="url(#arr)"/>

      <rect x="702" y="65" width="160" height="64" rx="10" fill="#e2e8f0" stroke="#94a3b8"/>
      <text x="782" y="94" text-anchor="middle" fill="#334155" font-size="14" font-weight="600">响应返回</text>
      <text x="782" y="113" text-anchor="middle" fill="#64748b" font-size="11">可配置响应处理</text>
    </g>
  </svg>`;
  const recent = (s.rules || []).slice(0, 6);
  const logs = state.logs || [];
  return `
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-num">${s.totalRules}</div><div class="stat-label">转发规则总数</div></div>
    <div class="stat-card ok"><div class="stat-num">${s.enabledRules}</div><div class="stat-label">启用中</div></div>
    <div class="stat-card acc"><div class="stat-num">${s.totalHits}</div><div class="stat-label">累计转发次数</div></div>
    <div class="stat-card ${s.totalErrors ? 'bad' : ''}"><div class="stat-num">${s.totalErrors}</div><div class="stat-label">失败次数</div></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3 class="card-title">转发链路</h3>
    <div class="arch-wrap arch">${arch}</div>
  </div>
  <div class="card">
    <h3 class="card-title">最近规则</h3>
    ${recent.length ? `<ul class="mini-list" id="recent-rules">${recent.map((r) => `
      <li data-id="${esc(r.id)}" title="点击编辑" style="cursor:pointer">
        <span class="badge ${r.enabled ? 'badge-on' : 'badge-off'}">${r.enabled ? '启用' : '停用'}</span>
        <span class="grow">${esc(r.name)}</span>
        <span class="mono" style="color:var(--muted)">${esc(r.path || '')}</span>
        <span style="color:var(--muted)">${r.hits || 0} 次 · 失败 ${r.errors || 0}</span>
      </li>`).join('')}</ul>` : '<p class="hint">暂无规则，点击左侧「转发规则」新建。</p>'}
  </div>
  <div class="card">
    <h3 class="card-title">最近请求</h3>
    ${logs.length ? `<ul class="mini-list">${logs.slice(0, 8).map((l) => `
      <li>
        <span class="tag">${esc(l.method || '')}</span>
        <span class="grow">${esc(l.path || '')}</span>
        <span style="color:var(--muted)">${esc((l.target || '').replace(/^https?:\/\//, ''))}</span>
        <span class="badge ${l.ok ? 'badge-on' : 'badge-off'}">${l.ok ? l.status : '失败'}</span>
        <span style="color:var(--muted)">${l.durationMs || 0}ms</span>
      </li>`).join('')}</ul>` : '<p class="hint">暂无转发记录。</p>'}
  </div>`;
}

function bindOverview() {
  const recent = $('#recent-rules');
  if (recent) recent.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) openEditor(state.rules.find((r) => r.id === row.dataset.id) || null);
  });
}

/* ================= 转发规则 ================= */
const MAPPING_LABEL = { none: '透传', template: '模板映射', js: 'JS 逻辑' };

function rulesHtml() {
  return `
  <div class="toolbar">
    <input class="inp search" id="rule-search" placeholder="搜索规则名称 / 路径 / 目标地址…">
    <button class="btn" id="btn-reload-rules">重新载入数据文件</button>
  </div>
  <div class="card">
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>名称</th><th>匹配</th><th>目标服务</th><th>映射</th><th>状态</th><th>命中</th><th></th>
        </tr></thead>
        <tbody id="rules-tbody"></tbody>
      </table>
    </div>
  </div>`;
}

function renderRulesTable() {
  const tbody = $('#rules-tbody');
  if (!tbody) return;
  const kw = ($('#rule-search') ? $('#rule-search').value : '').trim().toLowerCase();
  const list = state.rules.filter((r) =>
    !kw || (r.name || '').toLowerCase().includes(kw) || (r.match && r.match.path || '').includes(kw) || (r.target && r.target.url || '').toLowerCase().includes(kw)
  );
  const statsMap = {};
  (state.stats && state.stats.rules || []).forEach((s) => { statsMap[s.id] = s; });
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-tip">' + (state.rules.length ? '没有匹配的规则' : '还没有规则，点击右上角「+ 新建规则」开始') + '</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((r) => {
    const st = statsMap[r.id] || { hits: 0, errors: 0, avgMs: 0 };
    const methods = (r.match && r.match.methods || []).length
      ? (r.match.methods || []).map((m) => `<span class="tag">${esc(m)}</span>`).join('')
      : '<span class="tag">ALL</span>';
    const mt = (r.mapping && r.mapping.type) || 'none';
    return `<tr data-id="${esc(r.id)}">
      <td><div style="font-weight:600">${esc(r.name)}</div><div class="hint">${fmtTime(r.updatedAt)}</div></td>
      <td>${methods}<div class="mono" style="margin-top:3px;color:var(--muted)">${esc(r.match && r.match.path || '')}</div></td>
      <td class="mono" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.target && r.target.url || '')}</td>
      <td><span class="badge badge-map-${esc(mt)}">${MAPPING_LABEL[mt] || '透传'}</span></td>
      <td><label class="switch"><input type="checkbox" data-action="toggle" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label></td>
      <td><span style="font-weight:600">${st.hits}</span><span class="hint"> 失败 ${st.errors} · ${st.avgMs}ms</span></td>
      <td class="actions">
        <button class="btn-icon" data-action="edit" title="编辑">✎</button>
        <button class="btn-icon" data-action="dup" title="复制">⧉</button>
        <button class="btn-icon danger" data-action="del" title="删除">×</button>
      </td>
    </tr>`;
  }).join('');
}

function bindRules() {
  $('#btn-new-rule').addEventListener('click', () => openEditor(null));
  $('#btn-reload-rules').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/reload');
      toast('已从数据文件重载 ' + r.count + ' 条规则', 'ok');
      await refreshData();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#rule-search').addEventListener('input', renderRulesTable);
  const tbody = $('#rules-tbody');
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr[data-id]');
    const id = tr && tr.dataset.id;
    const rule = state.rules.find((r) => r.id === id);
    const act = btn.dataset.action;
    if (act === 'edit') openEditor(rule);
    else if (act === 'dup') {
      try { await api('POST', '/rules/' + id + '/duplicate'); toast('已复制规则', 'ok'); await refreshData(); }
      catch (err) { toast(err.message, 'error'); }
    } else if (act === 'del') {
      if (!confirm('确定删除规则「' + (rule ? rule.name : '') + '」？')) return;
      try { await api('DELETE', '/rules/' + id); toast('已删除', 'ok'); await refreshData(); }
      catch (err) { toast(err.message, 'error'); }
    }
  });
  tbody.addEventListener('change', async (e) => {
    const inp = e.target.closest('input[data-action="toggle"]');
    if (!inp) return;
    const tr = inp.closest('tr[data-id]');
    if (!tr) return;
    try { await api('POST', '/rules/' + tr.dataset.id + '/toggle'); await refreshData(); }
    catch (err) { toast(err.message, 'error'); await refreshData(); }
  });
}

/* ================= 规则编辑器 ================= */
function defaultRule() {
  return {
    name: '新转发规则',
    enabled: true,
    match: { path: '/api/**', pathType: 'glob', methods: ['GET', 'POST'] },
    target: { url: '', pathRewrite: {}, headers: {}, timeoutMs: 30000 },
    mapping: { type: 'none' },
    responseScript: '',
  };
}

const DEFAULT_SAMPLE = JSON.stringify(
  { method: 'GET', path: '/api/orders/10086', query: { userId: '10086', city: '杭州' }, headers: {}, body: null },
  null, 2
);

function mapRowsHtml(sec, obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<div class="map-empty">暂无映射，点击下方「添加映射」新增</div>';
  return entries.map(([name, expr]) => `
    <div class="map-row" data-sec="${sec}">
      <input class="inp map-name" value="${esc(name)}" placeholder="输出参数名">
      <span class="map-eq">=</span>
      <input class="inp map-expr" value="${esc(expr)}" placeholder="{{query.xxx}} 或字面值">
      <button type="button" class="btn-icon map-del" title="删除">×</button>
    </div>`).join('');
}

function rewriteRowsHtml(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<div class="map-empty">不重写路径，原样转发</div>';
  return entries.map(([from, to]) => `
    <div class="map-row rw-row">
      <input class="inp rw-from" value="${esc(from)}" placeholder="/api/old">
      <span class="map-eq">→</span>
      <input class="inp rw-to" value="${esc(to)}" placeholder="/v2/new">
      <button type="button" class="btn-icon map-del" title="删除">×</button>
    </div>`).join('');
}

function theaderRowsHtml(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '<div class="map-empty">不额外添加请求头</div>';
  return entries.map(([name, value]) => `
    <div class="map-row th-row">
      <input class="inp th-name" value="${esc(name)}" placeholder="X-Api-Key">
      <span class="map-eq">=</span>
      <input class="inp th-value" value="${esc(value)}" placeholder="值或 {{表达式}}">
      <button type="button" class="btn-icon map-del" title="删除">×</button>
    </div>`).join('');
}

function editorHtml(r) {
  const tpl = r.mapping && r.mapping.type === 'template' ? r.mapping : { query: {}, body: {}, headers: {} };
  const js = r.mapping && r.mapping.type === 'js' ? r.mapping.script || '' : '';
  const type = (r.mapping && r.mapping.type) || 'none';
  const methods = r.match.methods || [];
  const allMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const pathType = r.match.pathType || 'prefix';
  const pathTypeLabel = { prefix: '前缀匹配（路径开头命中）', exact: '精确匹配', glob: '通配符（* 单段 / ** 任意）', regex: '正则表达式' };
  return `
  <div class="modal-overlay" data-modal>
    <div class="modal">
      <div class="modal-head">
        <h2>${r.id ? '编辑转发规则' : '新建转发规则'}</h2>
        <button type="button" class="btn-icon" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="fieldset">
          <p class="fieldset-title"><span class="num">1</span>基础信息</p>
          <div class="field-row">
            <div class="field"><label class="label">规则名称</label><input class="inp" id="ed-name" value="${esc(r.name)}"></div>
            <div class="field" style="flex:0 0 120px"><label class="label">启用</label>
              <label class="switch" style="margin-top:8px"><input type="checkbox" id="ed-enabled" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label>
            </div>
          </div>
        </div>

        <div class="fieldset">
          <p class="fieldset-title"><span class="num">2</span>匹配条件</p>
          <div class="field-row">
            <div class="field"><label class="label">请求路径</label><input class="inp" id="ed-path" value="${esc(r.match.path || '')}" placeholder="/api/orders/* 或 /orders/**"></div>
            <div class="field" style="flex:0 0 260px"><label class="label">匹配方式</label>
              <select class="select" id="ed-path-type">
                ${Object.keys(pathTypeLabel).map((k) => `<option value="${k}" ${k === pathType ? 'selected' : ''}>${pathTypeLabel[k]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field" style="margin-top:10px">
            <label class="label">请求方法（不选 = 全部方法）</label>
            <div id="ed-methods">${allMethods.map((m) => `<label class="method-chk"><input type="checkbox" value="${m}" ${methods.includes(m) ? 'checked' : ''}><span>${m}</span></label>`).join('')}</div>
          </div>
        </div>

        <div class="fieldset">
          <p class="fieldset-title"><span class="num">3</span>目标服务</p>
          <div class="field-row">
            <div class="field"><label class="label">基础地址（http/https）</label><input class="inp" id="ed-target-url" value="${esc(r.target.url || '')}" placeholder="http://192.168.1.10:9000 或 https://api.example.com"></div>
            <div class="field" style="flex:0 0 180px"><label class="label">超时（毫秒）</label><input class="inp" id="ed-timeout" type="number" value="${r.target.timeoutMs || 30000}"></div>
          </div>
          <div class="field" style="margin-top:12px">
            <label class="label">路径重写（源路径前缀 → 目标路径前缀）</label>
            <div id="ed-rewrite">${rewriteRowsHtml(r.target.pathRewrite)}</div>
            <button type="button" class="btn" id="add-rewrite" style="margin-top:8px">+ 添加重写规则</button>
          </div>
          <div class="field" style="margin-top:12px">
            <label class="label">额外请求头（值支持 {{表达式}}）</label>
            <div id="ed-theaders">${theaderRowsHtml(r.target.headers)}</div>
            <button type="button" class="btn" id="add-theader" style="margin-top:8px">+ 添加请求头</button>
          </div>
        </div>

        <div class="fieldset">
          <p class="fieldset-title"><span class="num">4</span>参数映射（服务端执行）</p>
          <div class="tabs">
            <button type="button" class="tab-btn ${type === 'none' ? 'active' : ''}" data-maptype="none">透传</button>
            <button type="button" class="tab-btn ${type === 'template' ? 'active' : ''}" data-maptype="template">模板映射</button>
            <button type="button" class="tab-btn ${type === 'js' ? 'active' : ''}" data-maptype="js">JS 逻辑</button>
          </div>
          <input type="hidden" id="ed-maptype" value="${type}">

          <div class="map-pane" data-pane="none" style="${type === 'none' ? '' : 'display:none'}">
            <p class="hint">请求参数原样转发到目标服务，不做任何改写。</p>
          </div>

          <div class="map-pane" data-pane="template" style="${type === 'template' ? '' : 'display:none'}">
            <p class="hint">把入参映射为出参。表达式用 <code>{{...}}</code> 包裹，可访问 <code>query</code>、<code>body</code>、<code>headers</code>、<code>helpers</code> 等；无花括号的字面值原样输出；填写 <code>__REMOVE__</code> 删除该参数。</p>
            ${['query', 'body', 'headers'].map((sec) => `
              <div style="margin-top:10px">
                <label class="label">${sec === 'query' ? 'Query 参数' : sec === 'body' ? 'Body 字段' : '请求头'}</label>
                <div class="map-rows" id="map-${sec}">${mapRowsHtml(sec, tpl[sec])}</div>
                <button type="button" class="btn add-map" data-sec="${sec}" style="margin-top:6px">+ 添加映射</button>
              </div>`).join('')}
          </div>

          <div class="map-pane" data-pane="js" style="${type === 'js' ? '' : 'display:none'}">
            <p class="hint">编写 <code>function transform(ctx){ ... }</code>，在服务端沙箱内执行，支持修改 <code>ctx.query / ctx.body / ctx.headers / ctx.target / ctx.path / ctx.method</code>，内置 <code>helpers</code>（sha256、timestamp、uuid 等）与 <code>ctx.log()</code>。可直接改对象后 return ctx，或返回新对象。</p>
            <textarea class="code-area" id="ed-js-script" rows="10" spellcheck="false" placeholder="function transform(ctx) {&#10;  // 你的逻辑&#10;  return ctx;&#10;}">${esc(js)}</textarea>
          </div>

          <details style="margin-top:14px">
            <summary class="hint" style="cursor:pointer">测试样本请求（JSON，用于「测试映射」）</summary>
            <textarea class="code-area" id="ed-sample" rows="8" spellcheck="false">${esc(DEFAULT_SAMPLE)}</textarea>
          </details>
          <div id="ed-test-result"></div>
        </div>

        <div class="fieldset">
          <p class="fieldset-title"><span class="num">5</span>响应处理（可选）</p>
          <p class="hint">编写 <code>function transformResponse(res){ ... }</code> 处理目标服务响应，<code>res = { status, headers, body, path }</code>；返回 <code>{ status, headers, body }</code> 覆盖输出。</p>
          <textarea class="code-area" id="ed-resp-script" rows="5" spellcheck="false" placeholder="function transformResponse(res) {&#10;  if (res.body && res.body.code === 0) res.body.success = true;&#10;  return res;&#10;}">${esc(r.responseScript || '')}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        <div><button type="button" class="btn" id="btn-test-map">▶ 测试映射</button></div>
        <div class="actions">
          <button type="button" class="btn" data-close-modal>取消</button>
          <button type="button" class="btn btn-primary" id="btn-save-rule">保存规则</button>
        </div>
      </div>
    </div>
  </div>`;
}

function openEditor(rule) {
  state.editor = JSON.parse(JSON.stringify(rule || defaultRule()));
  $('#modal-root').innerHTML = editorHtml(state.editor);
  bindEditor();
}

function closeEditor() {
  $('#modal-root').innerHTML = '';
  state.editor = null;
}

function collectRule() {
  const r = state.editor;
  r.name = $('#ed-name').value.trim() || '未命名规则';
  r.enabled = $('#ed-enabled').checked;
  r.match.path = $('#ed-path').value.trim();
  r.match.pathType = $('#ed-path-type').value;
  r.match.methods = $$('#ed-methods input:checked').map((i) => i.value);
  r.target.url = $('#ed-target-url').value.trim();
  r.target.timeoutMs = parseInt($('#ed-timeout').value || '30000', 10) || 30000;
  const rw = {};
  $$('.rw-row').forEach((row) => {
    const f = row.querySelector('.rw-from').value.trim();
    if (f) rw[f] = row.querySelector('.rw-to').value;
  });
  r.target.pathRewrite = rw;
  const th = {};
  $$('.th-row').forEach((row) => {
    const n = row.querySelector('.th-name').value.trim();
    if (n) th[n] = row.querySelector('.th-value').value;
  });
  r.target.headers = th;
  const type = $('#ed-maptype').value;
  if (type === 'none') r.mapping = { type: 'none' };
  else if (type === 'template') {
    const map = { type: 'template', query: {}, body: {}, headers: {} };
    $$('.map-row[data-sec]').forEach((row) => {
      const name = row.querySelector('.map-name').value.trim();
      if (!name) return;
      map[row.dataset.sec][name] = row.querySelector('.map-expr').value;
    });
    r.mapping = map;
  } else {
    r.mapping = { type: 'js', script: $('#ed-js-script').value };
  }
  r.responseScript = $('#ed-resp-script').value;
  return r;
}

function bindEditor() {
  const root = $('#modal-root');

  // 映射类型切换
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-maptype]');
    if (tab) {
      const type = tab.dataset.maptype;
      $('#ed-maptype').value = type;
      $$('.tab-btn', root).forEach((b) => b.classList.toggle('active', b.dataset.maptype === type));
      $$('.map-pane', root).forEach((p) => { p.style.display = p.dataset.pane === type ? '' : 'none'; });
    }
    const del = e.target.closest('.map-del');
    if (del) { const row = del.closest('.map-row'); if (row) row.remove(); }
    const addMap = e.target.closest('.add-map');
    if (addMap) {
      const sec = addMap.dataset.sec;
      const wrap = $('#map-' + sec, root);
      const empty = wrap.querySelector('.map-empty');
      if (empty) empty.remove();
      const row = document.createElement('div');
      row.className = 'map-row';
      row.dataset.sec = sec;
      row.innerHTML = '<input class="inp map-name" placeholder="输出参数名"><span class="map-eq">=</span><input class="inp map-expr" placeholder="{{query.xxx}} 或字面值"><button type="button" class="btn-icon map-del" title="删除">×</button>';
      wrap.appendChild(row);
      row.querySelector('.map-name').focus();
    }
    const addRw = e.target.closest('#add-rewrite');
    if (addRw) {
      const wrap = $('#ed-rewrite', root);
      const empty = wrap.querySelector('.map-empty');
      if (empty) empty.remove();
      wrap.insertAdjacentHTML('beforeend', '<div class="map-row rw-row"><input class="inp rw-from" placeholder="/api/old"><span class="map-eq">→</span><input class="inp rw-to" placeholder="/v2/new"><button type="button" class="btn-icon map-del" title="删除">×</button></div>');
    }
    const addTh = e.target.closest('#add-theader');
    if (addTh) {
      const wrap = $('#ed-theaders', root);
      const empty = wrap.querySelector('.map-empty');
      if (empty) empty.remove();
      wrap.insertAdjacentHTML('beforeend', '<div class="map-row th-row"><input class="inp th-name" placeholder="X-Api-Key"><span class="map-eq">=</span><input class="inp th-value" placeholder="值或 {{表达式}}"><button type="button" class="btn-icon map-del" title="删除">×</button></div>');
    }
    const test = e.target.closest('#btn-test-map');
    if (test) testEditorMapping();
    const save = e.target.closest('#btn-save-rule');
    if (save) saveRule();
  });
}

async function testEditorMapping() {
  const r = collectRule();
  if (!r.match.path) return toast('请先填写匹配路径', 'error');
  if (!r.target.url) return toast('请先填写目标服务地址', 'error');
  let sample;
  try { sample = JSON.parse($('#ed-sample').value || '{}'); }
  catch { return toast('测试样本 JSON 格式错误', 'error'); }
  try {
    const data = await api('POST', '/rules/preview', { rule: r, sample });
    const logs = (data.logs || []).map((l) => `<div class="log-line"><span class="lvl lvl-${esc(l.level)}">${esc(l.level)}</span>${esc(l.line)}</div>`).join('');
    $('#ed-test-result').innerHTML = `
      <div class="test-result">
        <div style="font-weight:700;margin-bottom:6px">映射结果</div>
        <pre>${esc(pretty(data.mapped))}</pre>
        ${logs ? `<div style="font-weight:700;margin-top:10px;margin-bottom:4px">逻辑日志</div>${logs}` : ''}
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

async function saveRule() {
  const r = collectRule();
  if (!r.match.path) return toast('请填写匹配路径', 'error');
  if (!r.target.url) return toast('请填写目标服务地址', 'error');
  try {
    if (state.editor.id) await api('PUT', '/rules/' + state.editor.id, r);
    else await api('POST', '/rules', r);
    closeEditor();
    toast('规则已保存', 'ok');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ================= 逻辑调试 ================= */
const SNIPPETS = [
  { name: '读取入参', code: "const uid = ctx.query.userId || '';\nctx.log('userId = ' + uid);" },
  { name: '时间戳+签名', code: "const ts = helpers.timestamp();\nctx.query.ts = ts;\nctx.query.sign = helpers.sha256('SECRET:' + ts);" },
  { name: '删除参数', code: "delete ctx.query.uid;\ndelete ctx.headers['x-internal'];" },
  { name: '改写目标', code: "ctx.target.url = 'https://backend-new.example.com';\nctx.path = '/v2' + ctx.path;" },
  { name: '拼接参数', code: "ctx.query.full = ctx.query.a + '-' + ctx.query.b;" },
  { name: '头/IP/追踪', code: "ctx.headers['X-Real-IP'] = ctx.ip;\nctx.headers['X-Trace'] = helpers.uuid();" },
  { name: '响应处理', code: "function transformResponse(res) {\n  if (res.body && typeof res.body === 'object') {\n    res.body.proxyTs = helpers.timestamp();\n  }\n  return res;\n}" },
];

function playgroundHtml() {
  return `
  <div class="card">
    <div class="play-grid">
      <div class="panel">
        <div style="font-weight:700;margin-bottom:8px">样本请求（JSON）</div>
        <textarea class="code-area" id="pg-sample" spellcheck="false">${esc(DEFAULT_SAMPLE)}</textarea>
        <div style="font-weight:700;margin:14px 0 8px">逻辑代码（服务端沙箱执行）</div>
        <div class="snippet-bar">${SNIPPETS.map((s, i) => `<button type="button" class="snippet-btn" data-snippet="${i}">${esc(s.name)}</button>`).join('')}</div>
        <textarea class="code-area" id="pg-script" spellcheck="false">${esc('function transform(ctx) {\n  // 读取入参\n  const uid = ctx.query.userId || \'anonymous\';\n  // 计算签名\n  const ts = helpers.timestamp();\n  ctx.query.user_id = uid;\n  ctx.query.ts = ts;\n  ctx.query.sign = helpers.sha256(uid + \':\' + ts);\n  ctx.log(\'已生成签名，uid=\' + uid);\n  return ctx;\n}')}</textarea>
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
          <button class="btn btn-primary" id="pg-run">▶ 运行测试</button>
          <span class="hint">超时上限 5000ms（config.json 可调）</span>
        </div>
      </div>
      <div class="panel">
        <div style="font-weight:700;margin-bottom:8px">运行结果</div>
        <div id="pg-result" style="font-size:12px;color:var(--muted)">点击「运行测试」查看结果、日志与耗时。</div>
      </div>
    </div>
  </div>`;
}

function bindPlayground() {
  $('#pg-run').addEventListener('click', async () => {
    let sample;
    try { sample = JSON.parse($('#pg-sample').value || '{}'); }
    catch { return toast('样本请求 JSON 格式错误', 'error'); }
    const script = $('#pg-script').value;
    if (!script.trim()) return toast('逻辑代码为空', 'error');
    const out = $('#pg-result');
    out.innerHTML = '<span class="hint">执行中…</span>';
    try {
      const data = await api('POST', '/logic/test', { script, sample });
      const logs = (data.logs || []).map((l) => `<div class="log-line"><span class="lvl lvl-${esc(l.level)}">${esc(l.level)}</span>${esc(l.line)}</div>`).join('');
      out.innerHTML = `
        <div style="margin-bottom:8px"><span class="badge badge-on">成功</span> <span class="hint">耗时 ${data.elapsedMs}ms</span></div>
        <div style="font-weight:700;margin:10px 0 4px">返回结果</div>
        <pre style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:10px;margin:0;font-size:12px;max-height:220px;overflow:auto;font-family:var(--mono)">${esc(pretty(data.result))}</pre>
        <div style="font-weight:700;margin:12px 0 4px">变换后 ctx</div>
        <pre style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:10px;margin:0;font-size:12px;max-height:300px;overflow:auto;font-family:var(--mono)">${esc(pretty(data.ctx))}</pre>
        ${logs ? `<div style="font-weight:700;margin:12px 0 4px">console 日志</div>${logs}` : ''}`;
    } catch (e) {
      out.innerHTML = `<div><span class="badge badge-off">失败</span> <span class="hint">${esc(e.message)}</span></div>`;
    }
  });
  $$('.snippet-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = $('#pg-script');
      ta.value += (ta.value ? '\n\n' : '') + SNIPPETS[Number(btn.dataset.snippet)].code;
      ta.focus();
    });
  });
}

/* ================= 请求日志 ================= */
function logsHtml() {
  return `
  <div class="toolbar filters">
    <select class="select" id="log-rule-filter"><option value="">全部规则</option></select>
    <input class="inp" id="log-kw" placeholder="搜索路径 / 目标 / 错误…">
    <label class="hint" style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="log-auto"> 自动刷新(3s)</label>
    <span class="spacer"></span>
    <button class="btn" id="log-refresh">刷新</button>
    <button class="btn btn-danger-ghost" id="log-clear">清空日志</button>
  </div>
  <div class="card">
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>时间</th><th>规则</th><th>方法</th><th>路径</th><th>目标地址</th><th>状态</th><th>耗时</th></tr></thead>
        <tbody id="log-tbody"></tbody>
      </table>
    </div>
  </div>`;
}

function renderLogsTable() {
  const tbody = $('#log-tbody');
  if (!tbody) return;
  const kw = ($('#log-kw') ? $('#log-kw').value : '').trim().toLowerCase();
  const ruleId = $('#log-rule-filter') ? $('#log-rule-filter').value : '';
  const list = state.logs.filter((l) =>
    (!ruleId || l.ruleId === ruleId) &&
    (!kw || (l.path || '').toLowerCase().includes(kw) || (l.target || '').toLowerCase().includes(kw) || (l.error || '').toLowerCase().includes(kw))
  );
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-tip">暂无日志</td></tr>';
    return;
  }
  tbody.innerHTML = list.slice(0, 200).map((l) => `
    <tr>
      <td class="hint">${fmtTime(l.ts)}</td>
      <td>${esc(l.ruleName || l.ruleId || '')}</td>
      <td><span class="tag">${esc(l.method || '')}</span></td>
      <td class="mono">${esc(l.path || '')}</td>
      <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.target || '')}">${esc(l.target || '')}</td>
      <td>${l.ok ? `<span class="badge badge-on">${l.status}</span>` : `<span class="badge badge-off" title="${esc(l.error || '')}">失败</span>`}</td>
      <td class="hint">${l.durationMs || 0}ms</td>
    </tr>`).join('');
}

function bindLogs() {
  const filter = $('#log-rule-filter');
  state.rules.forEach((r) => {
    filter.insertAdjacentHTML('beforeend', `<option value="${esc(r.id)}">${esc(r.name)}</option>`);
  });
  $('#log-rule-filter').addEventListener('change', renderLogsTable);
  $('#log-kw').addEventListener('input', renderLogsTable);
  $('#log-refresh').addEventListener('click', async () => {
    try { await refreshLogs(); toast('已刷新', 'ok'); } catch (e) { toast(e.message, 'error'); }
  });
  $('#log-clear').addEventListener('click', async () => {
    if (!confirm('确定清空全部请求日志？')) return;
    try { await api('DELETE', '/logs'); state.logs = []; renderLogsTable(); toast('已清空', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  $('#log-auto').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    startAutoRefresh();
  });
}

function startAutoRefresh() {
  if (state._refreshTimer) { clearInterval(state._refreshTimer); state._refreshTimer = null; }
  if (state.autoRefresh) {
    state._refreshTimer = setInterval(() => {
      if (state.view === 'logs') refreshLogs();
      else if (state.view === 'overview') loadData();
    }, 3000);
  }
}

/* ================= 设置 ================= */
function openSettings() {
  api('GET', '/config').then((cfg) => {
    $('#modal-root').innerHTML = `
    <div class="modal-overlay" data-modal>
      <div class="modal small">
        <div class="modal-head"><h2>设置</h2><button type="button" class="btn-icon" data-close-modal>×</button></div>
        <div class="modal-body">
          <div class="field" style="margin-bottom:14px">
            <label class="label">管理 Token（仅保存在本浏览器 localStorage）</label>
            <input class="inp" id="set-token" value="${esc(state.token)}" placeholder="留空表示不鉴权（仅本机使用建议留空）">
          </div>
          <div class="hint" style="margin-bottom:14px">Token 实际校验值在 <code>config.json</code> 的 <code>adminToken</code> 字段；此处仅用于界面请求携带。</div>
          <table class="table">
            <tr><td class="hint">监听端口</td><td class="mono">${esc(cfg.port)}</td></tr>
            <tr><td class="hint">沙箱超时</td><td class="mono">${esc(cfg.sandboxTimeoutMs)}ms</td></tr>
            <tr><td class="hint">日志上限</td><td class="mono">${esc(cfg.logLimit)}</td></tr>
            <tr><td class="hint">请求体上限</td><td class="mono">${esc(cfg.maxBodySizeMb)}MB</td></tr>
            <tr><td class="hint">可访问环境变量白名单</td><td class="mono">${esc(JSON.stringify(cfg.envWhitelist || []))}</td></tr>
            <tr><td class="hint">规则数据文件</td><td class="mono">${esc(cfg.dataFile)}</td></tr>
          </table>
          <p class="hint" style="margin-top:12px">端口、Token、超时等修改需编辑 <code>config.json</code> 后重启服务。也可在「转发规则」页点击「重新载入数据文件」热加载手工编辑的规则。</p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" data-close-modal>关闭</button>
          <button type="button" class="btn btn-primary" id="btn-save-token">保存 Token</button>
        </div>
      </div>
    </div>`;
    $('#btn-save-token').addEventListener('click', () => {
      state.token = $('#set-token').value.trim();
      localStorage.setItem('kpg_token', state.token);
      toast('Token 已保存', 'ok');
      $('#modal-root').innerHTML = '';
    });
  }).catch((e) => toast(e.message, 'error'));
}

/* ================= 初始化 ================= */
function init() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) switchView(b.dataset.view);
  });
  $('#btn-settings').addEventListener('click', openSettings);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) {
      const overlay = e.target.closest('.modal-overlay');
      if (overlay) overlay.remove();
      state.editor = null;
      return;
    }
    const overlay = e.target.closest('.modal-overlay');
    if (overlay && e.target === overlay) overlay.remove();
  });
  render();
  loadData();
}

document.addEventListener('DOMContentLoaded', init);
