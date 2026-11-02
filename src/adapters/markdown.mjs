/**
 * 输出适配器：Markdown 笔记
 *
 * 每看一张图/一段视频，往一个 .md 文件追加一节 —— Obsidian / 任何笔记软件直接打开。
 * 文件不存在会自动建（带文档头）；每节带日期标题，方便按天翻。
 *
 * cfg: { file!（.md 路径）, title?（文档头标题，默认「留影」） }
 */

import { existsSync, appendFileSync } from 'node:fs';

export function deliver(item, cfg = {}) {
  try {
    if (!cfg.file) throw new Error('Markdown 适配器缺 file');
    if (!existsSync(cfg.file)) {
      appendFileSync(cfg.file, '# ' + (cfg.title || '留影') + '\n\n> 视觉接入的看图记录。\n', 'utf8');
    }
    const d = new Date(item.at ?? Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const kindTxt = item.kind === 'video' ? `视频（${item.frames ?? '?'} 帧）` : '图片';
    const section =
      `\n## ${stamp} · ${kindTxt}\n\n` +
      `${item.desc ?? ''}\n\n` +
      (item.points?.length ? item.points.map((x) => `- ${x}`).join('\n') + '\n' : '') +
      `\n图链：${item.url ?? ''}\n`;
    appendFileSync(cfg.file, section, 'utf8');
    return { ok: true, file: cfg.file };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
