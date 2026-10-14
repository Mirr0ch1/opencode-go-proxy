#!/usr/bin/env node
/**
 * opencode-go-proxy
 *
 * 反向代理：让 CodeBuddy 的自定义模型（models.json）能用自带 key 直连
 * opencode-go 公开端点。需要它做 CodeBuddy 自己做不到的事：
 *
 *   1. 注入 `x-opencode-session` 头 —— opencode-go 强制要求（缺失返回
 *      400 MissingSessionID），而 models.json 无法给模型请求加自定义头。
 *   2. 改写请求体里的 `model` 字段 —— models.json 的 `id` 会原样作为 `model`
 *      发给上游，但为了不覆盖内置模型，我们把自定义 id 加上了 `-opencode`
 *      后缀（如 deepseek-v4.1-flash-opencode）。opencode-go 只认不带后缀的
 *      名字，所以这里把后缀剥掉（顺带去掉可能的 `custom-local:` 前缀）。
 *
 * 行为：
 *   - 监听 PROXY_BIND:PORT（默认 0.0.0.0:18999），可被局域网 / Tailscale 等
 *     多个网段访问。安全不靠网络边界，靠下面的 PROXY_TOKEN 兜底。
 *   - 鉴权：要求请求带 Authorization: Bearer <PROXY_TOKEN>，不匹配返回 401。
 *     客户端（含本机 CodeBuddy）在 models.json 的 apiKey 字段填这个 token。
 *   - 把任意方法/路径转发到 https://opencode.ai/inference/go/v1 + 原路径
 *   - 注入 x-opencode-session：按稳定性回退——客户端显式会话 ID（X-Conversation-ID /
 *     X-Session-ID）→ 内容哈希（system+首条 user 消息）→ 随机 UUID。前两者都保证
 *     同一会话多轮请求 session 稳定，命中 prompt 缓存省订阅钱。
 *   - 注入真实 Authorization（读环境变量 OPENCODE_GO_API_KEY，覆盖客户端送的 token）
 *   - 设置非通用 User-Agent
 *   - SSE 流式响应透明透传
 */

import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';

const PORT = Number.parseInt(process.env.PROXY_PORT ?? '18999', 10);
const BIND = process.env.PROXY_BIND ?? '0.0.0.0';
const TOKEN = process.env.PROXY_TOKEN ?? '';
const UPSTREAM_HOST = 'opencode.ai';
const UPSTREAM_BASE = '/inference/go/v1';
const API_KEY = process.env.OPENCODE_GO_API_KEY ?? '';
const USER_AGENT = 'codebuddy-opencode-go-proxy/1.0';
const SUFFIX = '-opencode';

// hop-by-hop 头，不能原样透传（否则会破坏连接复用/分帧）
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
]);

// 从请求体提取"会话指纹"：system 消息 + 首条 user 消息的内容。
// 用于无显式会话 ID 的客户端（如裸调 SDK 的其他 harness），保证同一会话的
// 多轮请求指纹一致 → session 稳定 → 命中上游 prompt 缓存、省订阅钱。
// 返回 null 表示拿不到指纹（body 非 JSON 或没有 user 消息），调用方退回随机 UUID。
function sessionFingerprint(rawBody) {
  try {
    const obj = JSON.parse(rawBody);
    if (!Array.isArray(obj.messages) || obj.messages.length === 0) return null;
    const system = obj.messages.find((m) => m?.role === 'system');
    const firstUser = obj.messages.find((m) => m?.role === 'user');
    if (!firstUser) return null;
    const sysContent = system ? JSON.stringify(system.content ?? '') : '';
    const userContent = JSON.stringify(firstUser.content ?? '');
    return `${sysContent}\n${userContent}`;
  } catch {
    return null;
  }
}

// 解析 x-opencode-session 的值，按稳定性从高到低回退（借鉴 LIMTCYT/opencode-go-proxy-for-trae）：
//   1. 客户端显式会话 ID（X-Conversation-ID / X-Session-ID / x-opencode-session 本身）
//   2. 内容哈希（system + 首条 user 消息）——同一会话多轮请求指纹一致，session 稳定
//   3. 随机 UUID——最后兜底，仍能通过 400 MissingSessionID 校验，但每轮都变、无缓存命中
// 之所以追求"稳定"而非"只要不 400"：session 稳定时 opencode-go 能命中 prompt 缓存
// （usage.cached_tokens>0），直接省订阅钱。
function resolveSessionId(headers, rawBody) {
  const candidates = [
    headers['x-conversation-id'],
    headers['x-session-id'],
    headers['x-opencode-session'],
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const fp = sessionFingerprint(rawBody);
  if (fp) {
    const h = createHash('sha256').update(fp).digest('hex').slice(0, 24);
    return `hash-${h}`;
  }
  return `cb-${randomUUID()}`;
}

// 把 CodeBuddy 发来的 model 名改回 opencode-go 认识的：
//   custom-local:deepseek-v4.1-flash-opencode -> deepseek-v4.1-flash
function rewriteModelName(model) {
  if (typeof model !== 'string') return model;
  let m = model;
  if (m.startsWith('custom-local:')) m = m.slice('custom-local:'.length);
  if (m.endsWith(SUFFIX)) m = m.slice(0, -SUFFIX.length);
  return m;
}

// 请求体摘要：提取顶层 reasoning/thinking 参数 + 每条 message 的 reasoning_content 状态，
// 用于排查 thinking-mode 多轮协议问题（如 "reasoning_content must be passed back"）。
function summarizeRequest(rawBody) {
  try {
    const o = JSON.parse(rawBody);
    const top = {};
    for (const k of Object.keys(o)) {
      if (k === 'messages') continue;
      top[k] =
        typeof o[k] === 'string' ? o[k].slice(0, 60) : JSON.stringify(o[k]).slice(0, 60);
    }
    const msgs = Array.isArray(o.messages)
      ? o.messages.map((m) => {
          const rc = m.reasoning_content;
          const rcInfo = rc === undefined ? 'no-rc' : `rc:${String(rc).length}`;
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `${m.role}${rcInfo}(${content.length})`;
        })
      : [];
    return `top=${JSON.stringify(top)} msgs=[${msgs.join(',')}]`;
  } catch {
    return `(non-json) ${rawBody.slice(0, 200)}`;
  }
}

function buildUpstreamHeaders(req, sessionId) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'host') continue; // 目标主机要改成 opencode.ai
    headers[k] = v;
  }

  headers['host'] = UPSTREAM_HOST;
  headers['x-opencode-session'] = sessionId;
  headers['user-agent'] = USER_AGENT;
  if (API_KEY) headers['authorization'] = `Bearer ${API_KEY}`;
  return headers;
}

// 无 TOKEN 时拒绝启动：这个代理携带真实订阅 key，一旦绑非 loopback 且无鉴权，
// 等于把额度对全网段开放。宁可 fail-fast 也不裸奔。
if (!TOKEN) {
  console.error(
    '[opencode-go-proxy] FATAL: PROXY_TOKEN is required — refusing to expose the API without auth',
  );
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const start = Date.now();

  // 鉴权：共享 token（Bearer）。不匹配直接 401，不读 body、不转发。
  const auth = req.headers['authorization'] ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (bearer !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
    console.log(
      `[opencode-go-proxy] ${req.method} ${req.url} -> 401 (${Date.now() - start}ms) bad-token`,
    );
    return;
  }

  const upstreamPath = `${UPSTREAM_BASE}${req.url ?? '/'}`;

  // 缓冲请求体（JSON），用于改写 model 字段 + 提取会话指纹；缓冲后再整体转发
  const bodyChunks = [];
  req.on('data', (c) => bodyChunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(bodyChunks).toString('utf8');
    const sessionId = resolveSessionId(req.headers, rawBody);
    let forwardBody = rawBody;
    let modelLog = '';

    if (rawBody.trim()) {
      try {
        const obj = JSON.parse(rawBody);
        const original = obj.model;
        if (obj.model !== undefined) obj.model = rewriteModelName(obj.model);
        modelLog =
          original !== obj.model ? `${original}->${obj.model}` : `${obj.model}`;
        forwardBody = JSON.stringify(obj);
      } catch {
        // 非 JSON 请求体（理论上不会发生），原样转发
        modelLog = '(non-json body)';
      }
    }

    const headers = buildUpstreamHeaders(req, sessionId);
    headers['content-length'] = Buffer.byteLength(forwardBody);

    const upstreamReq = https.request(
      {
        host: UPSTREAM_HOST,
        path: upstreamPath,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const duration = Date.now() - start;

        // 成功：直接流式透传，日志只记状态 + 耗时 + 模型改写
        if (status < 400) {
          res.writeHead(status, upstreamRes.headers);
          upstreamRes.pipe(res);
          console.log(
            `[opencode-go-proxy] ${req.method} ${req.url} -> ${status} (${duration}ms) session=${sessionId} model=${modelLog}`,
          );
          return;
        }

        // 错误：缓冲 body 便于排查（记录上游真实报错，如 "Model is unavailable"）
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          const cleanHeaders = { ...upstreamRes.headers };
          delete cleanHeaders['transfer-encoding'];
          delete cleanHeaders['content-length'];
          res.writeHead(status, cleanHeaders);
          res.end(body);
          console.log(
            `[opencode-go-proxy] ${req.method} ${req.url} -> ${status} (${duration}ms) session=${sessionId} model=${modelLog} req=${summarizeRequest(rawBody)} body=${body}`,
          );
        });
      },
    );

    upstreamReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `opencode-go-proxy upstream error: ${err.message}` },
          }),
        );
      }
      console.log(
        `[opencode-go-proxy] ${req.method} ${req.url} -> ERROR (${Date.now() - start}ms) ${err.message}`,
      );
    });

    upstreamReq.end(forwardBody);
  });

  req.on('error', () => res.destroy());
});

server.listen(PORT, BIND, () => {
  // 一行便于 journald 里 grep
  console.log(
    `[opencode-go-proxy] listening ${BIND}:${PORT} -> https://${UPSTREAM_HOST}${UPSTREAM_BASE} (auth=token)`,
  );
});
