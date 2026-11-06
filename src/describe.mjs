/**
 * 视觉模型的「眼睛」：把一张图变成她的记忆素材。
 *
 * 走 OpenAI 兼容的 chat/completions 接口（content 里塞 image_url），
 * 所以哪家都能接 —— 智谱 GLM-4V-Flash（免费）、阿里 Qwen-VL（dashscope 兼容模式）、
 * 或者任何自建网关，改 vision.json 的 baseUrl/model 就行，代码不挑食。
 *
 * 返回统一的形状：{ desc, points } ——
 *   desc   ≤60 字的客观描述（谁/什么/在做什么/图里有什么字）
 *   points 2~4 个要点（进记忆圈的拆点）
 *
 * 模型不给 JSON 也没关系：整个回复原文就当 desc，points 留空，
 * remember() 会替它按标点拆点 —— 内容永远是模型的，格式才是库的。
 */

const SYSTEM = [
  '你是记忆库的眼睛。看一张图，替记这条记忆的人把画面记下来。',
  '只输出一个 JSON 对象：',
  '{"desc":"一句话客观描述（60字内：谁/什么/在做什么/图里有什么文字）","points":["要点1","要点2","要点3"]}',
  '要点各 20 字内，最多 4 个，只写画面里确实有的东西，不要猜测和发挥。',
].join('\n');

/** 宽容地抠出 JSON：剥 ``` 围栏，取第一个 { 到最后一个 } */
function lenientJson(text) {
  const raw = String(text ?? '').trim();
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(raw.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** 模型报错翻译成人话：新用户看到 401 一串 JSON 是不知道该干嘛的 */
function friendlyModelError(status, body) {
  const raw = `（原始返回：${body}）`;
  if (status === 401) return `视觉模型 401 —— key 没填或不对。免费模型也要注册账号拿 key（默认 GLM-4V-Flash 在 open.bigmodel.cn 免费申请）${raw}`;
  if (status === 403) return `视觉模型 403 —— 这个 key 没有权限用该模型（换模型或去服务商后台看权限）${raw}`;
  if (status === 429) return `视觉模型 429 —— 触发限流了（免费档有每分钟上限；可以多加一条免费通道分摊）${raw}`;
  if (status === 404) return `视觉模型 404 —— 接口地址或模型名不对（检查 baseUrl 结尾别带 /chat/completions）${raw}`;
  return `视觉模型 ${status}：${body}`;
}

/**
 * 看一张图。
 * @param {object} p
 * @param {string} p.baseUrl    形如 https://open.bigmodel.cn/api/paas/v4（不带 /chat/completions）
 * @param {string} p.model      如 glm-4v-flash
 * @param {string} p.apiKey
 * @param {string} p.imageBase64 图片的 base64（不带 data: 前缀）
 * @param {string} [p.mime='image/jpeg']
 * @param {string} [p.hint='']   同一条消息里的文字（≤120字），帮模型对上语境
 * @param {Function} [p.fetchImpl] 测试注入用，默认全局 fetch
 * @param {number}  [p.timeoutMs=45000]
 * @returns {Promise<{desc: string, points: string[], model: string, raw: string}>}
 */
export async function describeImage(p) {
  const {
    baseUrl, model, apiKey,
    imageBase64, mime = 'image/jpeg',
    hint = '',
    fetchImpl = fetch,
    timeoutMs = 45000,
  } = p ?? {};

  if (!baseUrl || !model) throw new Error('模型接入没配全（baseUrl / model）');
  if (!imageBase64) throw new Error('没有图可看');

  const text = hint
    ? `这是聊天里刚出现的一张图。同条消息的文字：「${hint}」。看图，按要求输出 JSON。`
    : '看这张图，按要求输出 JSON。';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        // key 选填：本地/免费接口可不填 —— 空 = 不带鉴权头（参照 DeepSeek 的接法）
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: 300,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(friendlyModelError(res.status, body.slice(0, 160)));
  }

  const body = await res.json().catch(() => null);
  const raw = body?.choices?.[0]?.message?.content ?? '';
  const parsed = lenientJson(raw);

  const desc = String(parsed?.desc ?? raw).trim().slice(0, 120);
  const points = Array.isArray(parsed?.points)
    ? parsed.points.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
    : [];

  if (!desc) throw new Error('视觉模型回了空话');

  return { desc, points, model, raw, ms: Date.now() - t0, usage: body?.usage ?? null };
}
