/**
 * 输出适配器：环形的心 · MCP 接入
 *
 * 走环形的心**官方插件接口**（MCP over stdio，mcp/server.mjs）——
 * 和 DSH agent 用的是同一个口。这是正式的接入方式：
 * 留影不 import 记忆库的任何代码，只 spawn 它的 MCP server、说 JSON-RPC。
 *
 * 用哪个工具：
 *   ring_ingest —— 自动入库语义（闲聊圈 ring4，skipVault：原始消息的备份管不着）。
 *   视觉描述是自动捕获的（她没表态），所以走入库工具，不走她点名的 ring_remember。
 *
 * 会话管理：
 *   MCP server 进程长驻复用（spawn 一次，之后每次投递走同一会话）；
 *   进程死了下次投递自动重新 spawn。测试可注入 spawnImpl。
 *
 * cfg: { ringRoot?（环形的心项目根，自动找）, speaker?（默认 item.sender） }
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RING_ROOT_CANDIDATES = [
  process.env.RING_ROOT,
  'D:/我的电脑/桌面/插件/环形的心',
  'D:/我的电脑/桌面/环形的心',
  process.env.USERPROFILE && `${process.env.USERPROFILE}/环形的心`,
].filter(Boolean).map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, ''));

export function ringRoot() {
  return RING_ROOT_CANDIDATES.find((p) => existsSync(`${p}/mcp/server.mjs`)) || null;
}

let session = null; // { proc, pending: Map<id, {resolve, reject}>, nextId }

function rawSend(proc, obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n');
}

/** 起一个 MCP server 子进程并完成 initialize 握手 */
function startSession(cfg = {}) {
  const root = cfg.ringRoot || ringRoot();
  if (!root) throw new Error('找不到环形的心项目（MCP server.mjs），设 RING_ROOT 指过去');
  const server = join(root, 'mcp', 'server.mjs');
  if (!existsSync(server)) throw new Error(`环形的心 MCP server 不存在：${server}`);

  const proc = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      } catch { /* 半行/脏行忽略 */ }
    }
  });
  proc.stderr.on('data', () => {}); // server 的日志走 stderr，丢弃
  proc.on('exit', (code) => {
    for (const p of pending.values()) p({ error: { code: -1, message: `MCP server 退出（${code}）` } });
    pending.clear();
    if (session && session.proc === proc) session = null;
  });

  const rpc = (method, params, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} 超时`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    rawSend(proc, { jsonrpc: '2.0', id, method, params });
  });

  const s = { proc, rpc, nextId: 0 };
  // initialize 握手（协议要求，不等结果也行——server 是逐行处理的，但规矩要走）
  rawSend(proc, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'liuying-vision', version: '0.1.0' } } });
  s.rpc = (method, params, timeoutMs) => rpc(method, params, timeoutMs);
  return s;
}

/** 拿一个可用会话（没有就起；起不来抛错，调用方 catch） */
export async function getMcpSession(cfg = {}) {
  if (session && session.proc && session.proc.exitCode === null) return session;
  session = startSession(cfg);
  // 等 initialize 被处理（server 逐行处理，第一条发出后即就绪；这里只让事件循环转一圈）
  await new Promise((r) => setTimeout(r, 50));
  return session;
}

/** 测试/关停用：结束 MCP 子进程 */
export function closeMcpSession() {
  if (session) { try { session.proc.kill(); } catch {} session = null; }
}

/**
 * 投递一条视觉描述（自动入库语义：闲聊圈，skipVault）。
 * @param {object} item  { desc, points, url, kind, key, sender, at }
 * @param {object} cfg   { ringRoot?, spawnImpl? }
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export async function deliver(item, cfg = {}, ctx = {}) {
  try {
    const s = await getMcpSession(cfg);
    const result = await s.rpc('tools/call', {
      name: 'ring_ingest',
      arguments: {
        content: item.desc,
        points: item.points ?? [],
        source: String(item.key || '').includes('group') ? 'group' : 'private',
        speaker: item.sender || 'user',
        at: item.at ?? Date.now(),
      },
    });
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) throw new Error(text);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
