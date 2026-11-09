/**
 * 留影 · 对接契约测试
 *
 * 规矩（见 docs/对接.md）：
 *   /api/health   —— 只读探活，免 token，2 秒内回
 *   /api/manifest —— metadata.json 原样 + 实际监听端口 / pid / 启动时间
 *   两个接口都不许带出 key
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPanelServer } from "../src/panel-server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const meta = JSON.parse(readFileSync(join(ROOT, "metadata.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

async function boot({ withKey = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ring-vision-contract-"));
  const s = await createPanelServer({ dataDir, port: 0 });
  if (withKey) {
    await fetch(s.url + "/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, apiKey: "sk-test-1234", baseUrl: "https://vision.test/v4", model: "test-vision" }),
    });
  }
  return { s, dataDir };
}

const j = async (r) => r.json();

test("契约：/api/health 免 token 就能回 id/version/uptime，不查外部依赖", async () => {
  const { s } = await boot();
  const r = await fetch(s.url + "/api/health"); // 不带任何头
  assert.equal(r.status, 200);
  const h = await j(r);
  assert.equal(h.ok, true);
  assert.equal(h.id, meta.id);
  assert.equal(h.version, pkg.version, "version 要和 package.json 一致");
  assert.equal(typeof h.uptime_s, "number");
  assert.ok(h.uptime_s >= 0 && Number.isInteger(h.uptime_s));
  await s.close();
});

test("契约：/api/manifest 原样带出 metadata.json，runtime 是实际监听端口", async () => {
  const { s } = await boot();
  const r = await fetch(s.url + "/api/manifest");
  assert.equal(r.status, 200);
  const m = await j(r);
  assert.equal(m.ok, true);
  assert.deepEqual(m.metadata, meta, "metadata 必须一个字段都不改");
  assert.equal(m.runtime.port, Number(new URL(s.url).port), "报的要真是正在听的那个口");
  assert.equal(m.runtime.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(m.runtime.started_at)), "started_at 要能被 Date.parse 认");
  assert.ok(Date.parse(m.runtime.started_at) <= Date.now(), "启动时间不能在未来");
  await s.close();
});

test("契约：两个接口都不带出 key（配了 key 也一样）", async () => {
  const { s } = await boot({ withKey: true });
  for (const p of ["/api/health", "/api/manifest"]) {
    const raw = await (await fetch(s.url + p)).text();
    assert.equal(raw.includes("sk-test-1234"), false, `${p} 不许出现完整 key`);
    assert.equal(raw.includes("apiKey"), false, `${p} 连 apiKey 字段都不该有`);
  }
  await s.close();
});

test("契约：metadata 补齐 capabilities / standalone / contract，且 contract 指向真文件", () => {
  assert.ok(Array.isArray(meta.capabilities), "capabilities 要是数组");
  assert.ok(meta.capabilities.length >= 3 && meta.capabilities.length <= 6, "3~6 条");
  for (const c of meta.capabilities) assert.ok(typeof c === "string" && c.trim(), "每条都是非空中文短语");

  assert.equal(meta.standalone?.works_alone, true);
  assert.ok(Array.isArray(meta.standalone?.needs) && meta.standalone.needs.length, "needs 一条一句");
  assert.ok(typeof meta.standalone?.how === "string" && meta.standalone.how.trim(), "how 要能照着做");

  assert.equal(meta.contract, "docs/对接.md");
  assert.ok(existsSync(join(ROOT, "docs", "对接.md")), "contract 指的文件必须真的在");
});