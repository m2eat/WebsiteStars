import { browser } from 'wxt/browser';
import { sha256 } from './chunking';
import { modelFetch } from './model-fetch';
import { modelTimeoutMs } from './model-timeout';
import type { Settings } from './types';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 16 * 1024 * 1024;
const BATCH_SIZE = 16;
class EmbeddingError extends Error {}

function endpoint(settings: Settings): URL {
  let url: URL;
  try { url = new URL(settings.embeddingEndpoint.trim()); }
  catch { throw new EmbeddingError('请填写 Embedding 端点。'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new EmbeddingError('Embedding 端点须使用 HTTPS 或本机 HTTP，且不能包含凭证、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname.endsWith('/embeddings')) url.pathname += '/embeddings';
  return url;
}

export function embeddingKey(settings: Settings): string {
  let address = settings.embeddingEndpoint.trim();
  try { address = endpoint(settings).href; } catch { /* Incomplete settings still have a stable cache key. */ }
  return `embedding-v1:${sha256(JSON.stringify([address, settings.embeddingModel.trim()]))}`;
}

async function responseJson(response: Response, budget: { bytes: number }): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new EmbeddingError('Embedding 响应过大。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EmbeddingError('Embedding 响应格式无效。');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      budget.bytes += value.byteLength;
      if (size > MAX_RESPONSE_BYTES || budget.bytes > MAX_TOTAL_RESPONSE_BYTES) {
        throw new EmbeddingError('Embedding 响应过大。');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseVectors(value: unknown, count: number, expectedDimension?: number): number[][] {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)
    || value.data.length !== count) throw new EmbeddingError('Embedding 响应格式无效。');
  const result: number[][] = new Array(count);
  let dimensions = expectedDimension;
  for (const row of value.data) {
    if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= count || result[row.index]
      || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.length > 4096
      || !row.embedding.every((number: unknown) => typeof number === 'number' && Number.isFinite(number))) {
      throw new EmbeddingError('Embedding 向量格式无效。');
    }
    dimensions ??= row.embedding.length;
    if (dimensions !== row.embedding.length) throw new EmbeddingError('Embedding 向量维度不一致。');
    result[row.index] = row.embedding;
  }
  return result;
}

export async function embedTexts(texts: string[], settings: Settings, signal?: AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  if (!texts.length) return [];
  if (texts.length > 256 || texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 8000)
    || texts.reduce((size, text) => size + text.length, 0) > 256000) {
    throw new EmbeddingError('Embedding 输入超过大小限制或为空。');
  }
  const url = endpoint(settings);
  const model = settings.embeddingModel.trim();
  if (!model || model.length > 200) throw new EmbeddingError('请填写有效的 Embedding 模型名称。');
  const unique = [...new Set(texts)];
  const vectors = new Map<string, number[]>();
  const budget = { bytes: 0 };
  let dimensions: number | undefined;
  for (let start = 0; start < unique.length; start += BATCH_SIZE) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Embedding 请求超时。', 'TimeoutError')), modelTimeoutMs(settings));
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      requestSignal.throwIfAborted();
      if (!await browser.permissions.contains({ origins: [`${url.origin}/*`] })) {
        throw new EmbeddingError('请先授权访问 Embedding 端点。');
      }
      requestSignal.throwIfAborted();
      const input = unique.slice(start, start + BATCH_SIZE);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.embeddingApiKey) headers.Authorization = `Bearer ${settings.embeddingApiKey}`;
      const response = await modelFetch(url.href, {
        method: 'POST', headers, body: JSON.stringify({ model, input, encoding_format: 'float' }),
        signal: requestSignal, redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EmbeddingError(response.status === 401 || response.status === 403
          ? 'Embedding 授权失败，请检查访问权限和 API Key。' : 'Embedding 请求失败，请检查接口后重试。');
      }
      const parsed = parseVectors(await responseJson(response, budget), input.length, dimensions);
      requestSignal.throwIfAborted();
      dimensions ??= parsed[0]!.length;
      input.forEach((text, index) => vectors.set(text, parsed[index]!));
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Embedding 请求已取消。', 'AbortError');
      if (controller.signal.aborted) throw new DOMException('Embedding 请求超时。', 'TimeoutError');
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError('无法连接 Embedding 接口或响应格式无效，请检查设置后重试。');
    } finally { clearTimeout(timeout); }
  }
  return texts.map(text => [...vectors.get(text)!]);
}

export async function semanticQuery(query: string, settings: Settings, signal?: AbortSignal): Promise<number[]> {
  if (!settings.semanticEnabled) throw new EmbeddingError('请先启用语义检索。');
  return (await embedTexts([query], settings, signal))[0]!;
}
