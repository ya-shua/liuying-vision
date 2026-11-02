/**
 * 留影 · 市面视觉模型目录（OpenAI 兼容、国内可直连的为主）
 *
 * 只收录"填上 key 就能用"的，每条都带：
 *   free      是否有免费档
 *   latency   参考识别延迟（量级：低/中 —— 实际以网络和当时负载为准，面板每次识别会记实测毫秒）
 *   keyUrl    在哪申请 key
 *
 * 目录会过时：不在目录里的模型走「自定义」，baseUrl/model 手填一样能用。
 */

export const MODELS = [
  {
    id: 'glm-4v-flash',
    label: 'GLM-4V-Flash（智谱）',
    vendor: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    free: true,
    latency: '低',
    keyUrl: 'https://open.bigmodel.cn',
    note: '免费档首选；有并发限速，个人用足够',
  },
  {
    id: 'glm-4v-plus-0111',
    label: 'GLM-4V-Plus（智谱）',
    vendor: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    free: false,
    latency: '中',
    keyUrl: 'https://open.bigmodel.cn',
    note: '收费；细节描述更稳',
  },
  {
    id: 'qwen-vl-plus',
    label: 'Qwen-VL-plus（阿里）',
    vendor: '阿里',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    free: false,
    latency: '低',
    keyUrl: 'https://dashscope.console.aliyun.com',
    note: '便宜稳定；新用户有免费额度',
  },
  {
    id: 'qwen-vl-max',
    label: 'Qwen-VL-Max（阿里）',
    vendor: '阿里',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    free: false,
    latency: '中',
    keyUrl: 'https://dashscope.console.aliyun.com',
    note: '同系列最强，慢一点',
  },
  {
    id: 'doubao-1.5-vision-lite',
    label: '豆包 vision-lite（火山）',
    vendor: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    free: false,
    latency: '低',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '很便宜；模型 ID 以方舟控制台为准（可能带版本后缀）',
  },
  {
    id: 'Qwen/Qwen2.5-VL-7B-Instruct',
    label: 'Qwen2.5-VL-7B（硅基流动）',
    vendor: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    free: true,
    latency: '低',
    keyUrl: 'https://cloud.siliconflow.cn',
    note: '免费档；小模型，描述简短 —— 凑第二条并发通道用',
  },
  {
    id: 'qwen/qwen2.5-vl-72b-instruct:free',
    label: 'Qwen2.5-VL-72B（OpenRouter）',
    vendor: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    free: true,
    latency: '中',
    keyUrl: 'https://openrouter.ai/keys',
    note: '免费档（:free 结尾）；限速较紧 —— 凑第三条并发通道用，以站点当前免费列表为准',
  },
];

/** 默认选择：免费的、延迟低的（目录里第一条满足 free && latency 低 的） */
export function defaultModel() {
  return MODELS.find((m) => m.free && m.latency === '低') || MODELS[0];
}

/** 按 id 找目录条目 */
export function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}
