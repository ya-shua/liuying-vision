/**
 * 留影 · 面板服务（被 src/panel.mjs 启动，测试直接 import 这里）
 *
 * 只监听本机的小服务：
 *   GET  /            面板页
 *   GET  /api/status  状态 + 用量（打码 key）
 *   GET  /api/seen    最近看过的图（eye.db）
 *   POST /api/test    试看一张图（只描述，不进任何输出、不占日限）
 *   GET/POST /api/config  读/存 vision.json（key 打码；留空 = 不改）
 */

import http from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openEyeStore, closeEyeStore } from './store.mjs';
import { fetchImage, describeVideo, isVideoUrl, repairMojibake, resolveFfmpegPath } from './ring-vision.mjs';
import { describeImage } from './describe.mjs';
import { ffmpegAvailable } from './video.mjs';
import { MODELS, ASR_MODELS } from './models.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PANEL_HTML = join(HERE, 'panel.html');
const POINTER_FILE = join(ROOT, 'data-dir.json');

/** 读数据目录指针;没有/坏了 → null(用默认) */
function readPointerDataDir() {
  try {
    const j = JSON.parse(readFileSync(POINTER_FILE, 'utf8'));
    return typeof j.dataDir === 'string' && j.dataDir.trim() ? j.dataDir.trim() : null;
  } catch {
    return null;
  }
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

/** 上一次读配置遇到的问题（坏 JSON / 编码），/api/status 会带出去 */
let configIssue = null;

/** 读配置文件（key 打码交给调用方；文件坏了会备份并记下原因，不静默吞掉） */
function readConfigFile(configPath) {
  const cfg = {
    enabled: false,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    apiKey: '',
    dailyCap: 40,
    perMessage: 2,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 45000,
    outputs: [],
    channels: [],
    asr: {
      enabled: false,
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3',
      apiKey: '',
      maxSeconds: 120,
      language: '',
    },
    video: {
      enabled: true,
      frames: 3,
      mode: 'even',
      intervalSec: 5,
      maxBytes: 64 * 1024 * 1024,
      ffmpegPath: 'bin/ffmpeg.exe',
    },
    retain: {
      images: 50,       // 最近 N 张图（原图 + 分析），0 = 不留
      videoFrames: 10,  // 最近 N 段视频（抽帧 + 分析），0 = 不留
    },
  };
  configIssue = null;
  try {
    if (existsSync(configPath)) {
      let raw = readFileSync(configPath, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 记事本/PowerShell 可能写进 BOM，直接吃掉
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(cfg, parsed);
        // 乱码防御：ringmind 库路径被历史编码事故固化成 U+FFFD → 自动修回来，
        // 面板横幅说一声（不修的话 ringmind 会照坏路径开库，记忆悄悄写错地方）
        if (repairMojibake(cfg)) {
          try { saveConfigFile(configPath, cfg); } catch { /* 修好的值先在内存里生效，写不回去下次再修 */ }
          configIssue = { error: '配置里的 ringmind 库路径有乱码，已按环形的心 data-location.json 自动修复 —— 建议到输出去向页核对后重新保存一次', mojibake: true };
        }
      }
    }
  } catch (e) {
    // 不能静默变默认 —— 备份坏文件、把原因带回面板，否则用户只会看到"配置全没了"
    let backup = null;
    try {
      backup = configPath + '.bad-' + Date.now();
      writeFileSync(backup, readFileSync(configPath));
    } catch {}
    configIssue = { error: e.message, backup };
  }
  // ffmpeg 路径规范化：相对路径按项目根解析成绝对路径（spawn 里的相对路径按 cwd 解析，不可靠）
  cfg.video.ffmpegPath = resolveFfmpegPath(cfg.video.ffmpegPath);
  return cfg;
}

export function saveConfigFile(configPath, cfg) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 从环形的心自己的记录里找当前库（data-location.json 是它的「库在哪」的唯一事实源） */
function discoverRingLibrary() {
  const candidates = [
    process.env.RING_ROOT,
    join(ROOT, '..', '环形的心'), // 常见装法：桌面/插件/{留影,环形的心} 并排
    process.env.USERPROFILE && join(process.env.USERPROFILE, '环形的心'),
  ].filter(Boolean).map((x) => String(x).replace(/\\/g, '/').replace(/\/+$/, ''));
  const root = candidates.find((x) => existsSync(x + '/src/index.js'));
  if (!root) return { ok: false, error: '找不到环形的心项目（设 RING_ROOT 指过去）' };
  let dbPath = null;
  let name = null;
  try {
    const loc = JSON.parse(readFileSync(join(root, 'data-location.json'), 'utf8'));
    dbPath = loc.dbPath || null;
    const libsFile = join(root, 'libraries.json');
    if (dbPath && existsSync(libsFile)) {
      const libs = JSON.parse(readFileSync(libsFile, 'utf8'));
      const hit = (libs.libs ?? []).find((l) => l.db === dbPath || l.dir === loc.dataDir);
      if (hit?.name) name = hit.name;
    }
  } catch (e) {
    return { ok: false, error: '读环形的心记录失败：' + String(e?.message ?? e) };
  }
  if (!dbPath) return { ok: false, error: '环形的心记录里没有 dbPath' };
  if (!name) name = String(dbPath).split('/').pop().replace(/\.db$/i, '');
  return { ok: true, dbPath, name };
}

function masked(cfg) {
  const out = {
    ...cfg,
    apiKey: undefined,
    apiKeySet: !!cfg.apiKey,
    apiKeyTail: cfg.apiKey ? cfg.apiKey.slice(-4) : '',
  };
  if (Array.isArray(out.channels)) {
    out.channels = out.channels.map((c) => ({
      ...c,
      apiKey: undefined,
      apiKeySet: !!c.apiKey,
      apiKeyTail: c.apiKey ? c.apiKey.slice(-4) : '',
    }));
  }
  if (out.asr) {
    // 嵌套的语音 key 同样打码 —— 完整 key 绝不能回传浏览器
    out.asr = {
      ...out.asr,
      apiKey: undefined,
      apiKeySet: !!out.asr.apiKey,
      apiKeyTail: out.asr.apiKey ? out.asr.apiKey.slice(-4) : '',
    };
  }
  return out;
}

/**
 * 起面板服务。dataDir 是 vision.json + eye.db 的家；目录不存在会自动建。
 */
export async function createPanelServer({
  dataDir,
  pointerPath = POINTER_FILE,
  port = 5188,
  host = '127.0.0.1',
  visionFetchImpl = fetch, // 测试注入假 fetch；生产默认真 fetch（不注入就是 undefined，试看必炸）
  onShutdown,      // 测试注入；不传就真的退出进程
} = {}) {
  // 解析顺序:调用方显式 > 环境变量 > 指针文件(面板里改过存储位置) > 项目根 data/
  dataDir = dataDir || process.env.RING_VISION_DATA || readPointerDataDir() || join(ROOT, 'data');
  let configPath = join(dataDir, 'vision.json');
  let store = openEyeStore(dataDir);
  let storeDir = dataDir; // 迁移存储位置后会换目录，close 时要关当前那份

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    // 隐私/安全：所有 POST 只认本机面板自己发起 —— 别的网页不能改你的配置、建文件夹、停服务
    if (req.method === 'POST') {
      const origin = String(req.headers.origin || '');
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        return json(res, 403, { ok: false, error: '只允许从本机面板发起' });
      }
    }

    try {
      if (req.method === 'GET' && p === '/') {
        // no-store：改了面板必须刷新就生效，别让浏览器拿旧页面让人以为"改了没用"
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(PANEL_HTML));
      }

      if (p === '/api/shutdown' && req.method === 'POST') {
        // 只认本机面板自己发起的请求：别的网页不能随手把服务关掉
        const origin = String(req.headers.origin || '');
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          return json(res, 403, { ok: false, error: '只允许从本机面板发起' });
        }
        json(res, 200, { ok: true, bye: true });
        setTimeout(() => {
          try { server.close(); } catch {}
          if (typeof onShutdown === 'function') onShutdown();
          else process.exit(0);
        }, 150);
        return;
      }

      if (p === '/api/status' && req.method === 'GET') {
        const cfg = readConfigFile(configPath);
        return json(res, 200, {
          ok: true,
          dataDir,
          configPath,
          usage: {
            seenToday: store.seenToday(new Date().setHours(0, 0, 0, 0)),
            totalSeen: store.total(),
            lastSeenAt: store.lastSeenAt(),
            tokensToday: store.usageToday(new Date().setHours(0, 0, 0, 0)).tokens,
            countToday: store.usageToday(new Date().setHours(0, 0, 0, 0)).n,
            tokensTotal: store.usageTotal().tokens,
          },
          outputs: (cfg.outputs ?? []).map((o) => ({ type: o.type, enabled: o.enabled !== false })),
          ffmpeg: await ffmpegAvailable(cfg.video?.ffmpegPath || 'ffmpeg'),
          configIssue,
          config: masked(cfg),
        });
      }

      if (p === '/api/discover-ring' && req.method === 'GET') {
        return json(res, 200, discoverRingLibrary());
      }

      if (p === '/api/data-dir' && req.method === 'GET') {
        return json(res, 200, { ok: true, dataDir, pointerPath });
      }

      if (p === '/api/data-dir' && req.method === 'POST') {
        const body = await readBody(req);
        const dir = String(body.dir || '').trim().replace(/\\/g, '/');
        const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '');
        if (!/^([a-zA-Z]:)?\//.test(dir)) return json(res, 400, { ok: false, error: '要一个绝对路径（如 D:/留影数据）' });
        if (norm(dir) === norm(dataDir)) return json(res, 400, { ok: false, error: '已经是这个目录了' });
        mkdirSync(dir, { recursive: true });
        if (existsSync(join(dir, 'eye.db'))) return json(res, 400, { ok: false, error: '目标目录已有 eye.db —— 先清空或换目录' });
        // 迁移:vision.json + eye.db 全家（db/wal/shm 一起搬，账本不丢）
        const moved = [];
        for (const f of ['vision.json', 'eye.db', 'eye.db-wal', 'eye.db-shm']) {
          const src = join(dataDir, f);
          if (existsSync(src)) { copyFileSync(src, join(dir, f)); moved.push(f); }
        }
        writeFileSync(pointerPath, JSON.stringify({ dataDir: dir, movedAt: Date.now() }, null, 2) + '\n');
        dataDir = dir;
        configPath = join(dataDir, 'vision.json');
        closeEyeStore(storeDir); // 旧目录的账本连接放掉（openEyeStore 有 cache，不关会一直吊着）
        store = openEyeStore(dataDir);
        storeDir = dataDir;
        return json(res, 200, { ok: true, dataDir: dir, moved });
      }

      if (p === '/api/models' && req.method === 'GET') {
        return json(res, 200, { ok: true, models: MODELS, asr: ASR_MODELS });
      }

      if (p === '/api/seen' && req.method === 'GET') {
        const limit = Math.min(200, Number(u.searchParams.get('limit')) || 50);
        return json(res, 200, { ok: true, rows: store.recent(limit) });
      }

      // 留档列表：media/ 里"能翻回去看的原件"（图=原图+同名 .json 分析；视频=帧包+analysis.json），最新的在前
      if (p === '/api/archive' && req.method === 'GET') {
        const mediaRoot = join(dataDir, 'media');
        const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
        const images = [];
        try {
          for (const f of readdirSync(join(mediaRoot, 'images')).filter((x) => !x.endsWith('.json')).sort().reverse()) {
            const info = readJson(join(mediaRoot, 'images', f + '.json'));
            if (info) images.push({ file: f, ...info });
          }
        } catch { /* 目录还没建 = 还没留过档 */ }
        const videos = [];
        try {
          for (const b of readdirSync(join(mediaRoot, 'videos')).sort().reverse()) {
            const info = readJson(join(mediaRoot, 'videos', b, 'analysis.json'));
            if (!info) continue;
            let frames = 0;
            try { frames = readdirSync(join(mediaRoot, 'videos', b)).filter((x) => !x.endsWith('.json')).length; } catch {}
            videos.push({ bundle: b, frameCount: frames, ...info });
          }
        } catch { /* 同上 */ }
        return json(res, 200, { ok: true, images, videos, root: mediaRoot });
      }

      // 留档媒体文件：只从 media/ 里拿（防目录穿越）；面板只绑本机
      if (p.startsWith('/media/') && req.method === 'GET') {
        const mediaRoot = resolve(join(dataDir, 'media'));
        const rel = decodeURIComponent(p.slice('/media/'.length)).replace(/\\/g, '/');
        const abs = resolve(mediaRoot, rel);
        const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' })[abs.slice(abs.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
        if (!abs.startsWith(mediaRoot + sep) || !existsSync(abs)) return json(res, 404, { ok: false, error: '没这个文件' });
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
        return res.end(readFileSync(abs));
      }

      // 文件夹浏览（给"选择文件夹"弹层用）：列出某目录下的子目录
      if (p === '/api/fs' && req.method === 'GET') {
        let dir = String(u.searchParams.get('dir') || '').trim() || (process.env.USERPROFILE || 'C:\\');
        dir = dir.replace(/\//g, '\\').replace(/\\+$/, '');
        try {
          if (!existsSync(dir)) return json(res, 200, { ok: false, error: '目录不存在', dir });
          const entries = readdirSync(dir, { withFileTypes: true });
          const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, 'zh'));
          const parent = /^[A-Za-z]:\\?$/.test(dir) ? null : dirname(dir);
          return json(res, 200, { ok: true, dir, parent, dirs });
        } catch (e) {
          return json(res, 200, { ok: false, error: String(e?.message ?? e), dir });
        }
      }

      // 新建文件夹（建库文件/迁移目标之前先建目录）
      if (p === '/api/fs' && req.method === 'POST') {
        const body = await readBody(req);
        const dir = String(body.dir ?? '').trim().replace(/\//g, '\\');
        if (!/^[A-Za-z]:[\\/]/.test(dir)) return json(res, 400, { ok: false, error: '要一个绝对路径' });
        try { mkdirSync(dir, { recursive: true }); return json(res, 200, { ok: true, dir }); }
        catch (e) { return json(res, 200, { ok: false, error: String(e?.message ?? e) }); }
      }

      // key 接入验证：轻量请求，验证 key/模型是否可用（不动配置；服务端代理避开浏览器跨域）
      if (p === '/api/verify-key' && req.method === 'POST') {
        const vbody = await readBody(req);
        const vBaseUrl = String(vbody.baseUrl || '').trim().replace(/\/+$/, '');
        const vApiKey = String(vbody.apiKey ?? '');
        const vModel = String(vbody.model || '').trim();
        const vKind = vbody.kind === 'asr' ? 'asr' : 'vision';
        if (!/^https?:\/\//.test(vBaseUrl)) return json(res, 400, { ok: false, error: '要 http(s) 接口地址' });
        const vT0 = Date.now();
        try {
          let vRes;
          if (vKind === 'asr') {
            vRes = await fetch(vBaseUrl + '/models', { headers: vApiKey ? { authorization: 'Bearer ' + vApiKey } : {}, signal: AbortSignal.timeout(15000) });
          } else {
            vRes = await fetch(vBaseUrl + '/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(vApiKey ? { authorization: 'Bearer ' + vApiKey } : {}) },
              body: JSON.stringify({ model: vModel || 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
              signal: AbortSignal.timeout(15000),
            });
          }
          const vMs = Date.now() - vT0;
          const vBody = await vRes.text().catch(() => '');
          let verdict;
          if (vRes.status === 429) verdict = { ok: true, message: 'key 有效（当前触发限流，稍后即可用）' };
          else if (vRes.ok) verdict = { ok: true, message: 'key 有效，接入可用' };
          else if (vRes.status === 401 || vRes.status === 403) verdict = { ok: false, message: 'key 无效或没填 —— 免费也要注册账号拿 key（原始返回：' + vBody.slice(0, 100) + '）' };
          else if (vRes.status === 404) verdict = { ok: false, message: '接口地址或模型名不对（404；baseUrl 结尾不要带 /chat/completions）' };
          else verdict = { ok: false, message: 'HTTP ' + vRes.status + '：' + vBody.slice(0, 120) };
          return json(res, 200, { ok: verdict.ok, message: verdict.message, ms: vMs, httpStatus: vRes.status });
        } catch (e) {
          return json(res, 200, { ok: false, message: '连不上接口 —— 检查网络或地址（' + String(e?.message ?? e).slice(0, 80) + '）' });
        }
      }

      if (p === '/api/test' && req.method === 'POST') {
        const body = await readBody(req);
        const url = String(body.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return json(res, 400, { ok: false, error: '要一个 http(s) 图链' });
        const cfg = readConfigFile(configPath);
        // 视频试看：抽帧 → 逐帧描述 → 合并（同样只描述，不落任何输出）
        if (isVideoUrl(url)) {
          if (!(await ffmpegAvailable(cfg.video?.ffmpegPath || 'ffmpeg'))) {
            return json(res, 400, { ok: false, error: '未检测到 ffmpeg —— 视频试看需要它（ffmpeg.org 下载，或在视频设置里填完整路径）' });
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), Math.max(cfg.timeoutMs, 120000));
          let buf;
          try {
            const res = await visionFetchImpl(url, { signal: ctrl.signal });
            if (!res.ok) throw new Error('视频下载 ' + res.status);
            buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > (cfg.video?.maxBytes || 64 * 1024 * 1024)) throw new Error('视频太大');
          } catch (e) {
            const msg = String(e?.message ?? e);
            throw new Error(/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|abort/i.test(msg) ? '视频下载失败 —— 检查网络，或换个能打开的视频链接' : msg);
          } finally { clearTimeout(timer); }
          const out = await describeVideo(buf, { cfg, fetchImpl: visionFetchImpl, text: '' });
          return json(res, 200, { ok: true, desc: out.desc, points: out.points, model: cfg.model, ms: out.ms, frames: out.frames });
        }
        const img = await fetchImage(url, { maxBytes: cfg.maxBytes, timeoutMs: cfg.timeoutMs, fetchImpl: visionFetchImpl }).catch((e) => {
          const msg = String(e?.message ?? e);
          throw new Error(/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|abort/i.test(msg) ? '图片下载失败 —— 检查网络，或换一张能打开的图链' : msg);
        });
        const out = await describeImage({
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey,
          imageBase64: img.base64,
          mime: img.mime,
          fetchImpl: visionFetchImpl,
          timeoutMs: cfg.timeoutMs,
        });
        // 试看只描述：不进任何输出、不写 seen、不占日限
        return json(res, 200, { ok: true, desc: out.desc, points: out.points, model: out.model });
      }

      if (p === '/api/config' && req.method === 'GET') {
        return json(res, 200, { ok: true, configPath, config: masked(readConfigFile(configPath)) });
      }

      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const cur = readConfigFile(configPath);
        const next = { ...cur };
        for (const k of ['enabled', 'baseUrl', 'model', 'apiKey', 'dailyCap', 'perMessage', 'maxBytes', 'timeoutMs', 'outputs', 'video', 'channels', 'asr', 'retain']) {
          if (k in body) next[k] = body[k];
        }
        // key 打码保护：面板传空/传打码串 = 不改
        if (!next.apiKey || next.apiKey.includes('••')) next.apiKey = cur.apiKey;
        next.dailyCap = Math.max(1, Number(next.dailyCap) || 40);
        next.perMessage = Math.max(1, Number(next.perMessage) || 2);
        next.enabled = next.enabled !== false; // 开关独立：key 选填（免密接口留空也能开），缺 key 时自检卡会黄牌提醒
        next.outputs = Array.isArray(next.outputs) ? next.outputs : [];
        if (next.video && typeof next.video === 'object') {
          const v = next.video;
          const asrInVideo = v.asr && typeof v.asr === 'object' ? v.asr : null;
          next.video = {
            enabled: v.enabled !== false,
            frames: Math.max(1, Math.min(10, Number(v.frames) || 3)),
            mode: ['even', 'interval', 'scene'].includes(v.mode) ? v.mode : 'interval', // scene 曾被这里吞成 interval
            intervalSec: Math.max(1, Number(v.intervalSec) || 5),
            maxBytes: Math.max(1048576, Number(v.maxBytes) || 67108864),
            ffmpegPath: String(v.ffmpegPath || 'bin/ffmpeg.exe'),
          };
          // 面板把声音转文字放在 video.asr 里发 —— 提升到顶层（正式位置），否则会被这里整体重建剥掉，开关永远存不上
          if (asrInVideo) next.asr = asrInVideo;
        } else delete next.video;
        if (next.retain && typeof next.retain === 'object') {
          const rr = next.retain;
          const cap = (x, d) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n >= 0 ? n : d; };
          next.retain = { images: cap(rr.images, 50), videoFrames: cap(rr.videoFrames, 10) };
        } else delete next.retain;
        if (next.asr && typeof next.asr === 'object') {
          const a = next.asr;
          const baseUrl = String(a.baseUrl || '').trim();
          next.asr = {
            enabled: a.enabled === true && !!baseUrl,
            baseUrl,
            model: String(a.model || 'whisper-large-v3').trim() || 'whisper-large-v3',
            apiKey: String(a.apiKey || '').trim() || (cur.asr?.apiKey ?? ''), // 留空 = 保留旧值
            maxSeconds: Math.max(10, Math.min(600, Number(a.maxSeconds) || 120)),
            language: String(a.language || '').trim(),
          };
          if (!next.asr.baseUrl) next.asr.enabled = false;
        } else if ('asr' in next) delete next.asr;
        if (Array.isArray(next.channels)) {
          const oldCh = Array.isArray(cur.channels) ? cur.channels : [];
          next.channels = next.channels
            .map((c) => ({
              baseUrl: String(c.baseUrl || '').trim(),
              model: String(c.model || '').trim(),
              apiKey: String(c.apiKey || '').trim(),
            }))
            .filter((c) => c.baseUrl && c.model)
            .slice(0, 4)
            .map((c) => {
              if (c.apiKey) return c;
              const old = oldCh.find((x) => x.baseUrl === c.baseUrl && x.model === c.model);
              return { ...c, apiKey: old?.apiKey ?? '' }; // key 留空 = 按 地址+模型 保留旧值
            });
          // 单模型字段与第一通道保持同步（旧读取方兼容）
          if (next.channels[0]) {
            next.baseUrl = next.channels[0].baseUrl;
            next.model = next.channels[0].model;
            next.apiKey = next.channels[0].apiKey;
          }
        }
        saveConfigFile(configPath, next);
        return json(res, 200, { ok: true, config: masked(next) });
      }

      return json(res, 404, { ok: false, error: '没这个接口' });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  await new Promise((r) => server.listen(port, host, r));
  const addr = server.address();
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`;

  return {
    server,
    url,
    port: addr.port,
    close: () => new Promise((r) => {
      try { closeEyeStore(storeDir); } catch { /* 关不掉就算了 */ }
      server.close(r);
    }),
  };
}
