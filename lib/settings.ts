import { browser } from 'wxt/browser';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type Settings } from './types';

const domainName = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');
const domain = z.string().transform(domainName).pipe(
  z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/),
);
let settingsWrites: Promise<unknown> = Promise.resolve();

const schema = z.object({
  aiEnabled: z.boolean(), queryEnabled: z.boolean().default(false), provider: z.enum(['compatible', 'workers-ai']),
  endpoint: z.string().trim().max(2000), model: z.string().trim().max(200),
  apiKey: z.string().trim().max(8000), accountId: z.string().trim().max(100),
  githubToken: z.string().trim().max(8000), retainContent: z.boolean(),
  blockedDomains: z.array(domain).max(500), floatingEnabled: z.boolean().default(true),
  revision: z.number().int().nonnegative(),
  semanticEnabled: z.boolean().default(false), localNotesSearch: z.boolean().default(false),
  embeddingEndpoint: z.string().trim().max(2000).default(''),
  embeddingModel: z.string().trim().max(200).default(''),
  embeddingApiKey: z.string().trim().max(8000).default(''),
  modelTimeoutSeconds: z.number().int().min(30).max(1800).default(DEFAULT_SETTINGS.modelTimeoutSeconds),
  queryTimeoutSeconds: z.number().int().min(60).max(3600).default(DEFAULT_SETTINGS.queryTimeoutSeconds),
}).strict().refine(value => value.queryTimeoutSeconds >= value.modelTimeoutSeconds, {
  message: '整轮查询超时不能小于单次模型请求超时。', path: ['queryTimeoutSeconds'],
});

export function endpointOrigin(settings: Settings): string {
  if (settings.provider === 'workers-ai') return 'https://api.cloudflare.com';
  const url = new URL(settings.endpoint);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('模型端点须使用 HTTPS；仅本机服务可使用 HTTP，且不能包含凭证、查询参数或片段。');
  }
  return url.origin;
}

export async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get('settings')).settings;
  const parsed = schema.safeParse({ ...DEFAULT_SETTINGS, ...(stored as object ?? {}) });
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

export function withCurrentSettings<T>(action: (settings: Settings) => Promise<T>): Promise<T> {
  const operation = settingsWrites.then(async () => action(await getSettings()));
  settingsWrites = operation.catch(() => undefined);
  return operation;
}

export async function saveSettings(input: Settings): Promise<Settings> {
  const settings = schema.parse(input);
  return withCurrentSettings(async current => {
    if (settings.aiEnabled || settings.queryEnabled) {
      if (!settings.apiKey || !settings.model) throw new Error('启用分析前请填写模型和 API Key。');
      if (settings.provider === 'workers-ai' && !/^[a-f\d]{32}$/i.test(settings.accountId)) throw new Error('请填写有效的 Cloudflare Account ID（32 位）。');
      if (!await browser.permissions.contains({ origins: [`${endpointOrigin(settings)}/*`] })) throw new Error('请先授权访问模型端点。');
    }
    if (settings.semanticEnabled) {
      if (!settings.embeddingEndpoint || !settings.embeddingModel) throw new Error('启用语义检索前请填写 Embedding 服务地址和模型。');
      const origin = endpointOrigin({ ...settings, provider: 'compatible', endpoint: settings.embeddingEndpoint });
      if (!await browser.permissions.contains({ origins: [`${origin}/*`] })) throw new Error('请先授权访问 Embedding 服务域名。');
    }
    if (settings.revision !== current.revision) throw new Error('设置已在其他页面更新，请重新加载后再保存。');
    settings.revision = current.revision + 1;
    await browser.storage.local.set({ settings });
    return settings;
  });
}

export function assertAllowed(url: string, settings: Settings, forAnalysis = true) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('仅支持不含登录凭证的 HTTP(S) 网页。');
  const hostname = domainName(parsed.hostname);
  if (forAnalysis && settings.blockedDomains.some(value => {
    const blocked = domainName(value);
    return hostname === blocked || hostname.endsWith(`.${blocked}`);
  })) {
    throw new Error('此域名已禁止 AI 分析，本地收藏仍可使用。');
  }
}
