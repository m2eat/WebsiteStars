import { browser } from 'wxt/browser';
import { z } from 'zod';
import { modelFetch } from './model-fetch';
import { endpointOrigin } from './settings';
import { DEFAULT_SETTINGS, type AvailableModel, type ModelConnection, type ModelList } from './types';

const connectionSchema = z.object({
  provider: z.enum(['compatible', 'workers-ai']), endpoint: z.string().trim().max(2000),
  apiKey: z.string().trim().max(8000), accountId: z.string().trim().max(100),
  modelTimeoutSeconds: z.number().int().min(30).max(1800),
}).strict();
const identifier = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型列表为空，请检查服务地址。');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('模型列表响应过大，请使用手动填写模型。');
      chunks.push(next.value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(data)); }
    catch { throw new Error('服务返回的模型列表不是有效 JSON，请检查 API 基础地址。'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function listModels(input: ModelConnection): Promise<ModelList> {
  const connection = connectionSchema.parse(input);
  if (connection.provider === 'workers-ai' && !/^[a-f\d]{32}$/i.test(connection.accountId)) throw new Error('请填写有效的 Cloudflare Account ID（32 位）。');
  const origin = endpointOrigin({ ...DEFAULT_SETTINGS, ...connection });
  if (!await browser.permissions.contains({ origins: [`${origin}/*`] })) throw new Error('请先授权访问模型服务域名。');
  const signal = AbortSignal.timeout(connection.modelTimeoutSeconds * 1000);
  const models = new Map<string, AvailableModel>();
  let truncated = false;
  for (let page = 1; page <= 5; page++) {
    const url = connection.provider === 'compatible'
      ? `${connection.endpoint.replace(/\/+$/, '')}/models`
      : `https://api.cloudflare.com/client/v4/accounts/${connection.accountId}/ai/models/search?task=Text%20Generation&per_page=100&page=${page}`;
    let response: Response;
    try {
      response = await modelFetch(url, { headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}, signal, redirect: 'error' });
    } catch {
      throw new Error(signal.aborted ? '获取模型列表超时，可调大单次请求超时后重试。' : '无法连接模型列表接口，请检查服务地址和网络。');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error('获取模型列表未获授权，请检查 API Key 和权限。');
      if ([404, 405].includes(response.status)) throw new Error('此服务未提供模型列表接口，可以继续手动填写模型名称。');
      if (response.status === 429) throw new Error('模型列表请求过于频繁，请稍后重试。');
      throw new Error(`获取模型列表失败（HTTP ${response.status}），请稍后重试。`);
    }
    let body: unknown;
    try { body = await readJson(response); }
    catch (error) { if (signal.aborted) throw new Error('获取模型列表超时，可调大单次请求超时后重试。'); throw error; }
    const root = z.object({ data: z.array(z.unknown()).optional(), result: z.array(z.unknown()).optional(), success: z.boolean().optional(), result_info: z.object({ total_pages: z.number().optional(), total_count: z.number().optional() }).optional() }).safeParse(body);
    if (!root.success || root.data.success === false) throw new Error('服务返回的模型列表格式无效，可以继续手动填写模型。');
    const entries = connection.provider === 'compatible' ? root.data.data : root.data.result;
    if (!entries) throw new Error('服务返回的模型列表格式无效，可以继续手动填写模型。');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const value = entry as Record<string, unknown>;
      const id = identifier.safeParse(connection.provider === 'workers-ai' ? value.name ?? value.id : value.id);
      if (!id.success) continue;
      const name = identifier.safeParse(value.name);
      if (models.size >= 1000) { truncated = true; break; }
      models.set(id.data, { id: id.data, name: name.success ? name.data : id.data });
    }
    if (connection.provider === 'compatible') { truncated ||= entries.length > 1000; break; }
    const totalPages = root.data.result_info?.total_pages;
    if (totalPages !== undefined ? page >= totalPages : entries.length < 100) break;
    if (page === 5) truncated = true;
  }
  return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated };
}
