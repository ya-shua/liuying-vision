/**
 * 输出适配器：记忆库（环形的心 / Ringmind）
 *
 * 把看图的描述写进一个 Ringmind 形态的记忆库。
 * 这是可选适配器之一 —— 没接记忆库也能用眼睛（jsonl / webhook / 自定义适配器）。
 *
 * 集成方式：动态 import 目标记忆库的 Ringmind（ring-ingest 同款先例），
 * 库本身零改动。**所有参数必须显式配置** —— 本适配器不知道任何具体库的路径或名字。
 *
 * 必填：cfg.dbPath（库文件路径；环境变量 RING_DB 可兜底）
 * 可选：cfg.name（库名）、cfg.ring（进的圈，缺省由记忆库自己定）、
 *       cfg.skipVault（默认 true：描述是派生物，原始消息的备份管不着也不重复存）、
 *       cfg.db（直接注入实例，测试用）
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map(); // dbPath|name → Ringmind 实例

// 本文件位于 <插件根>/src/adapters/ringmind.mjs
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 从环境/候选路径解析记忆库项目根（ringRoot 优先级：RING_ROOT > 与留影并列的目录 > 用户目录） */
export function ringRoot() {
  const candidates = [
    process.env.RING_ROOT,
    join(PLUGIN_ROOT, '..', '环形的心'), // 常见装法：桌面/插件/{留影,环形的心} 并排
    process.env.USERPROFILE && join(process.env.USERPROFILE, '环形的心'),
  ].filter(Boolean).map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, ''));
  return candidates.find((p) => existsSync(`${p}/src/index.js`)) || null;
}

/**
 * 把一条视觉描述投递给记忆库。
 * @param {object} item  { desc, points, url, key, sender, at }
 * @param {object} cfg   { dbPath!, name?, ring?, skipVault?, db? }
 * @returns {Promise<{ok: boolean, memoryId?: string, ring?: string, error?: string}>}
 */
export async function deliver(item, cfg = {}) {
  try {
    let handle = cfg.db;
    if (!handle) {
      const dbPath = cfg.dbPath || process.env.RING_DB;
      if (!dbPath) throw new Error('记忆库适配器缺 dbPath（要写进哪个库文件）');
      const name = cfg.name || '';
      const cacheKey = dbPath + '|' + name;
      if (cache.has(cacheKey)) handle = cache.get(cacheKey);
      else {
        const root = ringRoot();
        if (!root) throw new Error('找不到环形的心项目（RING_ROOT 未设且常见位置没有）');
        const mod = await import(`file://${root}/src/index.js`);
        handle = new mod.Ringmind(dbPath, name);
        cache.set(cacheKey, handle);
      }
    }

    const memory = handle.remember({
      content: item.desc,
      points: item.points,
      source: String(item.key || '').includes('group') ? 'group' : 'private',
      speaker: item.sender || 'user',
      ...(cfg.ring ? { ring: cfg.ring } : {}),   // 不指定就让记忆库自己定默认圈
      skipVault: cfg.skipVault !== false,          // 默认 true：描述是派生物，不进原始备份
      at: item.at,
    });

    return { ok: true, memoryId: memory.id, ...(cfg.ring ? { ring: cfg.ring } : {}) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
