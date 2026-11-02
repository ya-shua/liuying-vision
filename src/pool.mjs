/**
 * 留影 · 并发池：把一列任务分给 N 个"工人"并行跑,结果按原顺序返回。
 *
 * 工人数 = min(workers, items.length);每个工人串行处理分到的任务 ——
 * 用在多模型通道上:每条免费通道一个工人,互不抢限速,整体提速 = 通道数。
 */

export async function runPool(items, workers, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async (wid) => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], wid, i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  };
  const n = Math.max(1, Math.min(workers || 1, items.length));
  await Promise.all(Array.from({ length: n }, (_, wid) => worker(wid)));
  return results;
}
