/**
 * 留影 · 通用视觉接入编排层（2026-10-31 设计，11-01 扩展视频）
 *
 * 独立插件，不绑任何记忆库：核心只做「看媒体 → 描述」，看完了交给**输出适配器**。
 * 内置适配器（vision.json 的 outputs 里按需启用、可叠加、互不拖累）：
 *
 *   ringmind —— 写进环形的心记忆库（可选适配器之一，动态 import，库零改动）
 *   sqlite   —— 通用 SQLite 表（任何系统的库，表不存在自动建）
 *   jsonl    —— 追加进一个 .jsonl 文件
 *   markdown —— 追加进一个 .md 笔记（Obsidian 友好）
 *   webhook  —— POST JSON 到任意地址
 *   custom   —— 指向你自己的 .mjs（导出 deliver 即可接任何系统）
 *
 * 媒体：图片 + 视频。视频按用户配置抽帧（ffmpeg），每帧描述合并成一条记忆。
 * 没装 ffmpeg → 视频跳过并在面板提示，图片照常。
 *
 * 两条铁律：
 *   ① 去重/日限/审计记在眼睛自己的 eye.db 里 —— 换输出、删输出，账本不受影响
 *   ② 下载失败 / 某个输出挂了 / 视频抽帧失败 → 静默跳过或单独记错，
 *      绝不影响消息主流程，也不拖累其它输出
 *
 * 桥接侧（qq-bridge/src/bridge.js）两行补丁（调用点动态 import，已打好）：
 *   import('file:///…/留影/src/ring-vision.mjs').then((m) => m.visionNote({…}).catch(…)).catch(…)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ringRoot } from './adapters/ringmind.mjs'; // 只用它的找库逻辑（零依赖，不会拖进记忆库本体）

import { runPool } from './pool.mjs';
import { extractMedia, stripCq } from './cq.mjs';
import { describeImage } from './describe.mjs';
import { extractFrames, ffmpegAvailable } from './video.mjs';
import { extractAudio, transcribeAudio } from './audio.mjs';
import { openEyeStore } from './store.mjs';
import * as ringmind from './adapters/ringmind.mjs';
import * as mcpring from './adapters/mcp-ring.mjs';
import * as sqlite from './adapters/sqlite.mjs';
import * as jsonl from './adapters/jsonl.mjs';
import * as markdown from './adapters/markdown.mjs';
import * as webhook from './adapters/webhook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // 项目根（src 的上一级）
const POINTER_FILE = join(ROOT, 'data-dir.json'); // 存储位置指针（面板里改写，桥接侧同读）
function readPointerDataDir() {
  try {
    // RING_VISION_POINTER：测试隔离用（默认读项目根指针，不受机器上真实指针干扰）
    const j = JSON.parse(readFileSync(process.env.RING_VISION_POINTER || POINTER_FILE, 'utf8'));
    return typeof j.dataDir === 'string' && j.dataDir.trim() ? j.dataDir.trim() : null;
  } catch {
    return null;
  }
}

const ADAPTERS = { ringmind, sqlite, jsonl, markdown, webhook, 'mcp-ring': mcpring };
const customCache = new Map(); // file → 模块

const urlHash = (url) => createHash('sha256').update(String(url)).digest('hex').slice(0, 24);

/** 生效的模型通道列表:channels 优先,退回单模型字段;最多 4 条(并发上限) */
function buildChannels(cfg) {
  const list = (Array.isArray(cfg.channels) ? cfg.channels : [])
    .filter((c) => c && c.baseUrl && c.model)
    .map((c) => ({ baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey || '' }))
    .slice(0, 4);
  if (list.length) return list;
  if (cfg.baseUrl && cfg.model) return [{ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey || '' }];
  return [];
}

const dayStartOf = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 解析一个输出适配器：内置表 or 自定义脚本（cfg.file，须导出 deliver） */
async function resolveAdapter(o) {
  if (ADAPTERS[o.type]) return ADAPTERS[o.type];
  if (o.type === 'custom' && o.file) {
    if (!customCache.has(o.file)) customCache.set(o.file, await import(pathToFileURL(o.file).href));
    const mod = customCache.get(o.file);
    if (typeof mod.deliver !== 'function') throw new Error(`自定义适配器缺 deliver()：${o.file}`);
    return { deliver: mod.deliver };
  }
  return null;
}

/** 拉图：限时、限大小、只收图片 */
export async function fetchImage(url, { maxBytes, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`图片下载 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`);
    const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mime.startsWith('image/')) throw new Error(`不是图片（${mime}）`);
    return { base64: buf.toString('base64'), mime };
  } finally {
    clearTimeout(timer);
  }
}

const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|flv|ts)(\?|$)/i;
export const isVideoUrl = (url) => VIDEO_EXT.test(String(url));
const isGifUrl = (url) => /\.gif(\?|$)/i.test(String(url));

/** 默认配置：outputs 为空时只描述不落盘（面板的「试看」不依赖输出） */
export function defaultVisionConfig() {
  return {
    enabled: false,                                    // 面板开关（与 key 解耦：免密接口不用填）
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    apiKey: '',                                        // 选填：空 = 不带鉴权头（免密/本地接口）
    dailyCap: 40,                                      // 一天最多看多少个媒体，防着刷屏刷爆
    perMessage: 1,                                     // 一条消息最多看几个媒体
    maxBytes: 8 * 1024 * 1024,                         // 图太大不看（8MB）
    timeoutMs: 45000,
    outputs: [],                                       // 输出适配器列表（见 docs）
    video: {                                           // 视频设置（全部用户可配）
      enabled: true,                                   // 视频开关（关 = 只看图）
      frames: 3,                                       // 抽几帧
      mode: 'scene',                               // interval=按间隔秒 | even=按时长均匀 | scene=按镜头切换(刷视频推荐)
      intervalSec: 5,                                  // interval 模式的间隔秒
      maxBytes: 20 * 1024 * 1024,                      // 视频太大不看（20MB，刷视频足够）
      ffmpegPath: 'bin/ffmpeg.exe',                    // 插件自带（项目根 bin\，相对路径按项目根解析）；也可填完整路径或 'ffmpeg'（PATH）
    },
    asr: {                                             // 声音转文字（可选；视频里有人说话才值得开）
      enabled: false,                                  // 没配语音服务就是关
      baseUrl: 'https://api.siliconflow.cn/v1',        // OpenAI 兼容 /audio/transcriptions（Groq 免费档 / 本地 whisper server）
      model: 'whisper-large-v3',
      apiKey: '',                                      // 选填（免密服务留空）
      maxSeconds: 120,                                 // 最长转写多少秒（控制量）
      language: 'zh',                                  // 选填，如 zh；留空自动检测
    },
    retain: {                                          // 留档：看过的媒体+分析留在 dataDir/media/（best-effort，0 = 不留）
      images: 50,                                      // 最近 N 张图片（原图 + 同名 .json 分析）
      videoFrames: 10,                                 // 最近 N 段视频（抽帧 + analysis.json）
    },
  };
}

/**
 * 乱码防御：历史编码事故（GBK 写入 → 面板"读取→保存"循环固化）会把中文路径
 * 变成一串 U+FFFD 替换符永久留在 vision.json 里 —— ringmind 会照着坏路径开库，
 * 静默把记忆写进一个乱码名字的文件。这里在读取层兜底：
 *   ringmind 的库路径/库名坏了 → 用环形的心 data-location.json（唯一事实源）修回来；
 *   其它字段还有乱码 → 不猜，数出来交给调用方展示（面板 configIssue / 管线日志）。
 * @returns {boolean} 是否修过东西
 */
export function repairMojibake(cfg) {
  if (!JSON.stringify(cfg).includes('\uFFFD')) return false; // 快路径：全干净
  let repaired = false;
  for (const o of Array.isArray(cfg.outputs) ? cfg.outputs : []) {
    if (o?.type === 'ringmind' && (String(o.dbPath ?? '').includes('\uFFFD') || String(o.name ?? '').includes('\uFFFD'))) {
      try {
        const root = ringRoot();
        const loc = root && JSON.parse(readFileSync(join(root, 'data-location.json'), 'utf8'));
        if (loc?.dbPath) {
          o.dbPath = String(loc.dbPath).replace(/\\/g, '/');
          o.name = o.dbPath.split('/').pop().replace(/\.db$/i, '') || '记忆库';
          repaired = true;
        }
      } catch { /* 修不了就留着 —— 调用方会把它亮出来 */ }
    }
  }
  if (repaired) console.error('[留影] 检测到配置里 ringmind 库路径乱码，已按 data-location.json 自动修复');
  return repaired;
}

/**
 * ffmpeg 路径规范化（spawn 前必须过这一道 —— spawn 里的相对路径按进程 cwd 解析，不可靠）：
 *   '' / 'ffmpeg'          → 交给 PATH
 *   相对路径               → 相对**项目根**解析成绝对路径（插件自带的 bin/ffmpeg.exe 搬家不失灵）
 *   绝对路径               → 原样
 * 默认值 bin/ffmpeg.exe 而 bin 里没有（新克隆没拷二进制）→ 退回 PATH 的 ffmpeg；
 * 用户手填的相对路径解析后不存在就照实返回 —— 探测卡会如实报告"没装"。
 */
export function resolveFfmpegPath(p, root = ROOT) {
  const v = String(p ?? '').trim();
  if (!v || v.toLowerCase() === 'ffmpeg') return 'ffmpeg';
  if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\')) return v; // 已是绝对路径（C:/ 或 UNC）
  const abs = join(root, ...v.replace(/\\/g, '/').split('/'));
  if (!existsSync(abs) && v.replace(/\\/g, '/') === 'bin/ffmpeg.exe') return 'ffmpeg';
  return abs;
}

/* ───────────────────────── 留档（media/） ─────────────────────────
 * 看过的媒体和分析留在 dataDir/media/，超额删最旧：
 *   media/images/<时间戳>-<hash>.<ext> + 同名 .json   ← 图片/动图原图 + 分析
 *   media/videos/<时间戳>-<hash>/帧NN.jpg + analysis.json ← 视频抽帧 + 分析
 * best-effort：留档挂了只写日志，绝不影响看图/扇出主流程。
 * eye.db 永远记全量账（~1KB/条），这里滚动的只是"能翻回去看的原件"。 */

let archiveSeq = 0; // 同秒内多份留档也要严格保序（并行处理时时间戳会撞）

function extOfMime(m) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[String(m || '')] || 'bin';
}

function archiveName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${String(++archiveSeq).padStart(4, '0')}`;
}

/** 按名字（= 时间序）裁掉最旧，媒体和它的分析一起删；视频目录是整包递归删 */
function trimArchive(dir, keep) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  const media = names.filter((f) => !f.endsWith('.json')).sort();
  for (const f of media.slice(0, Math.max(0, media.length - keep))) {
    try { rmSync(join(dir, f), { recursive: true, force: true }); } catch { /* 占用中就算了，下轮再删 */ }
    try { rmSync(join(dir, f + '.json'), { force: true }); } catch {}
  }
}

/**
 * 存一份留档。@param kind 'video' → 抽帧包；其它（image/gif）→ 原图 + 分析。
 * @param p { kind, hash, mime?, base64?, frameImages?, info {desc,points,url,chatKey,sender,at,model,ms,frameCount?} }
 */
function archiveMedia(cfg, p) {
  try {
    const r = cfg.retain ?? {};
    const mediaRoot = join(cfg.dataDir, 'media');
    const info = JSON.stringify({ ...p.info, hash: p.hash }, null, 2);
    if (p.kind === 'video') {
      const keep = Math.floor(Number(r.videoFrames ?? 10));
      if (!Number.isFinite(keep) || keep <= 0) return; // 0 = 不留
      const dir = join(mediaRoot, 'videos', archiveName() + '-' + String(p.hash).slice(0, 8));
      mkdirSync(dir, { recursive: true });
      (p.frameImages ?? []).forEach((f, i) => writeFileSync(join(dir, `帧${String(i + 1).padStart(2, '0')}.jpg`), Buffer.from(f.base64, 'base64')));
      writeFileSync(join(dir, 'analysis.json'), info, 'utf8');
      trimArchive(join(mediaRoot, 'videos'), keep);
    } else {
      const keep = Math.floor(Number(r.images ?? 50));
      if (!Number.isFinite(keep) || keep <= 0) return;
      const dir = join(mediaRoot, 'images');
      mkdirSync(dir, { recursive: true });
      const name = `${archiveName()}-${String(p.hash).slice(0, 8)}.${extOfMime(p.mime)}`;
      writeFileSync(join(dir, name), Buffer.from(p.base64 ?? '', 'base64'));
      writeFileSync(join(dir, `${name}.json`), info, 'utf8');
      trimArchive(dir, keep);
    }
  } catch (e) {
    console.error(`[留影] 留档失败（不影响主流程）：${e?.message ?? e}`);
  }
}

/**
 * 读配置：vision.json → 环境变量覆盖。
 * 文件位置：dataDir → 环境变量 RING_VISION_DATA → 项目根 data/。
 */
export function loadVisionConfig({ dataDir } = {}) {
  const cfg = defaultVisionConfig();
  const dir = dataDir || process.env.RING_VISION_DATA || readPointerDataDir() || join(ROOT, 'data'); // 指针优先于默认 // 和面板默认一致：项目根 data/
  const file = join(dir, 'vision.json');
  let fileCfg = null;
  try {
    if (existsSync(file)) {
      let raw = readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 记事本/PowerShell 可能写进 BOM，直接吃掉
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileCfg = parsed;
    }
  } catch (e) {
    // 配置坏了不当灾难：按默认走，但要让日志看得见是「配置坏了」而不是「没开」
    console.error('[留影] vision.json 读取失败，按默认配置走：', e?.message ?? e);
  }
  Object.assign(cfg, fileCfg ?? {});
  repairMojibake(cfg); // 乱码路径自动修（只修 ringmind 库路径，不猜其它字段）
  cfg.apiKey = process.env.RING_VISION_KEY || cfg.apiKey || '';
  if (process.env.RING_VISION_MODEL) cfg.model = process.env.RING_VISION_MODEL;
  if (process.env.RING_VISION_BASE_URL) cfg.baseUrl = process.env.RING_VISION_BASE_URL;
  cfg.enabled = cfg.enabled !== false;
  // video / asr / retain 深合并：文件里只写一部分也不丢默认值
  cfg.video = { ...defaultVisionConfig().video, ...(fileCfg?.video ?? {}) };
  cfg.video.ffmpegPath = resolveFfmpegPath(cfg.video.ffmpegPath); // 相对路径按项目根解析，spawn 才不会走错 cwd
  cfg.asr = { ...defaultVisionConfig().asr, ...(fileCfg?.asr ?? {}) };
  cfg.retain = { ...defaultVisionConfig().retain, ...(fileCfg?.retain ?? {}) };
  cfg.dataDir = dir;
  return cfg;
}

/** 看一段视频/动图：抽帧 → 逐帧描述 → 合并成一条（调用方保证 ffmpeg 可用）
 *  audio=true 时再抽音轨转文字（视频；动图没声音不抽） */
export async function describeVideo(videoBuffer, { cfg, channel, fetchImpl, text, label = '视频', frames, mode, intervalSec, audio = false, spawnImpl } = {}) {
  const v = cfg.video ?? {};
  const ex = await extractFrames({
    buffer: videoBuffer, ffmpegPath: v.ffmpegPath || 'ffmpeg',
    frames: frames ?? v.frames, mode: mode ?? v.mode, intervalSec: intervalSec ?? v.intervalSec,
    tmpDir: join(cfg.dataDir, 'tmp'), timeoutMs: Math.max(cfg.timeoutMs, 120000), spawnImpl,
  });
  // 理解连续性:一个视频的所有帧都走同一个通道(同一个模型),前后描述口径一致;
  // 多模型加速发生在视频层面 —— 多条视频排队时,由通道池分给不同模型并行。
  const descs = [];
  const pts = [];
  let ms = 0;
  let usageTokens = 0;
  for (const f of ex.frames) {
    const out = await describeImage({
      baseUrl: channel.baseUrl,
      model: channel.model,
      apiKey: channel.apiKey,
      imageBase64: f.base64,
      mime: f.mime,
      hint: `这是一段${label}的第 ${f.frame} 帧。` + stripCq(text).slice(0, 100),
      fetchImpl,
      timeoutMs: cfg.timeoutMs,
    });
    ms += out.ms || 0;
    if (out.usage?.total_tokens) usageTokens = (usageTokens ?? 0) + out.usage.total_tokens;
    if (out.desc) descs.push(out.desc);
    for (const p of out.points) if (!pts.includes(p)) pts.push(p);
  }
  if (!descs.length) throw new Error('各帧都没看出内容');
  const dur = ex.durationSec ? `/${ex.durationSec}秒` : '';
  // 声音转文字（可选）：失败只记日志，画面描述照常返回
  let audioPart = '';
  if (audio && cfg.asr?.enabled && cfg.asr.baseUrl) {
    try {
      const t0 = Date.now();
      const audio = await extractAudio({
        buffer: videoBuffer, ffmpegPath: v.ffmpegPath || 'ffmpeg',
        maxSeconds: cfg.asr.maxSeconds || 120,
        tmpDir: join(cfg.dataDir, 'tmp'), spawnImpl,
      });
      if (audio) {
        const tr = await transcribeAudio({
          audioBuffer: audio.buffer,
          baseUrl: cfg.asr.baseUrl, model: cfg.asr.model, apiKey: cfg.asr.apiKey,
          language: cfg.asr.language, fetchImpl, timeoutMs: 90000,
        });
        ms += Date.now() - t0;
        if (tr.usage?.total_tokens) usageTokens = (usageTokens ?? 0) + tr.usage.total_tokens;
        if (tr.text) audioPart = `\n声音：「${tr.text}」`;
      }
    } catch (e) {
      console.error(`[留影] ✗ 声音转文字失败（画面描述照常）：${e?.message ?? e}`);
    }
  }
  return {
    desc: `${label}（${ex.frames.length} 帧${dur}）：` + descs.join('；').slice(0, 200) + audioPart,
    points: pts.slice(0, 6),
    ms,
    frames: ex.frames.length,
    usage: usageTokens || null,
    frameImages: ex.frames, // base64 帧图原样带出（留档用，不额外占内存——本来就是刚抽出来的）
  };
}

/**
 * 主入口：一条消息进来，看有没有媒体（图/视频），有就看、看完扇出给所有输出。
 * 永不抛错（bridge 那边 fire-and-forget），结果用返回值带回来。
 *
 * @param {object} input  { images?, videos?, key, sender, text, at? }
 * @param {object} [opts] { fetchImpl?, cfg?, dataDir?, store? } —— 测试注入用
 */
export async function visionNote(input, opts = {}) {
  const { key = '', sender = 'user', text = '', at = Date.now() } = input ?? {};
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ffmpegProbe = opts.ffmpegProbe ?? ffmpegAvailable; // 测试可注入
  try {
    const cfg = opts.cfg ?? loadVisionConfig({ dataDir: opts.dataDir });
    // 显式 dataDir 优先于 cfg 里的（测试隔离；也防留档/tmp 落错地方）——都没有才退项目根 data/
    cfg.dataDir = opts.dataDir || cfg.dataDir || join(ROOT, 'data');
    if (!cfg.enabled) return { ok: true, skipped: 'disabled' };

    const outputs = (cfg.outputs ?? []).filter((o) => o && o.enabled !== false && (ADAPTERS[o.type] || (o.type === 'custom' && o.file)));
    if (!outputs.length) return { ok: true, skipped: 'no-outputs' };

    // 媒体来源通用化：调用方可以直接给 images/videos 数组（任何平台）；
    // 没给就从 text 里抽（OneBot/CQ 风格是一种常见约定，不是硬性要求）
    const explicit = (input.images?.length || input.videos?.length)
      ? { images: input.images ?? [], videos: input.videos ?? [] }
      : extractMedia(text);
    const media = [
      ...explicit.images.map((u) => ({ url: String(u), kind: 'image' })),
      ...explicit.videos.map((u) => ({ url: String(u), kind: 'video' })),
    ].slice(0, Math.max(1, cfg.perMessage));
    if (!media.length) return { ok: true, skipped: 'no-media' };

    const store = opts.store ?? openEyeStore(cfg.dataDir);

    const dayStart = dayStartOf(at);
    const seenToday = store.seenToday(dayStart);
    if (seenToday >= cfg.dailyCap) {
      console.error(`[留影] 今天已看 ${seenToday} 个媒体，到日限了，剩下的跳过`);
      return { ok: true, skipped: 'daily-cap' };
    }

    const channels = buildChannels(cfg);
    if (!channels.length) return { ok: true, skipped: 'no-model' };

    const results = new Array(media.length);

    // 通道池:每个免费模型一条通道,媒体在通道间并行分发 —— N 条通道 ≈ N 倍速
    await runPool(media, Math.min(channels.length, 4), async (m, wi, idx) => {
      const url = m.url;
      let kind = m.kind;
      const ch = channels[wi % channels.length];
      const hash = urlHash(kind + '|' + url);
      if (store.hasSeen(hash)) { results[idx] = { url, kind, skipped: 'seen' }; return; }

      let desc, points, ms, frames, tokens = 0, archiveSrc = null; // archiveSrc：要留档的东西（原图/帧图），成功路径统一交 archiveMedia

      if (kind === 'video') {
        // 视频：多步且容易失败 → 单条容错，一个视频坏了不拖累其它媒体
        const v = cfg.video ?? {};
        if (v.enabled === false) { results[idx] = { url, kind, skipped: 'video-disabled' }; return; }
        if (!(await ffmpegProbe(v.ffmpegPath || 'ffmpeg'))) {
          results[idx] = { url, kind, skipped: 'no-ffmpeg' };
          return;
        }
        try {
          // 先下载到本地（视频可能很大，单独限量）
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), v.timeoutMs || 120000);
          let buf;
          try {
            const res = await fetchImpl(url, { signal: ctrl.signal });
            if (!res.ok) throw new Error(`视频下载 ${res.status}`);
            buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > (v.maxBytes || 64 * 1024 * 1024)) throw new Error(`视频太大（${Math.round(buf.length / 1048576)}MB）`);
          } finally {
            clearTimeout(timer);
          }
          const out = await describeVideo(buf, { cfg, channel: ch, fetchImpl, text, audio: true, spawnImpl: opts.spawnImpl });
          desc = out.desc; points = out.points; ms = out.ms; frames = out.frames; tokens = out.usage ?? 0;
          archiveSrc = { frameImages: out.frameImages };
        } catch (e) {
          console.error(`[留影] ✗ 视频没看成：${e?.message ?? e}`);
          results[idx] = { url, kind, error: String(e?.message ?? e) };
          return;
        }
      } else {
        // 图片 / 动图
        const img = await fetchImage(url, { maxBytes: cfg.maxBytes, timeoutMs: cfg.timeoutMs, fetchImpl });

        // GIF 动图：视觉模型一般不认 gif，抽 2~3 帧当图看；没 ffmpeg → 跳过（多帧容错，不拖累其它媒体）
        if (isGifUrl(url) || img.mime === 'image/gif') {
          const v = cfg.video ?? {};
          if (!(await ffmpegProbe(v.ffmpegPath || 'ffmpeg'))) {
            console.error('[留影] ✗ 动图没看成：没检测到 ffmpeg');
            results[idx] = { url, kind: 'gif', skipped: 'no-ffmpeg' };
            return;
          }
          try {
            const out = await describeVideo(Buffer.from(img.base64, 'base64'), {
              cfg, channel: ch, fetchImpl, text, label: '动图', // 曾误传 channels 数组 → baseUrl undefined，真实动图必挂
              frames: Math.min(3, v.frames || 3), mode: 'even', intervalSec: 1,
              spawnImpl: opts.spawnImpl,
            });
            desc = out.desc; points = out.points; ms = out.ms; frames = out.frames; tokens = out.usage ?? 0;
            kind = 'gif';
            archiveSrc = { mime: img.mime, base64: img.base64 }; // 动图按"图"留档：存原图，帧随时可再抽
          } catch (e) {
            console.error(`[留影] ✗ 动图没看成：${e?.message ?? e}`);
            results[idx] = { url, kind: 'gif', error: String(e?.message ?? e) };
            return;
          }
        } else {
          const out = await describeImage({
            baseUrl: ch.baseUrl,
            model: ch.model,
            apiKey: ch.apiKey,
            imageBase64: img.base64,
            mime: img.mime,
            hint: stripCq(text).slice(0, 120),
            fetchImpl,
            timeoutMs: cfg.timeoutMs,
          });
          desc = out.desc; points = out.points; ms = out.ms; tokens = out.usage?.total_tokens ?? 0;
          archiveSrc = { mime: img.mime, base64: img.base64 };
        }
      }

      // 扇出：每个输出适配器各投一份，谁挂了只记谁的错
      const item = { desc, points, url, kind, frames, key, sender, at };
      const outputsResult = [];
      for (const o of outputs) {
        try {
          const ad = await resolveAdapter(o);
          if (!ad) { outputsResult.push({ type: o.type, ok: false, error: '未知适配器' }); continue; }
          outputsResult.push({ type: o.type, ...(await ad.deliver(item, o, { fetchImpl })) });
        } catch (e) {
          outputsResult.push({ type: o.type, ok: false, error: String(e?.message ?? e) });
        }
      }

      store.record({ hash, url, chatKey: key, model: ch.model, desc, outputs: outputsResult, createdAt: at, ms, kind, tokens });

      // 留档：图=原图+分析，视频=抽帧+分析（best-effort，挂了不影响任何主流程）
      if (archiveSrc) {
        const asrOn = cfg.asr?.enabled && cfg.asr?.baseUrl;
        archiveMedia(cfg, {
          kind, hash, ...archiveSrc,
          info: {
            desc, points, url, chatKey: key, sender, at, model: ch.model, ms,
            ...(kind === 'video' ? { frameCount: frames, ...(asrOn ? { asrModel: cfg.asr.model } : {}) } : {}),
          },
        });
      }

      results[idx] = { url, kind, desc, points, ms, model: ch.model, ...(kind === 'video' || kind === 'gif' ? { frames } : {}), outputs: outputsResult };
      const what = kind === 'video' ? `看了一段视频（${frames} 帧）` : kind === 'gif' ? `看了一张动图（${frames} 帧）` : '看了一张图';
      console.error(`[留影] ✓ ${what}：${desc.slice(0, 40)}（${ch.model} → ${outputsResult.map((x) => x.type).join('/')}）`);
    });

    const remembered = results.filter((r) => r && r.desc).length;
    return { ok: true, remembered, results };
  } catch (e) {
    // 永不影响消息主流程；错误留日志，媒体没看成就没看成
    console.error(`[留影] ✗ ${e?.message ?? e}`);
    return { ok: false, error: String(e?.message ?? e) };
  }
}
