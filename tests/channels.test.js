/**
 * 留影 · 多通道并发 测试
 *
 * - buildChannels:channels 优先 / 单模型回退 / 无模型空列表
 * - 多通道分发:图按通道并行,结果按原顺序,模型各归各
 * - 单通道回退:channels 空 → 用 baseUrl/model/apiKey
 * - 面板:channels 消毒(最多4/必填/key 留空保留旧值/嵌套打码)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openEyeStore } from "../src/store.mjs";
import { visionNote, loadVisionConfig } from "../src/ring-vision.mjs";
import { createPanelServer } from "../src/panel-server.mjs";

const IMG_A = "https://gchat.qpic.cn/a.jpg";
const IMG_B = "https://gchat.qpic.cn/b.jpg";
const IMG_C = "https://gchat.qpic.cn/c.jpg";

/** 假视觉服务:按请求里的模型回对应描述,方便断言"哪条通道处理了哪张" */
const fakeFetch = () => async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/chat/completions")) {
    const model = JSON.parse(opts.body).model;
    return { ok: true, json: async () => ({ choices: [{ message: { content: `{"desc":"模型${model}看到的图","points":["${model}"]}` } }] }) };
  }
  return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Map([["content-type", "image/jpeg"]]) };
};

const cfgOf = (over = {}) => ({
  enabled: true,
  baseUrl: "https://vision.test/v4",
  model: "model-single",
  apiKey: "key-single",
  dailyCap: 10,
  perMessage: 4,
  maxBytes: 1048576,
  timeoutMs: 1000,
  outputs: [],
  ...over,
});

const dataDirOf = () => mkdtempSync(join(tmpdir(), "rv-ch-"));

test("buildChannels 语义:多通道分发,结果按原顺序,模型各归各", async () => {
  const dataDir = dataDirOf();
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    channels: [
      { baseUrl: "https://m1.test/v1", model: "model-a", apiKey: "ka" },
      { baseUrl: "https://m2.test/v1", model: "model-b", apiKey: "kb" },
    ],
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_A, IMG_B], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.ok, true);
  assert.equal(r.remembered, 2);
  // 顺序保持:第 0 张给通道 0,第 1 张给通道 1
  assert.equal(r.results[0].model, "model-a");
  assert.equal(r.results[1].model, "model-b");
  assert.equal(r.results[0].desc.includes("model-a"), true);
});

test("多张图、通道不够 → 通道复用轮转,全部看完", async () => {
  const dataDir = dataDirOf();
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    channels: [
      { baseUrl: "https://m1.test/v1", model: "model-a", apiKey: "" },
      { baseUrl: "https://m2.test/v1", model: "model-b", apiKey: "" },
    ],
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_A, IMG_B, IMG_C], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.remembered, 3, "3 张图都看完");
  const models = r.results.map((x) => x.model).sort();
  assert.deepEqual(models, ["model-a", "model-a", "model-b"]);
});

test("单模型回退:channels 空 → 用 baseUrl/model/apiKey", async () => {
  const dataDir = dataDirOf();
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    channels: [],
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_A], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.results[0].model, "model-single");
  assert.equal(r.results[0].desc.includes("model-single"), true);
});

test("面板:channels 消毒(截4条/过滤残缺/key留空保留旧值)+打码", async () => {
  const dataDir = dataDirOf();
  const s = await createPanelServer({ dataDir, port: 0, visionFetchImpl: async () => { throw new Error("x"); } });
  const j = (r) => r.json();
  // 先存一条带 key 的通道
  await fetch(s.url + "/api/config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, channels: [{ baseUrl: "https://m1.test/v1", model: "model-a", apiKey: "ka-old" }] }),
  });
  // 再存:同通道 key 留空 → 保留旧值;残缺条被过滤;超 4 条截断
  const r2 = await j(await fetch(s.url + "/api/config", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channels: [
        { baseUrl: "https://m1.test/v1", model: "model-a", apiKey: "" },
        { baseUrl: "https://m2.test/v1", model: "model-b", apiKey: "kb" },
        { baseUrl: "", model: "bad" },
        { baseUrl: "https://m3.test/v1", model: "model-c", apiKey: "" },
        { baseUrl: "https://m4.test/v1", model: "model-d", apiKey: "" },
        { baseUrl: "https://m5.test/v1", model: "model-e", apiKey: "" },
      ],
    }),
  }));
  assert.equal(r2.ok, true);
  assert.equal(r2.config.channels.length, 4, "最多 4 条");
  const m1 = r2.config.channels.find((c) => c.model === "model-a");
  assert.equal(m1.apiKeySet, true, "key 留空保留旧值");
  assert.equal(m1.apiKey, undefined, "嵌套 key 必须打码");
  const saved = JSON.parse(readFileSync(join(dataDir, "vision.json"), "utf8"));
  assert.equal(saved.channels.find((c) => c.model === "model-a").apiKey, "ka-old", "落盘保留旧 key");
  await s.close();
});
