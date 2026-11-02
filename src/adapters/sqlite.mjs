/**
 * 输出适配器：SQLite 数据库（通用）
 *
 * 把视觉描述写进任何一个 SQLite 库的表里 —— node:sqlite 内置，零依赖。
 * 和 ringmind 适配器的区别：不要求对方是环形的心，**任何系统的 SQLite 库都能进**；
 * 表不存在自动建，存在就直接插 —— 字段是通用形状，不做任何记忆库的假设。
 *
 * cfg: { dbPath!（库文件）, table（默认 vision_log）, extra?（附加字段对象，JSON 存进 extra 列） }
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const cache = new Map(); // dbPath|table → db

export function deliver(item, cfg = {}) {
  try {
    if (!cfg.dbPath) throw new Error('SQLite 适配器缺 dbPath');
    const table = /^[A-Za-z0-9_]+$/.test(cfg.table ?? '') ? cfg.table : 'vision_log';
    const key = cfg.dbPath + '|' + table;
    if (!cache.has(key)) {
      mkdirSync(dirname(cfg.dbPath), { recursive: true });
      const db = new DatabaseSync(cfg.dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER,
          url TEXT,
          kind TEXT,
          desc TEXT,
          points TEXT,
          chat_key TEXT,
          sender TEXT,
          extra TEXT
        );
      `);
      cache.set(key, db);
    }
    const db = cache.get(key);
    db.prepare(
      `INSERT INTO ${table} (created_at, url, kind, desc, points, chat_key, sender, extra) VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      item.at ?? Date.now(),
      item.url ?? null,
      item.kind ?? null,
      item.desc ?? null,
      JSON.stringify(item.points ?? []),
      item.key ?? null,
      item.sender ?? null,
      cfg.extra ? JSON.stringify(cfg.extra) : null,
    );
    return { ok: true, file: cfg.dbPath, table };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
