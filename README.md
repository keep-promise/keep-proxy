# Keep Proxy Gateway · 服务代理转发应用

一个零依赖的 Node.js 服务代理转发网关：**管理后台配置参数映射逻辑，逻辑代码在服务端沙箱中运行**。

- 管理后台（Web）：新增/编辑/启停转发规则，配置参数映射
- 三种映射方式：**透传**、**模板映射**（`{{表达式}}`）、**JS 逻辑**（服务端沙箱执行）
- 支持路径重写、请求头改写、响应处理脚本、请求日志、规则命中统计
- 规则持久化到 `data/rules.json`，改文件后可热重载

## 架构

```
调用方 ──HTTP──▶ Keep Proxy Gateway ──规则匹配──▶ 参数映射/逻辑（沙箱JS/模板）──▶ 目标服务 ──▶ 响应返回
                    │
                    └─ 管理后台 /admin（同端口）
```

## 快速开始

要求：Node.js ≥ 18（本机已确认 v22）。

```bash
cd D:\keep\keep-proxy-gateway
node server.js
```

然后打开管理后台：<http://127.0.0.1:8080/admin>

也可以直接双击 `start.bat` 启动。

代理入口就是服务本身：`http://127.0.0.1:8080/<规则匹配的路径>`，命中规则后转发到目标服务；未命中返回 404 JSON。

## 目录结构

```
keep-proxy-gateway/
├── server.js            # 入口：HTTP 服务（管理后台 + 代理转发）
├── config.json          # 端口 / Token / 沙箱超时等配置
├── start.bat            # Windows 一键启动
├── data/
│   └── rules.json       # 转发规则持久化文件（含 2 条示例规则）
├── src/
│   ├── sandbox.js       # node:vm 服务端逻辑沙箱（白名单 + 超时 + 阻断逃逸）
│   ├── proxy.js         # 规则匹配 / 参数映射 / 转发引擎
│   ├── rule-store.js    # 规则 CRUD + 原子持久化 + 命中统计
│   ├── admin-api.js     # /admin/api/* 管理接口
│   └── ring-buffer.js   # 内存请求日志
├── public/              # 管理后台前端（原生 HTML/CSS/JS，无构建）
└── test/
    └── echo-server.js   # 本地回显服务，用于验证映射结果
```

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 8080 | 服务监听端口（管理后台与代理共用） |
| `adminToken` | `""` | 管理接口鉴权 Token；留空=不鉴权（仅本机建议留空） |
| `logLimit` | 500 | 内存请求日志条数 |
| `sandboxTimeoutMs` | 5000 | 逻辑代码沙箱执行超时上限 |
| `maxBodySizeMb` | 20 | 入站请求体大小上限 |
| `envWhitelist` | `[]` | 允许逻辑代码通过 `helpers.env` 访问的环境变量白名单 |

修改后需重启服务生效。

## 转发规则配置

规则结构（管理后台可视化编辑，也支持直接改 `data/rules.json`）：

```json
{
  "name": "订单查询转发",
  "enabled": true,
  "match": {
    "path": "/api/orders/**",
    "pathType": "glob",
    "methods": ["GET", "POST"]
  },
  "target": {
    "url": "http://backend:9000",
    "pathRewrite": { "/api/orders": "/v1/orders" },
    "headers": { "X-Gateway": "keep-proxy" },
    "timeoutMs": 10000
  },
  "mapping": {
    "type": "template",
    "query": { "bizId": "{{query.orderId}}", "ts": "{{helpers.timestamp()}}" },
    "body": {},
    "headers": {}
  },
  "responseScript": ""
}
```

### 匹配条件

- `path`：匹配路径
- `pathType`：
  - `prefix` 前缀匹配：路径开头命中即可
  - `exact` 精确匹配：完全相等
  - `glob` 通配符：`*` 单段、`**` 任意
  - `regex` 正则表达式
- `methods`：方法数组，留空 = 全部方法

### 目标服务

- `url`：目标基础地址（http/https）
- `pathRewrite`：源路径前缀 → 目标路径前缀（如 `/api/orders` → `/v1/orders`）
- `headers`：额外请求头（值支持 `{{表达式}}`）
- `timeoutMs`：转发超时

### 参数映射（核心）

**① 透传（none）**：请求参数原样转发。

**② 模板映射（template）**：把入参映射为出参，作用于 query / body / headers 三个维度。

表达式语法（用 `{{...}}` 包裹，可访问）：

| 变量 | 含义 |
|---|---|
| `query.xxx` | 入站 Query 参数 |
| `body.xxx` | 入站请求体（JSON 对象时） |
| `headers.xxx` | 入站请求头 |
| `params.xxx` | 路径参数（预留） |
| `method` / `path` / `ip` | 请求方法 / 路径 / 来源 IP |
| `helpers.xxx` | 内置工具（见下） |
| `env.xxx` | 白名单环境变量 |

- 无花括号的值 = 字面量：`{"app": "keep"}` 直接输出 `keep`
- 支持拼接：`"pre-{{query.a}}-{{helpers.timestamp()}}"`
- 值求值为 `__REMOVE__` 时删除该参数

**③ JS 逻辑（js）**：编写 `function transform(ctx){ ... }` 在服务端沙箱执行。

```js
function transform(ctx) {
  // 读取入参
  const userId = ctx.query.userId || 'anonymous';
  // 计算签名（沙箱内置 helpers）
  const ts = helpers.timestamp();
  const sign = helpers.sha256(userId + ':' + ts);
  // 改写转发参数
  ctx.query.user_id = userId;
  ctx.query.ts = ts;
  ctx.query.sign = sign;
  // 改请求头 / 目标地址
  ctx.headers['X-Client'] = 'keep-proxy';
  // ctx.target.url = 'https://other.example.com';
  ctx.log('生成签名 sign=' + sign.slice(0, 8) + '...');
  return ctx; // 直接改对象后返回 ctx，或返回新对象
}
```

ctx 字段：`method, path, fullPath, ip, query, headers, body, params, target, log()`

### 响应处理（responseScript）

可选，处理目标服务返回后再回给调用方：

```js
function transformResponse(res) {
  // res = { status, headers, body, path }
  if (res.body && typeof res.body === 'object') res.body.proxyTs = helpers.timestamp();
  return res; // 可覆盖 { status, headers, body }
}
```

### helpers 内置工具（逻辑代码可用）

`uuid()`、`timestamp()`、`nowIso()`、`md5()`、`sha1()`、`sha256()`、`hmacSha256(key, s)`、`base64Encode/Decode()`、`jsonParse/jsonStringify`、`randomInt(min,max)`、`pick(obj,keys)`、`omit(obj,keys)`、`env`

## 沙箱安全说明

- 基于 `node:vm`，只注入白名单内建对象与 helpers，**不暴露 `require` / `process` / `globalThis`**
- 通过 `contextCodeGeneration.strings=false` 阻断 `eval` / `new Function` 逃逸
- 统一超时（`sandboxTimeoutMs`），防死循环阻塞
- 注意：这是尽力隔离（best-effort）沙箱，**逻辑代码应只信任本团队编写**；若对外开放管理后台，务必配置 `adminToken` 并置于可信网络

## 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/stats` | 规则与命中统计 |
| GET/POST | `/admin/api/rules` | 规则列表 / 新建 |
| PUT/DELETE | `/admin/api/rules/:id` | 更新 / 删除 |
| POST | `/admin/api/rules/:id/toggle` | 启停 |
| POST | `/admin/api/rules/:id/duplicate` | 复制 |
| POST | `/admin/api/rules/preview` | 未保存规则测试映射 |
| POST | `/admin/api/logic/test` | 逻辑脚本调试 |
| GET/DELETE | `/admin/api/logs` | 请求日志 / 清空 |
| POST | `/admin/api/reload` | 从数据文件热重载规则 |

## 本地验证示例

```bash
# 1. 启动回显服务（模拟目标服务）
node test/echo-server.js 9099

# 2. 在管理后台新建规则：
#    匹配路径 /demo/weather (exact, GET)
#    目标地址 http://127.0.0.1:9099，路径重写 /demo/weather → /echo
#    映射: template, query { city: "{{query.city}}", ts: "{{helpers.timestamp()}}" }

# 3. 发起请求，回显将显示映射后的参数
curl "http://127.0.0.1:8080/demo/weather?city=Hangzhou"
```

## 常见问题

- **改端口**：编辑 `config.json` 的 `port` 后重启。
- **开机自启 / 常驻**：可用 `pm2 start server.js` 或 nssm 注册为 Windows 服务。
- **后端在本机其它端口**：目标地址填 `http://127.0.0.1:<端口>` 即可。
- **手工改了 rules.json**：管理后台「转发规则」页点「重新载入数据文件」，或调 `POST /admin/api/reload`。
