/**
 * 输出适配器：JSONL 文件
 *
 * 每看一张图，往一个 .jsonl 文件追加一行 —— 最通用的出口：
 * 任何语言、任何系统都能读，也方便人工翻看。
 */

import { appendFileSync } from 'node:fs';

/**
 * @param {object} item  { desc, points, url, key, sender, at }
 * @param {object} cfg   { file: '……/vision-log.jsonl' }
 * @returns {{ok: boolean, file?: string, error?: string}}
 */
export function deliver(item, cfg = {}) {
  try {
    if (!cfg.file) throw new Error('jsonl 输出没配 file');
    const line = JSON.stringify({
      ts: item.at,
      url: item.url,
      desc: item.desc,
      points: item.points,
      chatKey: item.key,
      sender: item.sender,
    });
    appendFileSync(cfg.file, line + '\n', 'utf8');
    return { ok: true, file: cfg.file };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
