/**
 * 留影 · 市面视觉模型目录（OpenAI 兼容、国内可直连的为主）
 *
 * 每条带 tier 分档：免费（全部收录）/ 性价比（选佼佼者）/ 高性能（选佼佼者）。
 * 面板下拉按档位分组，模型名前带厂商名。
 *
 * 只收录"填上 key 就能用"的；目录会过时：不在目录里的模型走「自定义」，
 * baseUrl/model 手填一样能用。延迟是参考量级，实际以网络和当时负载为准。
 */

export const MODELS = [
  // ── 免费（全部搬来）────────────────────────────
  {
    tier: '免费',
    id: 'glm-4v-flash',
    label: 'GLM-4V-Flash',
    vendor: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    latency: '低',
    keyUrl: 'https://open.bigmodel.cn',
    note: '免费档首选；有并发限速，个人用足够',
  },
  {
    tier: '免费',
    id: 'Qwen/Qwen2.5-VL-7B-Instruct',
    label: 'Qwen2.5-VL-7B',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    latency: '低',
    keyUrl: 'https://cloud.siliconflow.cn',
    note: '免费档；小模型，描述简短',
  },
  {
    tier: '免费',
    id: 'qwen/qwen2.5-vl-72b-instruct:free',
    label: 'Qwen2.5-VL-72B',
    vendor: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    latency: '中',
    keyUrl: 'https://openrouter.ai/keys',
    note: '免费档；限速较紧，凑并发通道用',
  },
  // ── 性价比（挑佼佼者）──────────────────────────
  {
    tier: '性价比',
    pick: true, // ← 同档佼佼者
    id: 'qwen-vl-plus',
    label: 'Qwen-VL-plus',
    vendor: '阿里',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    latency: '低',
    keyUrl: 'https://dashscope.console.aliyun.com',
    note: '同价位描述最稳，标杆款',
  },
  {
    tier: '性价比',
    id: 'doubao-1.5-vision-lite',
    label: '豆包 vision-lite',
    vendor: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    latency: '低',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '极便宜；模型 ID 以方舟控制台为准（可能带版本后缀）',
  },
  // ── 高性能（挑佼佼者）──────────────────────────
  {
    tier: '高性能',
    pick: true, // ← 同档佼佼者
    id: 'qwen-vl-max',
    label: 'Qwen-VL-Max',
    vendor: '阿里',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    latency: '中',
    keyUrl: 'https://dashscope.console.aliyun.com',
    note: '同系列最强，细节最全',
  },
  {
    tier: '高性能',
    id: 'glm-4v-plus-0111',
    label: 'GLM-4V-Plus',
    vendor: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    latency: '中',
    keyUrl: 'https://open.bigmodel.cn',
    note: '智谱旗舰视觉',
  },
];

/** 默认选择：免费的、延迟低的 */
export function defaultModel() {
  return MODELS.find((m) => m.tier === '免费' && m.latency === '低') || MODELS.find((m) => m.free) || MODELS[0];
}

/** 按 id 找目录条目 */
export function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

/** 语音转文字目录（OpenAI 兼容 /audio/transcriptions）—— 视频卡「声音转文字」的快捷选择 */
export const ASR_MODELS = [
  {
    tier: '免费',
    id: 'whisper-large-v3',
    label: 'Whisper large-v3',
    vendor: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    latency: '低',
    keyUrl: 'https://console.groq.com',
    note: '免费档额度大方，速度快',
  },
  {
    tier: '免费',
    id: 'FunAudioLLM/SenseVoiceSmall',
    label: 'SenseVoiceSmall',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    latency: '低',
    keyUrl: 'https://cloud.siliconflow.cn',
    note: '免费；中文识别好，自带标点',
  },
  {
    tier: '免费',
    id: 'whisper-large-v3',
    label: 'Whisper server（本机）',
    vendor: '本地',
    baseUrl: 'http://127.0.0.1:8080',
    latency: '看机器',
    keyUrl: '',
    note: '完全离线零 key；需本机起 whisper.cpp / faster-whisper server',
  },
];

/** 语音默认：免费的、延迟低的 */
export function defaultAsrModel() {
  return ASR_MODELS.find((m) => m.free && m.latency === '低') || ASR_MODELS[0];
}
