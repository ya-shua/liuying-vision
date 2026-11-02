/**
 * 环形的眼 · 面板测试
 *
 * 规矩：只监听本机、key 打码不回传、试看不进任何输出、配置存盘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
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
