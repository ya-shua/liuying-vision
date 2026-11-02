/**
 * 留影 · 视频支持 + 新适配器 测试
 *
 * - CQ:video 抽取
 * - 抽帧参数纯函数（interval / even）
 * - 视频路由：关掉 → video-disabled；没 ffmpeg → no-ffmpeg（都不阻塞图片）
 * - 适配器：sqlite 通用表、markdown 追加、custom 自定义脚本
 * - eye.db 记 kind
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractMedia, extractImageUrls } from "../src/cq.mjs";
import { buildFrameArgs, ffmpegAvailable } from "../src/video.mjs";
import { openEyeStore } from "../src/store.mjs";
import { visionNote } from "../src/ring-vision.mjs";
import * as sqliteAdapter from "../src/adapters/sqlite.mjs";
import * as markdownAdapter from "../src/adapters/markdown.mjs";
import { DatabaseSync } from "node:sqlite";

const IMG_URL_A = "https://gchat.qpic.cn/a.jpg";
const VID_URL_A = "https://gchat.qpic.cn/clip.mp4";

const fakeFetch = (chatBody = '{"desc":"画面里有只猫","points":["猫"]}') => async (url) => {
  if (String(url).includes("/chat/completions")) {
    return { ok: true, json: async () => ({ choices: [{ message: { content: chatBody } }] }) };
  }
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: new Map([["content-type", "image/jpeg"]]),
  };
};

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
  video: { enabled: true, frames: 3, mode: "interval", intervalSec: 5, maxBytes: 1048576, ffmpegPath: "ffmpeg-test-missing" },
  ...over,
});

// ── CQ:video ────────────────────────────────────────────

test("extractMedia：图片和视频分开抽", () => {
  const m = extractMedia("[CQ:image,file=https://a/1.jpg][CQ:video,file=https://a/v.mp4]");
  assert.deepEqual(m.images, ["https://a/1.jpg"]);
  assert.deepEqual(m.videos, ["https://a/v.mp4"]);
  assert.deepEqual(extractImageUrls("[CQ:video,file=https://a/v.mp4]"), [], "旧接口只回图片");
});

// ── 抽帧参数纯函数 ───────────────────────────────────────

test("buildFrameArgs：interval 模式按间隔秒", () => {
  const r = buildFrameArgs({ mode: "interval", frames: 3, intervalSec: 5 });
  assert.equal(r.mode, "interval");
  assert.equal(r.vf.includes("fps=1/5"), true);
});

test("buildFrameArgs：even 模式按时长均分，没时长自动退 interval", () => {
  const r = buildFrameArgs({ mode: "even", frames: 4, durationSec: 12.5 });
  assert.equal(r.mode, "even");
  assert.equal(r.vf.includes("fps=4/12.500"), true);
  const fallback = buildFrameArgs({ mode: "even", frames: 4, durationSec: 0 });
  assert.equal(fallback.mode, "interval");
});

test("ffmpegAvailable：不存在的路径返回 false", async () => {
  assert.equal(await ffmpegAvailable("ffmpeg-definitely-not-here-xyz"), false);
});

// ── 视频路由 ────────────────────────────────────────────

test("visionNote：视频关掉 → video-disabled，图片照常", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-vidoff-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
    video: { enabled: false },
  });
  const r = await visionNote(
    { key: "g", sender: "u", videos: [VID_URL_A], images: [IMG_URL_A], text: "看这两个", at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.ok, true);
  const vid = r.results.find((x) => x.kind === "video");
  const img = r.results.find((x) => x.kind === "image");
  assert.equal(vid.skipped, "video-disabled");
  assert.equal(img.desc, "画面里有只猫");
  assert.equal(store.recent(10)[0].kind, "image");
});

test("visionNote：没 ffmpeg → no-ffmpeg 跳过", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-noff-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
    video: { enabled: true, ffmpegPath: "ffmpeg-definitely-not-here-xyz" },
  });
  const r = await visionNote(
    { key: "g", sender: "u", videos: [VID_URL_A], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  const vid = r.results.find((x) => x.kind === "video");
  assert.equal(vid.skipped, "no-ffmpeg");
});

// ── 新适配器 ────────────────────────────────────────────

test("sqlite 适配器：自动建表 + 插入可读回", () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-sqlite-"));
  const dbPath = join(dir, "out.db");
  const r = sqliteAdapter.deliver(
    { desc: "一只猫", points: ["猫"], url: IMG_URL_A, kind: "image", key: "g", sender: "u", at: 111 },
    { dbPath, table: "vision_log" },
  );
  assert.equal(r.ok, true);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT desc, kind, points FROM vision_log").get();
  assert.equal(row.desc, "一只猫");
  assert.equal(row.kind, "image");
  assert.deepEqual(JSON.parse(row.points), ["猫"]);
});

test("markdown 适配器：追加带日期的节", () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-md-"));
  const file = join(dir, "留影.md");
  const r = markdownAdapter.deliver(
    { desc: "一只猫", points: ["猫"], url: IMG_URL_A, kind: "image", at: 111 },
    { file },
  );
  assert.equal(r.ok, true);
  const txt = readFileSync(file, "utf8");
  assert.equal(txt.includes("# 留影"), true);
  assert.equal(txt.includes("一只猫"), true);
  assert.equal(txt.includes("- 猫"), true);
});

test("custom 适配器：指向自己的 .mjs 也能收货", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-custom-"));
  const adapterFile = join(dir, "my-adapter.mjs");
  const outFile = join(dir, "out.txt");
  writeFileSync(adapterFile, `
export async function deliver(item, cfg) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(cfg.outFile, item.desc + "\\n", "utf8");
  return { ok: true };
}
`);
  const dataDir = mkdtempSync(join(tmpdir(), "rv-custom2-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    outputs: [{ type: "custom", enabled: true, file: adapterFile, outFile }],
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_URL_A], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.ok, true);
  assert.equal(r.results[0].outputs[0].ok, true);
  assert.equal(readFileSync(outFile, "utf8").includes("画面里有只猫"), true);
});

test("buildFrameArgs：scene 模式按镜头切换阈值取帧", () => {
  const r = buildFrameArgs({ mode: "scene", frames: 3, sceneThreshold: 0.4 });
  assert.equal(r.mode, "scene");
  assert.equal(r.vf.includes("select='gt(scene,0.4)'"), true);
  assert.equal(r.vf.includes("scale='min(720,iw)':-2"), true);
});

test("visionNote：gif 动图没 ffmpeg → 跳过不炸", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-gif-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
    video: { enabled: true, ffmpegPath: "ffmpeg-definitely-not-here-xyz" },
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: ["https://a/emoji.gif"], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  const gif = r.results.find((x) => x.kind === "gif");
  assert.equal(gif.skipped, "no-ffmpeg");
  assert.equal(store.total(), 0);
});

// ── 混合媒体 perMessage ─────────────────────────────────

test("visionNote：图+视频混排，perMessage 截断", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-mixed-"));
  const store = openEyeStore(dataDir);
  const cfg = cfgOf({
    perMessage: 2,
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
    video: { enabled: false },
  });
  const r = await visionNote(
    { key: "g", sender: "u", images: [IMG_URL_A], videos: [VID_URL_A], text: "都看看", at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fakeFetch() },
  );
  assert.equal(r.results.length, 2, "perMessage=2：图片在前视频在后");
  assert.equal(existsSync(join(dataDir, "log.jsonl")), true);
});

// ── 声音转文字（ASR）────────────────────────────────────

test("extractAudio：假 ffmpeg 吐出音轨文件 → 返回 buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rv-audio-"));
  const { extractAudio } = await import("../src/audio.mjs");
  const fakeSpawn = (cmd, args) => ({
    stderr: { on() {} },
    on(ev, cb) {
      if (ev === "close") setTimeout(() => {
        const out = args[args.indexOf("-b:a") + 2];
        writeFileSync(out, Buffer.from("mp3data-".repeat(200)));
        cb(0);
      }, 5);
    },
  });
  const audio = await extractAudio({ buffer: Buffer.from("video"), ffmpegPath: "ffmpeg", maxSeconds: 60, tmpDir: dir, spawnImpl: fakeSpawn });
  assert.equal(audio?.buffer.length > 0, true);
});

test("transcribeAudio：multipart 发到 /audio/transcriptions，免密不带鉴权头", async () => {
  let captured = null;
  const { transcribeAudio } = await import("../src/audio.mjs");
  const fake = async (url, opts = {}) => {
    captured = { url, headers: opts.headers, body: opts.body };
    return { ok: true, json: async () => ({ text: "大家好呀" }) };
  };
  const r = await transcribeAudio({ audioBuffer: Buffer.from("mp3"), baseUrl: "https://asr.test/v1", model: "w1", apiKey: "", fetchImpl: fake });
  assert.equal(r.text, "大家好呀");
  assert.equal(captured.url.endsWith("/audio/transcriptions"), true);
  assert.equal(captured.headers.authorization, undefined, "免密不带鉴权头");
  assert.equal(captured.body.get("model"), "w1");
});

test("visionNote：视频+声音转文字 e2e（假 ffmpeg + 假 ASR）", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rv-asr-"));
  const store = openEyeStore(dataDir);
  const fakeSpawn = (cmd, args) => ({
    stderr: { on() {} },
    on(ev, cb) {
      if (ev === "close") setTimeout(() => {
        const outArg = args.find((a) => a.includes("%02d.jpg"));
        if (outArg) {
          for (let i = 1; i <= 2; i++) writeFileSync(outArg.replace("%02d", String(i).padStart(2, "0")), Buffer.from("jpg"));
        } else {
          const mp3 = args.find((a) => a.endsWith(".mp3"));
          if (mp3) writeFileSync(mp3, Buffer.from("mp3data-".repeat(200)));
        }
        cb(0);
      }, 5);
    },
  });
  const fake = async (url) => {
    const u = String(url);
    if (u.includes("/chat/completions")) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"desc":"画面：一只猫","points":["猫"]}' } }] }) };
    if (u.includes("/audio/transcriptions")) return { ok: true, json: async () => ({ text: "大家好呀" }) };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Map([["content-type", "video/mp4"]]) };
  };
  const cfg = cfgOf({
    outputs: [{ type: "jsonl", enabled: true, file: join(dataDir, "log.jsonl") }],
    video: { enabled: true, frames: 2, ffmpegPath: "ffmpeg", maxBytes: 1048576 },
    asr: { enabled: true, baseUrl: "https://asr.test/v1", model: "w1", apiKey: "", maxSeconds: 60 },
  });
  const r = await visionNote(
    { key: "g", sender: "u", videos: [VID_URL_A], at: Date.now() },
    { cfg, dataDir, store, fetchImpl: fake, spawnImpl: fakeSpawn, ffmpegProbe: async () => true },
  );
  assert.equal(r.ok, true);
  const v = r.results.find((x) => x.kind === "video");
  assert.equal(v.frames, 2);
  assert.equal(v.desc.includes("画面：一只猫"), true);
  assert.equal(v.desc.includes("声音：「大家好呀」"), true);
});
