/**
 * 留影 · 自更新
 *
 * 更新检查：GitHub Releases API（仓库公开，匿名可读；api.github.com 国内直连可用）
 * 一键更新：下载最新 release 的 tarball → 解包 → 覆盖插件目录。
 *   故意不用 git pull —— 用户机器未必有 git；github.com 会被 hosts 钉死的死 IP 拦住，
 *   而 api.github.com / codeload.github.com 是通的。
 *   覆盖时跳过运行时资产：data/（配置和账本）、bin/（ffmpeg 二进制）、.git、node-path.txt。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, sep } from 'node:path';

const REPO = 'ya-shua/liuying-vision';
const API = `https://api.github.com/repos/${REPO}`;

/** 当前版本：读插件根的 package.json */
export function currentVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 'v1.8.0' → [1,8,0]；解析不动返回 null */
function parseVer(v) {
  const m = String(v ?? '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a 比 b 新返回 1，旧 -1，相等 0；任一解析不动返回 null（宁可不动也不瞎更） */
export function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  if (!A || !B) return null;
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 检查更新。网络不通/超时一律返回 hasUpdate:false + error，绝不抛——
 * 更新提示是锦上添花，不能连累面板主流程。
 */
export async function checkUpdate(root, fetchImpl = fetch) {
  const current = currentVersion(root);
  try {
    const res = await fetchImpl(`${API}/releases/latest`, {
      headers: { 'user-agent': 'liuying-panel', 'accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { current, latest: null, hasUpdate: false, error: `GitHub 返回 ${res.status}` };
    const rel = await res.json();
    const latest = String(rel.tag_name ?? '').trim();
    const c = cmpVer(latest, current);
    if (c === null) return { current, latest, hasUpdate: false, error: '版本号解析不了' };
    return {
      current,
      latest,
      hasUpdate: c > 0,
      notes: typeof rel.body === 'string' ? rel.body.slice(0, 500) : '',
      publishedAt: rel.published_at ?? null,
    };
  } catch (e) {
    return { current, latest: null, hasUpdate: false, error: e?.name === 'TimeoutError' ? '检查超时' : '网络不通' };
  }
}

/**
 * 一键更新：下载最新 release tarball → tar 解包 → 覆盖插件根（跳过运行时资产）。
 * 只往上盖新版本，current ≥ latest 时拒绝动手。
 */
export async function runUpdate(root, dataDir, fetchImpl = fetch, spawnImpl = spawn) {
  const chk = await checkUpdate(root, fetchImpl);
  if (chk.error && !chk.hasUpdate) return { ok: false, error: `检查更新失败：${chk.error}` };
  if (!chk.hasUpdate) return { ok: false, error: `已经是最新版（${chk.current}）` };
  const tag = chk.latest;

  // ① 下载 tarball（fetch 自动跟 302 到 codeload.github.com）
  let buf;
  try {
    const res = await fetchImpl(`${API}/tarball/${encodeURIComponent(tag)}`, {
      headers: { 'user-agent': 'liuying-panel' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { ok: false, error: `下载失败：GitHub 返回 ${res.status}` };
    buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return { ok: false, error: '下载内容太小，不像 tarball' };
  } catch (e) {
    return { ok: false, error: `下载失败：${e?.name === 'TimeoutError' ? '超时' : e?.message ?? '网络错误'}` };
  }

  // ② 解包到 dataDir/tmp（数据目录可能在插件根外面，放这里不碰代码区）
  const tmp = join(dataDir, 'tmp', 'update');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = join(dataDir, 'tmp', `update-${Date.now()}.tgz`);
  writeFileSync(tgz, buf);
  try {
    // 相对路径 + cwd：GNU tar 会把 'C:\...' 的冒号当远程主机，绝对路径必炸
    const r = await new Promise((resolveP) => {
      const p = spawnImpl('tar', ['-xzf', tgz.split(sep).pop(), '-C', 'update'], {
        shell: false, cwd: join(dataDir, 'tmp'),
      });
      let err = '';
      p.stderr?.on('data', (d) => { err += d; });
      p.on('error', (e) => resolveP({ code: -1, err: e.message }));
      p.on('close', (code) => resolveP({ code, err }));
    });
    if (r.code !== 0) return { ok: false, error: `解包失败（需要系统自带 tar）：${r.err || r.code}` };
  } finally {
    try { rmSync(tgz, { force: true }); } catch {}
  }

  // ③ 定位解包出来的根目录（GitHub tarball 是 <owner>-<repo>-<sha>/ 单层目录）
  const entries = readdirSync(tmp).filter((n) => !n.startsWith('.'));
  const srcRoot = entries.length === 1 ? join(tmp, entries[0]) : tmp;
  if (!existsSync(join(srcRoot, 'package.json')) || !existsSync(join(srcRoot, 'src'))) {
    return { ok: false, error: '解包内容不对（缺 package.json 或 src/），放弃覆盖' };
  }
  const newVer = currentVersion(srcRoot);
  if (cmpVer(newVer, chk.current) === null) return { ok: false, error: '新包版本号解析不了，放弃覆盖' };

  // ④ 覆盖插件根。跳过：运行时数据 / ffmpeg / git / 本机指针 / 日志 / 解包临时区
  const skipTop = new Set(['data', 'bin', '.git', 'node_modules', 'tmp']);
  try {
    cpSync(srcRoot, root, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = src.slice(srcRoot.length);
        if (!rel || rel === sep) return true;
        const top = rel.slice(1).split(sep)[0];
        if (skipTop.has(top)) return false;
        if (top === 'node-path.txt' || top === 'data-dir.json' || top.endsWith('.log')) return false;
        return true;
      },
    });
  } catch (e) {
    return { ok: false, error: `覆盖文件失败：${e?.message ?? e}（正在运行的程序占住文件时会这样，关掉面板再试）` };
  }
  rmSync(tmp, { recursive: true, force: true });

  const done = cmpVer(newVer, chk.current) > 0 ? newVer : chk.current;
  return { ok: true, version: done, needRestart: true };
}
