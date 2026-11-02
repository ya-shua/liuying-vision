/**
 * 从消息文本里提取媒体地址（图片 + 视频）。
 *
 * OneBot/CQ 风格的消息里媒体长这样（file 直接是网址 / url 键两种都认）：
 *   [CQ:image,file=https://…jpg]
 *   [CQ:video,file=https://…mp4]
 *
 * extractMedia 返回 { images, videos } 两类去重地址；
 * 调用方也可以不用 CQ 抽取、直接给 images/videos 数组（输入中立）。
 */

const CQ_IMAGE = /\[CQ:image,[^\]]*\]/g;
const CQ_VIDEO = /\[CQ:video,[^\]]*\]/g;
const KV = /([a-zA-Z_]+)=([^,\]]+)/g;

function urlsFrom(text, re) {
  const out = [];
  if (!text) return out;
  for (const code of String(text).match(re) ?? []) {
    const kv = {};
    for (const m of code.matchAll(KV)) kv[m[1].toLowerCase()] = m[2].trim();
    const url = kv.url || kv.file || '';
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** 图片 + 视频一起抽（互不混列） */
export function extractMedia(text) {
  return {
    images: urlsFrom(text, CQ_IMAGE),
    videos: urlsFrom(text, CQ_VIDEO),
  };
}

/** 只抽图片（兼容旧调用） */
export function extractImageUrls(text) {
  return extractMedia(text).images;
}

/** 把文本里的 CQ 码抹掉，留干净文字（给视觉模型当上下文提示用） */
export function stripCq(text) {
  return String(text ?? '').replace(CQ_IMAGE, '[图片]').replace(CQ_VIDEO, '[视频]').trim();
}
