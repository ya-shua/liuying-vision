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