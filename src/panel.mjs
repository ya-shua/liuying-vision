/**
 * 留影 · 面板启动器
 *
 * 纯启动入口，没有任何逻辑（逻辑在 panel-server.mjs，测试也 import 那边）。
 * 启动：node src/panel.mjs [--dataDir 目录] [--port 5188]
 * 只绑 127.0.0.1 —— 本机工具，不对外。
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelServer } from './panel-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // 项目根（src 的上一级）

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

const dataDir = arg('--dataDir', process.env.RING_VISION_DATA || join(ROOT, 'data'));
const port = Number(arg('--port', process.env.RING_VISION_PORT || 5188));

const s = await createPanelServer({ dataDir, port });
console.log('');
console.log('  留影 · 视觉接入面板');
console.log('  ─────────────────────────────');
console.log(`  地址:  ${s.url}`);
console.log(`  数据:  ${dataDir}`);
console.log('  只监听本机。Ctrl+C 停。');
console.log('');
