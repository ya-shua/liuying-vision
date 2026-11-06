/**
 * 留影 · 声音转文字：把视频的音轨抽出来，交给语音转文字（ASR）服务。
 *
 * 两步：
 *   ① extractAudio —— ffmpeg 把音轨抽成 mp3（-vn 去画面）；视频本来没音轨 → 返回 null（不算错）
 *   ② transcribeAudio —— POST 到 OpenAI 兼容的 /audio/transcriptions
 *      （Groq 免费档 / 硅基流动 / 本地 whisper.cpp server 都是这个格式，接入制）
 *
 * 失败永远不影响画面描述 —— 声音是加分项，不是必需品。
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 抽音轨。视频没有音轨 → 返回 null；其它失败 → 抛错（调用方 catch） */
export async function extractAudio(p) {
  const {
    buffer, ffmpegPath = 'ffmpeg', maxSeconds = 120,
    tmpDir, spawnImpl,
  } = p ?? {};
  if (!buffer) throw new Error('没有视频可抽音轨');
  if (!tmpDir) throw new Error('缺 tmpDir');
  mkdirSync(tmpDir, { recursive: true });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const inFile = join(tmpDir, `a-in-${stamp}.bin`);
  const outFile = join(tmpDir, `a-out-${stamp}.mp3`);
  writeFileSync(inFile, buffer);

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inFile,
    '-vn',                     // 去画面，只要声音
    '-ac', '1', '-ar', '16000', // 单声道 16kHz：ASR 够用，文件最小
    '-t', String(Math.max(10, maxSeconds)),
    '-b:a', '48k',
    outFile,
  ];

  await new Promise((resolve, reject) => {
    try {
      const proc = (spawnImpl || spawn)(ffmpegPath, args);
      let err = '';
      let done = false;
      const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(new Error('抽音轨超时')); }, 120000);
      const finish = (e) => { if (!done) { done = true; clearTimeout(timer); e ? reject(e) : resolve(); } };
      proc.stderr?.on?.('data', (c) => (err += c));
      proc.on('error', (e) => finish(new Error(`ffmpeg 启动失败：${e.message}`)));
      proc.on('close', (c) => finish(c === 0 ? null : new Error(`ffmpeg 退出码 ${c}（视频可能没有音轨）：${String(err).slice(-120)}`)));
    } catch (e) {
      reject(e);
    }
  });

  try {
    if (!existsSync(outFile)) return null; // 没音轨：静默
    const out = readFileSync(outFile);
    if (out.length < 1024) return null; // 太短，基本是静音占位
    return { buffer: out, mime: 'audio/mpeg' };
  } finally {
    try { rmSync(inFile, { force: true }); } catch {}
    try { rmSync(outFile, { force: true }); } catch {}
  }
}

/** 语音转文字：OpenAI 兼容 /audio/transcriptions（multipart 上传） */
export async function transcribeAudio(p) {
  const {
    audioBuffer, baseUrl, model = 'whisper-large-v3', apiKey = '',
    language = '', fetchImpl = fetch, timeoutMs = 90000,
  } = p ?? {};
  if (!audioBuffer) throw new Error('没有音频可转写');
  if (!baseUrl) throw new Error('语音转文字没配 baseUrl');

  const fd = new FormData();
  fd.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', model);
  if (language) fd.append('language', language);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: fd,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const human = res.status === 401 || res.status === 403
      ? `语音转文字 ${res.status} —— key 没填或不对。Groq 免费但要在 console.groq.com 注册账号拿 key（原始返回：${body.slice(0, 100)}）`
      : `语音转文字 ${res.status}：${body.slice(0, 120)}`;
    throw new Error(human);
  }
  const j = await res.json().catch(() => null);
  const text = String(j?.text ?? '').trim();
  if (!text) throw new Error('语音转文字返回空');
  return { text: text.slice(0, 500), model, usage: j?.usage ?? null };
}
