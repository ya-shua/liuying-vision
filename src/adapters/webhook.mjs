/**
 * 输出适配器：Webhook
 *
 * 每看一张图，POST 一份 JSON 到指定地址 —— 给任何其它系统接的通用口。
 * 响应 2xx 就算成功；失败只记录，不影响其它输出。
 */

/**
 * @param {object} item  { desc, points, url, key, sender, at }
 * @param {object} cfg   { url: 'http://…' }
 * @param {object} ctx   { fetchImpl }
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function deliver(item, cfg = {}, ctx = {}) {
  try {
    if (!cfg.url) throw new Error('webhook 输出没配 url');
    const fetchImpl = ctx.fetchImpl || fetch;
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'vision.seen',
        url: item.url,
        desc: item.desc,
        points: item.points,
        chatKey: item.key,
        sender: item.sender,
        at: item.at,
      }),
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
