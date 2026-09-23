import { describe, expect, it, vi } from 'vitest';
import { db, saveCapture } from '../lib/library';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';
import { runQueryAgent } from '../lib/agent';
import type { ChatStep } from '../lib/chat-types';

const state = vi.hoisted(() => ({ settings: {} as Settings, responses: [] as string[] }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: { get: vi.fn(async () => ({ settings: structuredClone(state.settings) })) } },
  permissions: { contains: vi.fn(async () => true) },
} }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: async (input: RequestInfo | URL, init?: RequestInit) => { const response = await fetch(input, init); void response.clone().text().then(text => state.responses.push(text)); return response; } }));

describe.skipIf(process.env.STARTS_LIVE_AGENT !== '1')('real local agent quality smoke test', () => {
  it('returns one source-backed result for each of three compared UI collections', async () => {
    await db.items.clear(); await db.sourceChunks.clear(); await db.sourceIndexes.clear(); await db.chunkVectors.clear();
    state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, endpoint: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen3:4b', modelTimeoutSeconds: 180, queryTimeoutSeconds: 300 };
    const sources = [
      { url: 'https://example.com/react-chat', title: 'React Chat Kit', description: 'React components for streaming chat interfaces and message history.' },
      { url: 'https://example.com/vue-chat', title: 'Vue Chat Kit', description: 'Vue and Nuxt components for AI chat interfaces.' },
      { url: 'https://example.com/agent-controls', title: 'Agent Controls', description: 'User interface components for tool calls, task progress and human approval.' },
    ];
    const saved = [];
    for (const source of sources) saved.push((await saveCapture(source)).item);
    const steps: ChatStep[] = [];
    const result = await runQueryAgent({ settings: state.settings, question: '把这三个 UI 收藏逐个列出来，比较分别适合什么场景，每个都附上收藏引用。', history: [], signal: AbortSignal.timeout(300000), assertActive: async () => undefined, onText: async () => undefined, onPhase: async () => undefined, onStep: async step => { steps.push(step); } }).catch(error => { console.log('Comparison steps:', steps.map(step => step.tool), 'Last response:', state.responses.at(-1)?.slice(-1500)); throw error; });
    console.log(JSON.stringify({ scenario: 'compare three synthetic UI sources', tools: steps.map(step => step.tool), answer: result.text, citations: result.citations.map(citation => ({ title: citation.title, quote: citation.quote })) }, null, 2));
    expect(result.citations.map(citation => citation.itemId).sort()).toEqual(saved.map(item => item.id).sort());
    expect(result.citations.every(citation => citation.kind === 'capability')).toBe(true);
  }, 310000);

  it('selects only two WeChat sources from twelve saved tools', async () => {
    await db.items.clear(); await db.sourceChunks.clear(); await db.sourceIndexes.clear(); await db.chunkVectors.clear();
    state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, endpoint: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen3:4b', modelTimeoutSeconds: 180, queryTimeoutSeconds: 360 };
    const descriptions = [
      ['WeChat Reply Assistant', 'A macOS WeChat assistant that drafts replies. The user must manually send each message; automatic replies are not supported.'],
      ['WeChat Protocol Toolkit', 'A toolkit for WeChat protocol integrations with message receiving and sending APIs. It is not a ready-made automatic reply bot.'],
      ['React Chat UI', 'React components for AI chat interfaces, with no WeChat integration.'],
      ['Vue Chat UI', 'Vue components for AI chat interfaces, with no WeChat integration.'],
      ['Slack Bot', 'An automatic reply bot for Slack, not WeChat.'],
      ['Telegram Bot', 'An automatic reply bot for Telegram, not WeChat.'],
      ['Document Search', 'A local knowledge base for document retrieval.'],
      ['Browser Forms', 'Browser automation for filling forms and extracting data.'],
      ['Terminal UI', 'React components for command-line terminal interfaces.'],
      ['Vector Database', 'A database for semantic embeddings.'],
      ['Task Queue', 'An asynchronous background task scheduler.'],
      ['OCR Reader', 'Extracts text from images and has no messaging integration.'],
    ];
    const saved = [];
    for (const [index, [title, description]] of descriptions.entries()) saved.push((await saveCapture({ url: `https://example.com/wechat-test-${index}`, title, description })).item);
    const steps: ChatStep[] = [];
    const start = Date.now();
    const result = await runQueryAgent({ settings: state.settings, question: '找出与微信机器人相关的收藏，说明是辅助回复还是可直接自动回复，其他平台和通用聊天界面不要。', history: [], signal: AbortSignal.timeout(360000), assertActive: async () => undefined, onText: async () => undefined, onPhase: async () => undefined, onStep: async step => { steps.push(step); } });
    console.log(JSON.stringify({ scenario: '12 candidates, 2 WeChat sources', elapsedMs: Date.now() - start, answer: result.text, selected: result.citations.map(citation => citation.title), tools: steps.map(step => step.tool) }, null, 2));
    expect(result.citations.map(citation => citation.itemId).sort()).toEqual(saved.slice(0, 2).map(item => item.id).sort());
    expect(result.text).toMatch(/手动|人工/);
    expect(result.text).toMatch(/不是|不支持|不能|并非|不直接|需.*开发/);
  }, 370000);

  it('finds an English browser automation source from a Chinese functional description', async () => {
    await db.items.clear(); await db.sourceChunks.clear(); await db.sourceIndexes.clear(); await db.chunkVectors.clear();
    state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, endpoint: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen3:4b', modelTimeoutSeconds: 120, queryTimeoutSeconds: 300 };
    const target = await saveCapture({ url: 'https://example.com/pagepilot', title: 'PagePilot', description: 'An AI agent that automates browser interactions and fills forms.', content: '# Capabilities\n\nNavigate websites, click buttons, fill forms and extract structured information from pages.' });
    await saveCapture({ url: 'https://example.com/console', title: 'ConsoleCanvas', description: 'A React renderer for interactive terminal user interfaces.', content: '# Capabilities\n\nBuild keyboard-driven command-line interfaces with TypeScript components.' });
    await saveCapture({ url: 'https://example.com/storage', title: 'EdgePocket', description: 'A durable SQL database for edge applications.', content: '# Capabilities\n\nStore relational application data with SQLite.' });
    const steps: ChatStep[] = [];
    const start = Date.now();
    const result = await runQueryAgent({ settings: state.settings, question: '我记得收藏过一个可以自己打开网页然后填写表单的工具，帮我找出来。', history: [], signal: AbortSignal.timeout(300000), assertActive: async () => undefined, onText: async () => undefined, onPhase: async () => undefined, onStep: async step => { steps.push(step); } }).catch(error => { console.log('Actual model tool response on failure:', state.responses.at(-1)); throw error; });
    console.log(JSON.stringify({ model: state.settings.model, elapsedMs: Date.now() - start, answer: result.text, citations: result.citations.map(citation => ({ title: citation.title, quote: citation.quote })), tools: steps.map(step => step.tool), inputTokens: result.inputTokens, outputTokens: result.outputTokens }, null, 2));
    expect(result.citations.some(citation => citation.itemId === target.item.id)).toBe(true);
    expect(result.text).toMatch(/[\u3400-\u9fff]/u);
    expect(result.citations[0]?.reason).toMatch(/[\u3400-\u9fff]/u);
    expect(result.citations[0]?.quote).not.toMatch(/[\u3400-\u9fff]/u);
    expect(result.citations.every(citation => citation.kind !== 'identity')).toBe(true);
  }, 310000);
});
