/**
 * 留影 · 视频支持：把一段视频变成 N 张帧图，交给视觉模型逐帧看。
 *
 * 依赖 ffmpeg / ffprobe（本机装了才工作；没装 → ffmpegAvailable=false，
 * visionNote 会把视频跳过并在面板提示，绝不阻塞消息主流程）。
 *
 * 抽帧两种方式（用户在面板配）：
 *   interval —— 每隔 intervalSec 秒取一帧（不知道时长也能用，默认）
 *   even     —— 按时长均匀分布取 frames 帧（需要 ffprobe 读出时长，读不出自动退回 interval）
 *
 * 帧统一压到宽 ≤720 再送审 —— 省 token，描述够用。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ffmpegProbeCache = new Map(); // path → boolean

/** 探测 ffmpeg 是否可用（结果按路径缓存） */
export async function ffmpegAvailable(ffmpegPath = 'ffmpeg') {
  if (ffmpegProbeCache.has(ffmpegPath)) return ffmpegProbeCache.get(ffmpegPath);
  const ok = await new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-version'], { stdio: 'ignore' });
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      p.on('error', () => finish(false));
      p.on('close', (c) => finish(c === 0));
      setTimeout(() => { try { p.kill(); } catch {} finish(false); }, 5000);
    } catch {
      resolve(false);
    }
  });
  ffmpegProbeCache.set(ffmpegPath, ok);
  return ok;
}

/** 由 ffmpegPath 推 ffprobe 路径（同目录同名） */
function ffprobePathOf(ffmpegPath) {
  return String(ffmpegPath).replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

/** 纯函数：算抽帧滤镜参数（测试直接测这个） */
export function buildFrameArgs({ mode = 'interval', frames = 3, intervalSec = 5, durationSec = 0, sceneThreshold = 0.3 }) {
  const n = Math.max(1, Math.min(10, frames));
  if (mode === 'scene') {
    // 镜头切换检测：画面一变才取帧，最省也最准；切得不够就取到几帧算几帧
    return { mode: 'scene', frames: n, vf: `select='gt(scene,${Number(sceneThreshold) || 0.3})',scale='min(720,iw)':-2` };
  }
  if (mode === 'even' && durationSec > 0) {
    // 均匀分布：整段时长里均匀取 n 帧
    return { mode: 'even', frames: n, vf: `fps=${n}/${durationSec.toFixed(3)},scale='min(720,iw)':-2` };
  }
  const sec = Math.max(1, intervalSec || 5);
  return { mode: 'interval', frames: n, vf: `fps=1/${sec},scale='min(720,iw)':-2` };
}

/** 从 ffmpegPath 推出的 ffprobe 读视频秒数；读不出返回 0 */
export function probeDuration(videoFile, ffmpegPath = 'ffmpeg', timeoutMs = 15000) {
  const probe = ffprobePathOf(ffmpegPath);
  return new Promise((resolve) => {
    try {
      const p = spawn(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoFile]);
      let out = '';
      let done = false;
      const timer = setTimeout(() => { try { p.kill(); } catch {} finish(0); }, timeoutMs);
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      p.stdout.on('data', (c) => (out += c));
      p.on('error', () => finish(0));
      p.on('close', () => {
        const v = parseFloat(String(out).trim());
        finish(Number.isFinite(v) && v > 0 ? v : 0);
      });
    } catch {
      resolve(0);
    }
  });
}

function run(spawnFn, ffmpegPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const p = spawnFn(ffmpegPath, args);
      let err = '';
      let done = false;
      const timer = setTimeout(() => { try { p.kill(); } catch {} finish(new Error('ffmpeg 超时')); }, timeoutMs);
      const finish = (e) => { if (!done) { done = true; clearTimeout(timer); e ? reject(e) : resolve(); } };
      p.stderr.on('data', (c) => (err += c));
      p.on('error', (e) => finish(new Error(`ffmpeg 启动失败：${e.message}`)));
      p.on('close', (c) => finish(c === 0 ? null : new Error(`ffmpeg 退出码 ${c}：${String(err).slice(-200)}`)));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 下载视频（若给 url）并抽帧。
 * @param {object} p { url?, buffer?, ffmpegPath, frames, mode, intervalSec, maxBytes, timeoutMs, tmpDir, fetchImpl, spawnImpl? }
 * @returns {Promise<{ok: boolean, frames: [{base64, mime, frame}]}>}
 */
export async function extractFrames(p) {
  const {
    url, buffer, ffmpegPath = 'ffmpeg', frames = 3, mode = 'interval', intervalSec = 5,
    maxBytes = 64 * 1024 * 1024, timeoutMs = 120000, tmpDir, fetchImpl = fetch, spawnImpl,
  } = p ?? {};
  if (!buffer && !url) throw new Error('没有视频可处理');
  if (!tmpDir) throw new Error('缺 tmpDir');
  mkdirSync(tmpDir, { recursive: true });

  let buf = buffer;
  if (!buf) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`视频下载 ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`视频太大（${Math.round(buf.length / 1048576)}MB）`);
    } finally {
      clearTimeout(timer);
    }
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const inFile = join(tmpDir, `in-${stamp}.bin`);
  const outBase = join(tmpDir, `f-${stamp}`);
  writeFileSync(inFile, buf);

  try {
    // 时长总是探一下（描述里显示"15 秒"用）；ffprobe 缺席就 0
    const durationSec = await probeDuration(inFile, ffmpegPath);
    let m = mode;
    if (m === 'even' && !durationSec) m = 'interval'; // ffprobe 缺席/读不出 → 退回间隔模式
    const { vf, frames: n } = buildFrameArgs({ mode: m, frames, intervalSec, durationSec });
    await run(spawnImpl || spawn, ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile, '-vf', vf, '-frames:v', String(n), '-q:v', '3', `${outBase}%02d.jpg`], timeoutMs);

    const shots = readdirSync(tmpDir)
      .filter((f) => f.startsWith(`f-${stamp}`) && f.endsWith('.jpg'))
      .sort()
      .map((f) => ({
        frame: Number(f.match(/(\d+)\.jpg$/)?.[1] ?? 0),
        base64: readFileSync(join(tmpDir, f)).toString('base64'),
        mime: 'image/jpeg',
      }));
    if (!shots.length) throw new Error('ffmpeg 没吐出任何帧（视频编码不支持？）');
    return { ok: true, frames: shots, durationSec: Math.round(durationSec) };
  } finally {
    try { rmSync(inFile, { force: true }); } catch {}
    try {
      for (const f of readdirSync(tmpDir)) {
        if (f.startsWith(`f-${stamp}`)) rmSync(join(tmpDir, f), { force: true });
      }
    } catch {}
  }
}
