/**
 * 环形的眼 · 面板测试
 *
 * 规矩：只监听本机、key 打码不回传、试看不进任何输出、配置存盘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPanelServer } from "../src/panel-server.mjs";

/** 假视觉服务：试看接口用 */
const fakeVisionFetch = async (url) => {
  if (String(url).includes("/chat/completions")) {
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"desc":"测试图：一只橘猫","points":["橘猫"]}' } }] }),
    };
  }
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: new Map([["content-type", "image/jpeg"]]),
  };
};

async function boot({ withKey = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-panel-"));
  const s = await createPanelServer({ dataDir, port: 0, visionFetchImpl: fakeVisionFetch });
  if (withKey) {
    await fetch(s.url + "/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        apiKey: "sk-test-1234",
        baseUrl: "https://vision.test/v4",
        model: "test-vision",
        outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
      }),
    });
  }
  return { s, dataDir };
}

const j = async (r) => r.json();

test("面板：状态接口报今天的量，key 打码不回传", async () => {
  const { s } = await boot();
  const st = await j(await fetch(s.url + "/api/status"));
  assert.equal(st.ok, true);
  assert.equal(st.config.apiKeySet, true);
  assert.equal(st.config.apiKeyTail, "1234");
  assert.equal(st.config.apiKey, undefined, "完整 key 绝不能回传");
  assert.equal(st.usage.seenToday, 0);
  assert.deepEqual(st.config.outputs.map((o) => o.type), ["jsonl"]);
  await s.close();
});

test("面板：试看只描述，不进任何输出、不写账本", async () => {
  const { s, dataDir } = await boot();
  const r = await j(
    await fetch(s.url + "/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://gchat.qpic.cn/x.jpg" }),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.desc, "测试图：一只橘猫");
  assert.deepEqual(r.points, ["橘猫"]);
  assert.equal(existsSync(join(dataDir, "log.jsonl")), false, "试看不能触发输出");
  assert.equal(existsSync(join(dataDir, "eye.db")), true, "eye.db 会建（账本就绪）");
  assert.equal(existsSync(join(dataDir, "media")), false, "试看不留档");
  await s.close();
});

test("面板：保存配置落盘，key 留空 = 不改，outputs 原样存", async () => {
  const { s, dataDir } = await boot();
  const r = await j(
    await fetch(s.url + "/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, dailyCap: 99, apiKey: "" }),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.config.dailyCap, 99);
  assert.equal(r.config.apiKeySet, true, "key 留空应保留旧的");

  const file = JSON.parse(readFileSync(join(dataDir, "vision.json"), "utf8"));
  assert.equal(file.apiKey, "sk-test-1234", "落盘的 key 不能被清掉");
  assert.equal(file.dailyCap, 99);
  await s.close();
});

test("面板：审计表能列出看过的图（含输出去向）", async () => {
  const { s, dataDir } = await boot();
  const { openEyeStore } = await import("../src/store.mjs");
  openEyeStore(dataDir).record({
    hash: "h1", url: "https://gchat.qpic.cn/a.jpg", chatKey: "group-1",
    model: "glm-4v-flash", desc: "群里的一张猫图", outputs: [{ type: "jsonl", ok: true }], createdAt: Date.now(),
  });
  const r = await j(await fetch(s.url + "/api/seen?limit=10"));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].desc, "群里的一张猫图");
  assert.equal(r.rows[0].outputs[0].type, "jsonl");
  await s.close();
});

test("面板：没配 key 也能试看（免密接口，key 是选填的）", async () => {
  const { s } = await boot({ withKey: false });
  const r = await j(
    await fetch(s.url + "/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://gchat.qpic.cn/x.jpg" }),
    }),
  );
  assert.equal(r.ok, true, "key 选填：免密接口直接用");
  assert.equal(r.desc, "测试图：一只橘猫");
  await s.close();
});

test("存储位置：迁移配置和账本到新目录，面板立即可用", async () => {
  const A = mkdtempSync(join(tmpdir(), "rv-dd-a-"));
  const B = mkdtempSync(join(tmpdir(), "rv-dd-b-"));
  const pointer = join(A, "data-dir.json");
  const { createPanelServer } = await import("../src/panel-server.mjs");
  const { openEyeStore } = await import("../src/store.mjs");
  const s = await createPanelServer({ dataDir: A, pointerPath: pointer, port: 0 });
  // 旧目录里造一条审计记录 + 一份配置
  openEyeStore(A).record({ hash: "h1", url: "https://a/1.jpg", desc: "迁移前的记录", outputs: [], createdAt: 1 });
  writeFileSync(join(A, "vision.json"), JSON.stringify({ enabled: true, model: "keep-me" }));

  const r = await j(await fetch(s.url + "/api/data-dir", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: B }),
  }));
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(B, "eye.db")), true, "账本跟过去");
  assert.equal(existsSync(join(B, "vision.json")), true, "配置跟过去");
  assert.equal(existsSync(pointer), true, "指针写下了");
  // 切换后新目录可读:审计记录还在
  const seen = await j(await fetch(s.url + "/api/seen?limit=10"));
  assert.equal(seen.rows.length, 1);
  assert.equal(seen.rows[0].desc, "迁移前的记录");
  await s.close();
});

test("存储位置：目标已有 eye.db → 拒绝，防覆盖", async () => {
  const A = mkdtempSync(join(tmpdir(), "rv-dd-c-"));
  const B = mkdtempSync(join(tmpdir(), "rv-dd-d-"));
  const pointer = join(A, "data-dir.json");
  const { createPanelServer } = await import("../src/panel-server.mjs");
  const s = await createPanelServer({ dataDir: A, pointerPath: pointer, port: 0 });
  writeFileSync(join(B, "eye.db"), "not-a-db");
  const r = await j(await fetch(s.url + "/api/data-dir", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: B }),
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /eye.db/);
  await s.close();
});

test("面板：ffmpeg 路径改了能存住", async () => {
  const { s } = await boot();
  await j(await fetch(s.url + "/api/config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ video: { ffmpegPath: "C:/custom/ff.exe" } }),
  }));
  const cfg = await j(await fetch(s.url + "/api/config"));
  assert.equal(cfg.config.video.ffmpegPath, "C:/custom/ff.exe", "ffmpeg 路径要持久");
  await s.close();
});

test("ffmpeg 路径：相对路径按项目根解析，自带缺货退回 PATH", async () => {
  const { resolveFfmpegPath } = await import("../src/ring-vision.mjs");
  const { mkdirSync } = await import("node:fs");
  // ① 空 / 'ffmpeg' → 交给 PATH
  assert.equal(resolveFfmpegPath(""), "ffmpeg");
  assert.equal(resolveFfmpegPath("ffmpeg"), "ffmpeg");
  // ② 自带默认值 + bin 有货 → 项目根绝对路径（正反斜杠都认）
  const root = mkdtempSync(join(tmpdir(), "rv-ffbin-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "ffmpeg.exe"), "fake");
  assert.equal(resolveFfmpegPath("bin/ffmpeg.exe", root), join(root, "bin", "ffmpeg.exe"));
  assert.equal(resolveFfmpegPath("bin\\ffmpeg.exe", root), join(root, "bin", "ffmpeg.exe"));
  // ③ 自带默认值但 bin 没货（新克隆）→ 退回 PATH 的 ffmpeg
  const empty = mkdtempSync(join(tmpdir(), "rv-ffbin-empty-"));
  assert.equal(resolveFfmpegPath("bin/ffmpeg.exe", empty), "ffmpeg");
  // ④ 用户手填相对路径 → 解析；缺货照实返回（探测卡会如实报告"没装"）
  assert.equal(resolveFfmpegPath("tools/ff.exe", empty), join(empty, "tools", "ff.exe"));
  // ⑤ 绝对路径原样
  assert.equal(resolveFfmpegPath("C:/custom/ff.exe", root), "C:/custom/ff.exe");
});

test("面板：ffmpeg 默认值解析到插件自带 bin（bin 就位时）", async (t) => {
  if (!existsSync(join(process.cwd(), "bin", "ffmpeg.exe"))) return t.skip("bin/ffmpeg.exe 未就位（新克隆需先拷二进制）");
  const { s } = await boot({ withKey: false });
  const cfg = await j(await fetch(s.url + "/api/config"));
  assert.match(
    String(cfg.config.video.ffmpegPath).replace(/\\/g, "/"),
    /留影\/bin\/ffmpeg\.exe$/,
    "默认要落到插件自带的 bin/ffmpeg.exe",
  );
  await s.close();
});

test("面板：留档上限能存住；scene 抽帧方式不再被保存吞掉", async () => {
  const { s, dataDir } = await boot();
  const r = await j(await fetch(s.url + "/api/config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ retain: { images: 5, videoFrames: 3 }, video: { mode: "scene" } }),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.retain, { images: 5, videoFrames: 3 }, "留档上限往返");
  assert.equal(r.config.video.mode, "scene", "scene 模式保存后原样");
  const file = JSON.parse(readFileSync(join(dataDir, "vision.json"), "utf8"));
  assert.equal(file.retain.images, 5, "落盘");
  assert.equal(file.video.mode, "scene", "落盘");
  await s.close();
});

/** 造一个假的"环形的心"项目根（data-location.json 是库路径的唯一事实源），RING_ROOT 指过去 */
async function fakeRingRoot() {
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "rv-ring-root-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.js"), "export class Ringmind {}");
  mkdirSync(join(root, "data"), { recursive: true });
  const dbPath = join(root, "data", "memory.db").replace(/\\/g, "/");
  writeFileSync(join(root, "data-location.json"), JSON.stringify({ dbPath }));
  return { root, dbPath };
}

test("乱码防御：ringmind 库路径固化成 U+FFFD → 按 data-location.json 自动修复", async () => {
  const { repairMojibake } = await import("../src/ring-vision.mjs");
  const { root, dbPath } = await fakeRingRoot();
  const oldRoot = process.env.RING_ROOT;
  process.env.RING_ROOT = root;
  try {
    const cfg = { outputs: [{ type: "ringmind", enabled: true, dbPath: "D:/\uFFFD\uFFFD\uFFFD/\uFFFD\uFFFD\uFFFD.db", name: "\uFFFD\uFFFD\uFFFD" }] };
    assert.equal(repairMojibake(cfg), true, "修过要返回 true");
    assert.equal(cfg.outputs[0].dbPath, dbPath, "库路径修回唯一事实源");
    assert.equal(cfg.outputs[0].name, "memory", "库名取库文件名");
    // 干净配置不动手
    assert.equal(repairMojibake({ outputs: [{ type: "ringmind", dbPath, name: "测试记忆库" }] }), false);
    // 管线侧读取同样免疫：loadVisionConfig 拿到坏文件也能修
    const dataDir = mkdtempSync(join(tmpdir(), "rv-mojibake-"));
    writeFileSync(join(dataDir, "vision.json"), JSON.stringify({
      outputs: [{ type: "ringmind", enabled: true, dbPath: "\uFFFD:/\uFFFD\uFFFD.db", name: "\uFFFD" }],
    }));
    const { loadVisionConfig } = await import("../src/ring-vision.mjs");
    const loaded = loadVisionConfig({ dataDir });
    assert.equal(loaded.outputs[0].dbPath, dbPath, "管线读到的库路径是修好的");
  } finally {
    if (oldRoot === undefined) delete process.env.RING_ROOT;
    else process.env.RING_ROOT = oldRoot;
  }
});

test("面板：读到乱码库路径 → 修复落盘 + 横幅提示，下次读消失", async () => {
  const { root, dbPath } = await fakeRingRoot();
  const oldRoot = process.env.RING_ROOT;
  process.env.RING_ROOT = root;
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "rv-mojibake-panel-"));
    writeFileSync(join(dataDir, "vision.json"), JSON.stringify({
      enabled: true,
      outputs: [{ type: "ringmind", enabled: true, dbPath: "\uFFFD:/\uFFFD\uFFFD\uFFFD/\uFFFD\uFFFD\uFFFD.db", name: "\uFFFD\uFFFD\uFFFD\uFFFD" }],
    }));
    const s = await createPanelServer({ dataDir, port: 0 });
    const st = await j(await fetch(s.url + "/api/status"));
    assert.match(st.configIssue?.error ?? "", /乱码.*自动修复/s, "横幅要说一声");
    const file = JSON.parse(readFileSync(join(dataDir, "vision.json"), "utf8"));
    assert.equal(file.outputs[0].dbPath, dbPath, "落盘的坏路径要被修回来");
    // 第二次读：文件已经干净，横幅自动消失
    const st2 = await j(await fetch(s.url + "/api/status"));
    assert.equal(st2.configIssue, null);
    await s.close();
  } finally {
    if (oldRoot === undefined) delete process.env.RING_ROOT;
    else process.env.RING_ROOT = oldRoot;
  }
});