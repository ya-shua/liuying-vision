/**
 * 眼睛自己的记账本（eye.db）。
 *
 * 和输出目标彻底无关：看没看过（去重）、今天看了几张（日限）、
 * 描述是什么（审计）都记在这里 —— 换输出、删输出，账本不受影响。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const cache = new Map(); // dataDir → store

/**
 * @param {string} dataDir eye.db 的家（默认跟 vision.json 同目录）
 */
export function openEyeStore(dataDir) {
  if (cache.has(dataDir)) return cache.get(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'eye.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS seen (
      hash TEXT PRIMARY KEY,
      url TEXT,
      chat_key TEXT,
      model TEXT,
      desc TEXT,
      outputs TEXT,
      created_at INTEGER,
      ms INTEGER,
      kind TEXT
    );
  `);
  try { db.exec('ALTER TABLE seen ADD COLUMN ms INTEGER'); } catch {} // 老 eye.db 补列
  try { db.exec('ALTER TABLE seen ADD COLUMN kind TEXT'); } catch {}
  try { db.exec('ALTER TABLE seen ADD COLUMN tokens INTEGER'); } catch {} // token 消耗记账
  const store = {
    db,
    hasSeen(hash) {
      return !!db.prepare('SELECT 1 FROM seen WHERE hash = ?').get(hash);
    },
    seenToday(dayStart) {
      return db.prepare('SELECT COUNT(*) AS n FROM seen WHERE created_at >= ?').get(dayStart).n;
    },
    total() {
      return db.prepare('SELECT COUNT(*) AS n FROM seen').get().n;
    },
    lastSeenAt() {
      return db.prepare('SELECT MAX(created_at) AS t FROM seen').get().t ?? null;
    },
    /** token 消耗：今日（tokens 有数的才算——免费档不回 usage 的只算次数）/ 累计 */
    usageToday(dayStart) {
      return db.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS n FROM seen WHERE created_at >= ?').get(dayStart);
    },
    usageTotal() {
      return db.prepare('SELECT COALESCE(SUM(tokens),0) AS tokens, COUNT(*) AS n FROM seen').get();
    },
    record({ hash, url, chatKey, model, desc, outputs, createdAt, ms, kind, tokens }) {
      db.prepare(
        'INSERT INTO seen (hash, url, chat_key, model, desc, outputs, created_at, ms, kind, tokens) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(hash, url, chatKey ?? null, model ?? null, desc ?? null, JSON.stringify(outputs ?? []), createdAt, ms ?? null, kind ?? null, tokens ?? null);
    },
    recent(limit = 50) {
      return db
        .prepare('SELECT created_at, url, chat_key, model, desc, outputs, ms, kind FROM seen ORDER BY created_at DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ ...r, outputs: JSON.parse(r.outputs || '[]') }));
    },
  };
  cache.set(dataDir, store);
  return store;
}

/** 关掉某个 dataDir 的账本连接（测试/面板退出用；不关的话 node:sqlite 句柄会吊住进程） */
export function closeEyeStore(dataDir) {
  const s = cache.get(dataDir);
  if (!s) return;
  cache.delete(dataDir);
  try { s.db.close(); } catch { /* 关不掉就算了 */ }
}
