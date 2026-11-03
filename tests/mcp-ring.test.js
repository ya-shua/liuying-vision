/**
 * 留影 · MCP 接入适配器 测试
 *
 * 起真的环形的心 MCP server（RING_DB 指到临时库），
 * 走完整 JSON-RPC：initialize → tools/call ring_ingest → ring_search 查回 →
 * visionNote 全链路 → 找不到库时的容错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MCP server 启动时解析 RING_DB —— 必须在它 spawn 前设好（子进程继承环境）
process.env.RING_DB = join(tmpdir(), "mcp-ring-test", "memory.db");

const { deliver, getMcpSession, closeMcpSession, ringRoot } = await import("../src/adapters/mcp-ring.mjs");
const { openEyeStore } = await import("../src/store.mjs");
const { visionNote } = await import("../src/ring-vision.mjs");
const { Ringmind } = await import("file://" + ringRoot() + "/src/index.js");
const R2 = Ringmind;

test("MCP：ring_ingest 入库 → ring_search 查回（完整 JSON-RPC）", async () => {
  const r = await deliver(
    { desc: "画面里是一只橘猫", points: ["橘猫"], url: "https://a/1.jpg", kind: "image", key: "group-1", sender: "群友", at: Date.now() },
    {},
  );
  assert.equal(r.ok, true, "投递成功：r.text = " + (r.text ?? r.error));
  assert.match(r.text, /留影入库/);

  // 用接口自己查：ring_search 应能搜到刚入库的描述
  const s = await getMcpSession({});
  const res = await s.rpc("tools/call", { name: "ring_search", arguments: { keyword: "橘猫" } });
  const text = res?.content?.[0]?.text ?? "";
  assert.match(text, /橘猫/, "入库的描述要能被 ring_search 查回");

  closeMcpSession();
});

test("visionNote：outputs 指向 MCP 适配器 → 全链路进圈", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-mcp-"));
  const store = openEyeStore(dataDir);
  const cfg = {
    enabled: true,
    baseUrl: "https://vision.test/v4",
    model: "test-vision",
    apiKey: "k",
    dailyCap: 10,
    perMessage: 2,
    maxBytes: 1048576,
    timeoutMs: 1000,
    outputs: [{ type: "mcp-ring", enabled: true }],
    video: { enabled: false },
  };
  const fake = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"desc":"一张测试图","points":["测试"]}' } }] }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: new Map([["content-type", "image/jpeg"]]),
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: ["https://gchat.qpic.cn/x.jpg"], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fake },
  );
  assert.equal(r.ok, true);
  const out = r.results[0].outputs.find((o) => o.type === "mcp-ring");
  assert.equal(out.ok, true, "MCP 投递成功：" + (out.error ?? ""));

  // 佐证：ringmind 库里真的多了这条（描述进了闲聊圈）
  const lib = new R2(process.env.RING_DB, "核对");
  const mem = lib.recent(1)[0];
  assert.equal(mem.content.includes("一张测试图"), true);
  lib.close();

  closeMcpSession();
});

test("MCP：找不到环形的心 → 明确报错带回，不炸", async () => {
  const r = await deliver(
    { desc: "x", points: [], url: "https://a/1.jpg", key: "g", sender: "u", at: 1 },
    { ringRoot: "D:/no-such-place-xyz" },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /找不到环形的心|MCP server 不存在/); // 两种都算“没接上”
});
