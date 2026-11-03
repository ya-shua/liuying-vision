/**
 * 环形的眼 · 测试（通用视觉接入）
 *
 * 覆盖的规矩：
 *   - CQ 码抠图链 / 抹 CQ
 *   - 看图 → 描述 → 扇出给所有输出（谁挂了只记谁的错）
 *   - ringmind 适配器：进圈、skipVault、不重复写总库
 *   - jsonl / webhook 适配器
 *   - 去重、日限、无 key、无输出 → 静默跳过
 *   - eye.db 记账持久、配置读取
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractImageUrls, stripCq } from "../src/cq.mjs";
import { describeImage } from "../src/describe.mjs";
import { openEyeStore } from "../src/store.mjs";
import { visionNote, defaultVisionConfig, loadVisionConfig } from "../src/ring-vision.mjs";
import * as ringmindAdapter from "../src/adapters/ringmind.mjs";
import * as jsonlAdapter from "../src/adapters/jsonl.mjs";
import * as webhookAdapter from "../src/adapters/webhook.mjs";

const IMG_URL_A = "https://gchat.qpic.cn/a.jpg";
const IMG_URL_B = "https://gchat.qpic.cn/b.jpg";

/** 动态加载记忆库的 Ringmind（找不到就跳过对应测试，不硬挂） */
async function makeLibrary() {
  const root = ringmindAdapter.ringRoot();
  if (!root) return null;
  const mod = await import(`file://${root}/src/index.js`);
  return new mod.Ringmind(":memory:", "视觉测试");
}

/** 假视觉服务：/chat/completions 回固定 JSON，其它（图链/图链外下载）回字节 */
function fakeFetch(chatBody) {
  return async (url) => {
    if (String(url).includes("/chat/completions")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: chatBody } }] }) };
    }
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      headers: new Map([["content-type", "image/jpeg"]]),
    };
  };
}

const cfgOf = (over = {}) => ({
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://vision.test/v4",
  model: "test-vision",
  dailyCap: 10,
  perMessage: 2,
  maxBytes: 1024 * 1024,
  timeoutMs: 1000,
  outputs: [],
  ...over,
});

// ── CQ 码抠图链 ──────────────────────────────────────────

test("extractImageUrls：file 直接是网址 / url 键 / 多张去重", () => {
  assert.deepEqual(
    extractImageUrls("看这张[CQ:image,file=https://p.qqan.com/up/a.jpg]"),
    ["https://p.qqan.com/up/a.jpg"],
  );
  assert.deepEqual(
    extractImageUrls("[CQ:image,file=ABC.image,url=https://gchat.qpic.cn/x.jpg]"),
    ["https://gchat.qpic.cn/x.jpg"],
  );
  const two = extractImageUrls(
    "[CQ:image,file=https://a/1.jpg][CQ:image,file=https://a/1.jpg][CQ:image,file=https://a/2.jpg]",
  );
  assert.equal(two.length, 2);
  assert.deepEqual(extractImageUrls("纯文字，没有图"), []);
  assert.deepEqual(extractImageUrls(null), []);
});

test("stripCq：CQ 码抹成 [图片]", () => {
  assert.equal(stripCq("看[CQ:image,file=https://a/1.jpg]这张"), "看[图片]这张");
});

// ── 视觉客户端 ──────────────────────────────────────────

test("describeImage：解析模型的 JSON，返回 desc + points", async () => {
  const out = await describeImage({
    baseUrl: "https://vision.test/v4", model: "test-vision", apiKey: "k",
    imageBase64: "AAAA", hint: "这张怎么样",
    fetchImpl: fakeFetch('{"desc":"一只橘猫趴在键盘上","points":["橘猫","趴在键盘上","屏幕亮着"]}'),
  });
  assert.equal(out.desc, "一只橘猫趴在键盘上");
  assert.deepEqual(out.points, ["橘猫", "趴在键盘上", "屏幕亮着"]);
});

test("describeImage：模型不给 JSON 就整段当 desc，points 留空", async () => {
  const out = await describeImage({
    baseUrl: "u", model: "m", apiKey: "k", imageBase64: "AAAA",
    fetchImpl: fakeFetch("图里是一只猫。"),
  });
  assert.equal(out.desc, "图里是一只猫。");
  assert.deepEqual(out.points, []);
});

test("describeImage：key 选填——没 key 不带鉴权头也能用", async () => {
  let auth = null;
  const fake = async (url, opts = {}) => {
    auth = (opts.headers && opts.headers.authorization) || null;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"desc":"一只猫"}' } }] }) };
  };
  const out = await describeImage({ baseUrl: "u", model: "m", apiKey: "", imageBase64: "A", fetchImpl: fake });
  assert.equal(out.desc, "一只猫");
  assert.equal(auth, null, "没 key 就不该带鉴权头");
});

test("describeImage：有 key 就带 Bearer 鉴权头", async () => {
  let auth = null;
  const fake = async (url, opts = {}) => {
    auth = (opts.headers && opts.headers.authorization) || null;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"desc":"一只猫"}' } }] }) };
  };
  await describeImage({ baseUrl: "u", model: "m", apiKey: "k1", imageBase64: "A", fetchImpl: fake });
  assert.equal(auth, "Bearer k1");
});

test("describeImage：没图 / 接口 500 → 报错", async () => {
  await assert.rejects(() =>
    describeImage({ baseUrl: "u", model: "m", apiKey: "k", imageBase64: "", fetchImpl: fakeFetch("") }));
  await assert.rejects(() =>
    describeImage({
      baseUrl: "u", model: "m", apiKey: "k", imageBase64: "A",
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }),
    }));
});

// ── 适配器：ringmind / jsonl / webhook ───────────────────

test("ringmind 适配器：描述进圈、skipVault 不写总库", async () => {
  const lib = await makeLibrary();
  if (!lib) return; // 没找到记忆库项目就跳过（本机一定有）
  const r = await ringmindAdapter.deliver(
    { desc: "群友发了一张表情包：猫猫举牌", points: ["猫猫", "举牌"], url: IMG_URL_A, key: "group-1", sender: "群友", at: Date.now() },
    { db: lib, ring: "ring4" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.ring, "ring4");
  const mem = lib.recent(1)[0];
  assert.equal(mem.ring, "ring4");
  assert.equal(mem.content.includes("猫猫"), true);
  assert.equal(lib.store.vaultCount(), 0, "skipVault：描述不进总库");
  lib.close();
});

test("ringmind 适配器：不给 dbPath 也不注入实例 → 明确报错（不猜路径）", async () => {
  const r = await ringmindAdapter.deliver(
    { desc: "x", points: [], url: IMG_URL_A, key: "g", sender: "u", at: 1 },
    {},
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /dbPath/);
});

test("visionNote：输入通用化——images 数组优先，不要求 CQ 码", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-imgs-"));
  const store = openEyeStore(dataDir);
  const jsonlFile = join(dataDir, "log.jsonl");
  const cfg = cfgOf({ outputs: [{ type: "jsonl", enabled: true, file: jsonlFile }] });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_URL_A], text: "纯文字消息，没有任何 CQ 码", at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch('{"desc":"显式图链也能看","points":["图"]}'),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.remembered, 1);
  assert.equal(r.results[0].url, IMG_URL_A);
});

test("jsonl 适配器：追加一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "ring-vision-jsonl-"));
  const file = join(dir, "vision-log.jsonl");
  const r = jsonlAdapter.deliver(
    { desc: "一张猫图", points: ["猫"], url: IMG_URL_A, key: "g", sender: "u", at: 12345 },
    { file },
  );
  assert.equal(r.ok, true);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].desc, "一张猫图");
});

test("webhook 适配器：POST JSON，2xx 算成", async () => {
  let captured = null;
  const r = await webhookAdapter.deliver(
    { desc: "一张猫图", points: ["猫"], url: IMG_URL_A, key: "g", sender: "u", at: 1 },
    { url: "https://hook.test/ingest" },
    { fetchImpl: async (u, o) => { captured = { u, body: JSON.parse(o.body) }; return { ok: true, status: 200 }; } },
  );
  assert.equal(r.ok, true);
  assert.equal(captured.body.event, "vision.seen");
  assert.equal(captured.body.desc, "一张猫图");
});

test("webhook 适配器：500 只记自己的错", async () => {
  const r = await webhookAdapter.deliver(
    { desc: "x", points: [], url: IMG_URL_A, key: "g", sender: "u", at: 1 },
    { url: "https://hook.test/ingest" },
    { fetchImpl: async () => ({ ok: false, status: 500 }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /500/);
});

// ── visionNote 端到端（扇出 + 记账 + 规矩）────────────────

test("visionNote：扇出两个输出，eye.db 记账持久", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-e2e-"));
  const lib = await makeLibrary();
  const jsonlFile = join(dataDir, "vision-log.jsonl");
  const cfg = cfgOf({
    outputs: [
      ...(lib ? [{ type: "ringmind", enabled: true, db: lib, ring: "ring4" }] : []),
      { type: "jsonl", enabled: true, file: jsonlFile },
    ],
  });

  const r = await visionNote(
    { key: "group-1", sender: "群友", text: `看[CQ:image,file=${IMG_URL_A}]`, at: Date.now() },
    { cfg, dataDir, fetchImpl: fakeFetch('{"desc":"一张猫图","points":["猫"]}'), store: openEyeStore(dataDir) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.remembered, 1);
  assert.equal(r.results[0].outputs.length, lib ? 2 : 1);
  assert.equal(r.results[0].outputs.every((o) => o.ok), true);

  // jsonl 真的写了
  assert.equal(readFileSync(jsonlFile, "utf8").includes("一张猫图"), true);
  // ringmind 真的进了圈
  if (lib) {
    const mem = lib.recent(1)[0];
    assert.equal(mem.ring, "ring4");
    lib.close();
  }

  // eye.db 换个 store 句柄再读，账还在（持久）
  const again = openEyeStore(dataDir);
  assert.equal(again.total(), 1);
});

test("visionNote：同一张图不重复看（去重）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-dedup-"));
  const cfg = cfgOf({ outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }] });
  const store = openEyeStore(dataDir);
  const input = { key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_A}]`, at: Date.now() };
  const f = fakeFetch('{"desc":"一张图","points":[]}');

  const r1 = await visionNote(input, { cfg, dataDir, store, fetchImpl: f });
  assert.equal(r1.remembered, 1);
  const r2 = await visionNote(input, { cfg, dataDir, store, fetchImpl: f });
  assert.equal(r2.results[0].skipped, "seen");
  assert.equal(store.total(), 1);
});

test("visionNote：日限到了就闭嘴", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-cap-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({ dailyCap: 1, outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }] });
  const f = fakeFetch('{"desc":"x","points":[]}');

  const r1 = await visionNote({ key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_A}]`, at: Date.now() }, { cfg, dataDir, store, fetchImpl: f });
  assert.equal(r1.remembered, 1);
  const r2 = await visionNote({ key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_B}]`, at: Date.now() }, { cfg, dataDir, store, fetchImpl: f });
  assert.equal(r2.skipped, "daily-cap");
  assert.equal(store.total(), 1);
});

test("visionNote：一个输出挂了，其它输出照常投递", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-fanout-"));
  const store = openEyeStore(dataDir);
  const jsonlFile = join(dataDir, "log.jsonl");
  const mixedFetch = async (url) => {
    if (String(url).includes("/chat/completions")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"desc":"一张图","points":[]}' } }] }) };
    }
    if (String(url).includes("hook.test")) return { ok: false, status: 500 };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer, headers: new Map([["content-type", "image/jpeg"]]) };
  };
  const cfg = cfgOf({
    outputs: [
      { type: "webhook", enabled: true, url: "https://hook.test/ingest" },
      { type: "jsonl", enabled: true, file: jsonlFile },
    ],
  });
  const r = await visionNote(
    { key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_A}]`, at: Date.now() },
    { cfg, dataDir, store, fetchImpl: mixedFetch },
  );
  assert.equal(r.ok, true);
  assert.equal(r.remembered, 1);
  const wh = r.results[0].outputs.find((o) => o.type === "webhook");
  const jl = r.results[0].outputs.find((o) => o.type === "jsonl");
  assert.equal(wh.ok, false);
  assert.equal(jl.ok, true);
});

test("visionNote：没 key / 没图 / 没输出 → 静默跳过", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-skip-"));
  const store = openEyeStore(dataDir);
  const noKey = await visionNote(
    { key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_A}]` },
    { cfg: cfgOf({ enabled: false }), dataDir, store, fetchImpl: fakeFetch("{}") },
  );
  assert.equal(noKey.skipped, "disabled");

  const noOut = await visionNote(
    { key: "g", sender: "u", text: `[CQ:image,file=${IMG_URL_A}]` },
    { cfg: cfgOf(), dataDir, store, fetchImpl: fakeFetch("{}") },
  );
  assert.equal(noOut.skipped, "no-outputs");

  const noImg = await visionNote(
    { key: "g", sender: "u", text: "纯聊天" },
    { cfg: cfgOf({ outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }] }), dataDir, store, fetchImpl: fakeFetch("{}") },
  );
  assert.equal(noImg.skipped, "no-media");
  assert.equal(store.total(), 0);
});

// ── 配置 ────────────────────────────────────────────────

test("loadVisionConfig：从 dataDir 读 vision.json，enabled 跟着 key 走", () => {
  const dir = mkdtempSync(join(tmpdir(), "ring-vision-cfg-"));
  writeFileSync(join(dir, "vision.json"), JSON.stringify({ enabled: true, apiKey: "sk-file-9999", model: "file-model", outputs: [{ type: "jsonl", enabled: true, file: "x.jsonl" }] }));
  const cfg = loadVisionConfig({ dataDir: dir });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, "sk-file-9999");
  assert.equal(cfg.model, "file-model");
  assert.deepEqual(cfg.outputs.map((o) => o.type), ["jsonl"]);

  const empty = loadVisionConfig({ dataDir: mkdtempSync(join(tmpdir(), "ring-vision-cfg2-")) });
  assert.equal(empty.enabled, false);
  assert.deepEqual(empty.outputs, []);
});

test("loadVisionConfig：默认目录 = 项目根 data/（面板和桥接两侧一致）", () => {
  // 指针隔离：机器上可能真有 data-dir.json（用户迁移过存储位置），测试不能被它击中
  const old = process.env.RING_VISION_POINTER;
  process.env.RING_VISION_POINTER = join(tmpdir(), "rv-no-such-pointer-" + Date.now() + ".json");
  try {
    const cfg = loadVisionConfig();
    const norm = cfg.dataDir.split(/[\\/]+/).join('/');
    assert.ok(norm.endsWith('/留影/data'), '默认数据目录应在项目根 data/ 下，实际 ' + norm);
  } finally {
    if (old === undefined) delete process.env.RING_VISION_POINTER;
    else process.env.RING_VISION_POINTER = old;
  }
});

test("loadVisionConfig：存储位置指针存在 → 指针优先于项目根 data/", () => {
  const target = mkdtempSync(join(tmpdir(), "rv-pointer-target-"));
  const pointer = join(mkdtempSync(join(tmpdir(), "rv-pointer-alt-")), "pointer.json");
  writeFileSync(pointer, JSON.stringify({ dataDir: target }));
  const old = process.env.RING_VISION_POINTER;
  process.env.RING_VISION_POINTER = pointer;
  try {
    const cfg = loadVisionConfig();
    assert.equal(cfg.dataDir, target, "指针指向的目录要被采用");
  } finally {
    if (old === undefined) delete process.env.RING_VISION_POINTER;
    else process.env.RING_VISION_POINTER = old;
  }
});

test("defaultVisionConfig：outputs 默认为空", () => {
  const cfg = defaultVisionConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.outputs, []);
});
