import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, saveCapture, updateItem } from '../lib/library';
import type { AgentHistoryTurn, ChatStep } from '../lib/chat-types';
import { LocalRetrievalService } from '../lib/retrieval';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';

const state = vi.hoisted(() => ({ settings: {} as Settings, granted: true }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: { get: vi.fn(async () => ({ settings: structuredClone(state.settings) })) } },
  permissions: { contains: vi.fn(async () => state.granted) },
} }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
import { runQueryAgent, testQueryConnection, type RunQueryAgentOptions } from '../lib/agent';

interface Call { name: string; input: unknown; fragments?: string[] }
interface Reply { calls?: Call[]; text?: string; reasoning?: string }
interface ModelRequest {
  model: string; stream: boolean; tool_choice: unknown;
  messages: { role: string; content: unknown; tool_calls?: unknown[] }[];
  tools: { function: { name: string } }[];
}
function sse(reply: Reply): Response {
  const frame = (delta: unknown, finish: string | null = null) => JSON.stringify({
    id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events = [frame({ role: 'assistant' })];
  if (reply.reasoning) events.push(frame({ reasoning_content: reply.reasoning }));
  if (reply.text) events.push(frame({ content: reply.text }));
  for (const [index, call] of (reply.calls ?? []).entries()) {
    const input = JSON.stringify(call.input);
    const mid = Math.floor(input.length / 2);
    const fragments = call.fragments ?? [input.slice(0, mid), input.slice(mid)];
    for (const [part, fragment] of fragments.entries()) {
      events.push(frame({ tool_calls: [{ index, ...(part === 0 ? { id: `call-${index}`, type: 'function' } : {}),
        function: { ...(part === 0 ? { name: call.name } : {}), arguments: fragment } }] }));
    }
  }
  events.push(frame({}, reply.calls?.length ? 'tool_calls' : 'stop'));
  events.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  return new Response(`${events.map(event => `data: ${event}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function streamingPresentation() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let started = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; }, cancel() { closed = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const frame = (delta: unknown, finish: string | null = null) => {
    if (!closed) writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
      id: 'live-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`));
  };
  return {
    response,
    push(fragment: string) {
      frame({ tool_calls: [{ index: 0, ...(!started ? { id: 'live-answer', type: 'function' } : {}),
        function: { ...(!started ? { name: 'present_results' } : {}), arguments: fragment } }] });
      started = true;
    },
    finish() {
      if (closed) return;
      frame({}, 'tool_calls');
      writer.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      writer.close(); closed = true;
    },
  };
}
function provider(replies: (Reply | ((request: ModelRequest) => Promise<Response>))[]) {
  const requests: ModelRequest[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ModelRequest;
    requests.push(request);
    const reply = replies[requests.length - 1];
    if (!reply) throw new Error('Unexpected additional model request');
    return typeof reply === 'function' ? reply(request) : sse(reply);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, requests };
}
function options(patch: Partial<RunQueryAgentOptions> = {}) {
  const steps: ChatStep[] = [];
  const text: string[] = [];
  const phases: string[] = [];
  const args: RunQueryAgentOptions = {
    settings: structuredClone(state.settings), question: '那个能把文档做成知识库的项目', history: [],
    signal: new AbortController().signal, assertActive: vi.fn(async () => undefined),
    onText: async chunk => { text.push(chunk); },
    onStep: async step => { steps.push(step); }, onPhase: async phase => { phases.push(phase); }, ...patch,
  };
  return { args, steps, text, phases };
}
const search = (queries: string[]): Reply => ({ calls: [{ name: 'search_library', input: { queries } }] });
const finish = (itemId?: string, quote = 'document knowledge base'): Reply => ({
  calls: [{ name: 'present_results', input: {
    answer: itemId ? '找到符合条件的收藏。' : '没有找到匹配的收藏。',
    results: itemId ? [{ itemId, quote, reason: '支持文档知识库' }] : [],
  } }],
});

beforeEach(async () => {
  await db.items.clear();
  await db.jobs.clear();
  state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, apiKey: 'test-only-key', model: 'test-model', revision: 1 };
  state.granted = true;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('real ToolLoopAgent with OpenAI-compatible streaming', () => {
  it('runs model-directed bilingual searches, reads relevant content, streams only the final answer and validates results', async () => {
    const { item } = await saveCapture({
      url: 'https://example.com/project', title: 'Document project', description: 'document knowledge base',
      content: `${'Introduction. '.repeat(800)}Tencent provides hybrid retrieval and reranking.`, selection: 'PRIVATESELECTION',
    });
    await updateItem(item.id, { notes: 'PRIVATENOTE', summaryOverride: 'PRIVATEOVERRIDE', tagsOverride: ['PRIVATETAG'] });
    const { fetcher, requests } = provider([
      search(['完全无匹配的中文词']),
      { ...search(['document knowledge base', 'Tencent RAG']), text: '我会检查候选资料中的说明。', reasoning: 'PRIVATE_REASONING_TOKEN' },
      { calls: [{ name: 'read_item', input: { itemId: item.id, query: 'hybrid retrieval reranking' } }] },
      { ...finish(item.id, 'Tencent provides hybrid retrieval and reranking.'), text: '这是过程说明，不是最终答案。' },
    ]);
    const { args, steps, text, phases } = options();
    const result = await runQueryAgent(args);
    expect(result).toMatchObject({
      text: '找到符合条件的收藏。', inputTokens: 80, outputTokens: 40,
      citations: [{ itemId: item.id, quote: 'Tencent provides hybrid retrieval and reranking.', contentVersion: 1 }],
    });
    expect(steps.map(step => step.tool)).toEqual(['browse_library', 'search_library', 'search_library', 'read_item', 'present_results']);
    expect(steps[1]?.resultIds).toEqual([]);
    expect(steps[2]?.resultIds).toEqual([item.id]);
    expect(steps.every(step => step.durationMs >= 0 && !!step.at && !!step.label)).toBe(true);
    expect(text.join('')).toBe(result.text);
    expect(text.join('')).not.toMatch(/检查候选资料|过程说明/);
    expect(JSON.stringify({ result, steps, text, phases, requests })).not.toMatch(/PRIVATESELECTION|PRIVATENOTE|PRIVATEOVERRIDE|PRIVATETAG|PRIVATE_REASONING_TOKEN/);
    expect(requests[0]?.messages.some(message => String(message.content).includes(item.id))).toBe(true);
    expect(requests[0]?.tools.map(entry => entry.function.name).sort()).toEqual(['browse_library', 'get_library_facets', 'present_results', 'read_item', 'read_items', 'search_library']);
    expect(requests[0]?.tool_choice).toBe('required');
    const system = requests[0]!.messages.find(message => message.role === 'system')!.content;
    expect(system).not.toMatch(/[\u3400-\u9fff]/u);
    expect(String(system)).toContain("language of the user's current question");
    expect(String(system)).toContain('never translate evidence quotes');
    expect(JSON.stringify(requests[0]!.tools)).not.toMatch(/[\u3400-\u9fff]/u);
    expect(String(requests[0]!.messages.find(message => message.role === 'user')!.content)).toContain(args.question);
    expect(requests[2]?.messages.some(message => message.role === 'tool')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error' && !!init.signal)).toBe(true);
    expect(args.assertActive).toHaveBeenCalled();
  });

  it('reads selected candidates in one batch and publishes only the chosen results in order', async () => {
    const saved = [];
    for (let i = 0; i < 12; i++) saved.push((await saveCapture({ url: `https://example.com/candidate-${i}`, title: `Tool ${i}`, content: 'document knowledge base with messaging' })).item);
    const picked = [saved[9]!, saved[1]!];
    const { requests } = provider([
      search(['document knowledge']),
      { calls: [{ name: 'read_items', input: { itemIds: picked.map(item => item.id), query: 'messaging' } }] },
      async request => {
        const sources = JSON.parse(String(request.messages.filter(message => message.role === 'tool').at(-1)!.content)).items;
        return sse({ calls: [{ name: 'present_results', input: { answer: '找到两个匹配的收藏。', results: sources.map((source: { itemId: string; snippetIds: string[] }) => ({ itemId: source.itemId, evidenceId: source.snippetIds[0], reason: '来源明确支持消息功能' })) } }] });
      },
    ]);
    const { args, steps } = options();
    const result = await runQueryAgent(args);
    expect(steps.find(step => step.tool === 'search_library')?.resultIds).toHaveLength(12);
    expect(result.citations.map(citation => citation.itemId)).toEqual(picked.map(item => item.id));
    expect(requests).toHaveLength(3);
  });

  it('preserves the topic when a follow-up is sent to semantic retrieval', async () => {
    const saved = await saveCapture({ url: 'https://example.com/chat', description: 'messaging document knowledge base' });
    await db.items.update(saved.item.id, { github: { owner: 'fixture', repo: 'chat', language: 'TypeScript', license: '', topics: [], stars: 0, fetchedAt: '' } });
    const searchSpy = vi.spyOn(LocalRetrievalService.prototype, 'search');
    const { requests } = provider([search(['messaging']), finish(saved.item.id)]);
    await runQueryAgent(options({ question: '只看 TypeScript 的', history: [{ question: '找微信机器人', answer: '', itemIds: [saved.item.id] }] }).args);
    const prompt = JSON.parse(String(requests[0]!.messages.find(message => message.role === 'user')!.content));
    expect(prompt.context.retrievalQuestion).toContain('找微信机器人');
    expect(searchSpy.mock.calls[0]?.[0].question).toContain('找微信机器人');
  });

  it('reuses identical retrieval and read calls without rebuilding their evidence', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/cache', content: 'document knowledge base' });
    const searchSpy = vi.spyOn(LocalRetrievalService.prototype, 'search');
    const readSpy = vi.spyOn(LocalRetrievalService.prototype, 'read');
    provider([
      { calls: [{ name: 'search_library', input: { queries: ['document'] } }, { name: 'search_library', input: { queries: ['document'] } }] },
      { calls: [{ name: 'read_item', input: { itemId: item.id, query: 'document' } }, { name: 'read_item', input: { itemId: item.id, query: 'document' } }] },
      finish(item.id),
    ]);
    expect((await runQueryAgent(options().args)).citations).toHaveLength(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('reserves the last steps for submission and citation correction', async () => {
    const { requests } = provider([
      ...Array.from({ length: 4 }, () => ({ calls: [{ name: 'get_library_facets', input: {} }] })),
      finish(),
    ]);
    await runQueryAgent(options().args);
    expect(requests[4]!.tools.map(tool => tool.function.name)).toEqual(['present_results']);
    expect(requests[4]!.tool_choice).toEqual({ type: 'function', function: { name: 'present_results' } });
  });

  it('compares multiple returned sources through the real reranking tool', async () => {
    const first = await saveCapture({ url: 'https://example.com/one', title: 'One', content: 'document knowledge base for teams' });
    const second = await saveCapture({ url: 'https://example.com/two', title: 'Two', content: 'document knowledge base for solo users' });
    const { requests } = provider([
      search(['document knowledge base']),
      { calls: [{ name: 'rerank_candidates', input: { query: '团队文档知识库', itemIds: [first.item.id, second.item.id] } }] },
      { calls: [{ name: 'rank_results', input: { rankings: [
        { itemId: first.item.id, relevance: 'strong', reason: 'source explicitly says teams' },
        { itemId: second.item.id, relevance: 'partial', reason: 'source says solo users' },
      ] } }] },
      finish(first.item.id, 'document knowledge base for teams'),
    ]);
    const { args, steps } = options({ question: '适合团队的知识库' });
    const result = await runQueryAgent(args);
    expect(result.citations[0]?.itemId).toBe(first.item.id);
    expect(steps.some(step => step.tool === 'rerank_candidates')).toBe(true);
    expect(requests).toHaveLength(4);
    expect(String(requests[2]!.messages.find(message => message.role === 'system')!.content)).not.toMatch(/[\u3400-\u9fff]/u);
    expect(String(requests[2]!.messages.find(message => message.role === 'user')!.content)).toContain('适合团队的知识库');
    expect(result.inputTokens).toBe(80);
  });

  it('enforces an explicit exclusion from previous candidates through final presentation', async () => {
    const saved = await saveCapture({ url: 'https://example.com/excluded', title: 'Old result', content: 'document knowledge base' });
    provider([finish(saved.item.id)]);
    await expect(runQueryAgent(options({ question: '不要第一个', history: [{ question: '找文档知识库', answer: '', itemIds: [saved.item.id] }] }).args)).rejects.toThrow('排除');
  });

  it('accepts empty results and a useful clarification after searching', async () => {
    provider([search(['notfound']), { calls: [{ name: 'present_results', input: {
      answer: '', results: [], clarification: '你记得它使用哪种语言吗？',
    } }] }]);
    const { args, text } = options();
    await expect(runQueryAgent(args)).resolves.toMatchObject({ text: '你记得它使用哪种语言吗？', citations: [] });
    expect(text.join('')).toBe('你记得它使用哪种语言吗？');
  });

  it('excludes blocked, private, and unverified GitHub data in real provider requests', async () => {
    state.settings.blockedDomains = ['blocked.example'];
    const { item: allowed } = await saveCapture({ url: 'https://example.com/open', content: 'document knowledge base' });
    await saveCapture({ url: 'https://blocked.example/a', title: 'BLOCKEDSECRET', content: 'document knowledge base' });
    const { item: hidden } = await saveCapture({ url: 'https://github.com/org/private', title: 'PRIVATESECRET', content: 'document knowledge base', source: 'article' });
    await db.items.update(hidden.id, { githubVisibility: 'private' });
    await saveCapture({ url: 'https://github.com/org/unverified', title: 'UNVERIFIEDSECRET', content: 'document knowledge base', source: 'docs' });
    const { requests } = provider([search(['document knowledge']), finish(allowed.id)]);
    const result = await runQueryAgent(options().args);
    expect(result.citations.map(citation => citation.itemId)).toEqual([allowed.id]);
    expect(JSON.stringify(requests)).not.toMatch(/BLOCKEDSECRET|PRIVATESECRET|UNVERIFIEDSECRET/);
  });

  it.each(['forged', 'unreturned', 'unknown-id'])('rejects %s citations instead of showing invented cards', async mode => {
    const { item } = await saveCapture({
      url: 'https://example.com/proof', title: 'document knowledge base',
      description: 'document knowledge base', content: `${'Unrelated. '.repeat(500)}Unreturned secret evidence`,
    });
    const quote = mode === 'unreturned' ? 'Unreturned secret evidence' : mode === 'forged' ? 'fabricated product feature' : 'document knowledge base';
    const { fetcher } = provider([search(['document knowledge']), finish(mode === 'unknown-id' ? 'invented-id' : item.id, quote), finish(mode === 'unknown-id' ? 'invented-id' : item.id, quote)]);
    const { args, text, steps } = options();
    await expect(runQueryAgent(args)).rejects.toThrow('引用校验');
    expect(text.join('')).toBe('找到符合条件的收藏。');
    expect(text.join('')).not.toContain(quote);
    expect(steps.some(step => step.tool === 'present_results')).toBe(false);
    expect(steps.find(step => step.tool === 'repair_citations')?.resultIds).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('lets the model correct an invalid quote once using a returned evidence ID', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/repair', description: 'document knowledge base' });
    const { requests } = provider([
      search(['document knowledge']), finish(item.id, 'translated unsupported quote'),
      async request => {
        const toolOutputs = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(String(message.content)));
        expect(toolOutputs.at(-1)).toMatchObject({ accepted: false });
        expect(JSON.stringify(toolOutputs.at(-1))).not.toMatch(/[\u3400-\u9fff]/u);
        expect(toolOutputs.at(-1).instruction).toContain("user's question language");
        const source = toolOutputs.find(output => output.items)?.items[0];
        return sse({ calls: [{ name: 'present_results', input: { answer: '修正后：来源说明它是文档知识库。', results: [{ itemId: item.id, evidenceId: source.snippetIds[0], reason: '原文依据' }] } }] });
      },
    ]);
    const { args, text, steps } = options();
    const result = await runQueryAgent(args);
    expect(result.text).toBe('修正后：来源说明它是文档知识库。');
    expect(result.citations).toMatchObject([{ itemId: item.id, quote: 'document knowledge base' }]);
    expect(text.join('')).not.toContain('修正后');
    expect(steps.find(step => step.tool === 'repair_citations')?.resultIds).toEqual([]);
    expect(requests).toHaveLength(3);
  });

  it('rejects arbitrary item reads and invalid tool arguments', async () => {
    await saveCapture({ url: 'https://example.com/not-searched', content: 'private candidate' });
    provider([search(['missing']), { calls: [{ name: 'read_item', input: { itemId: 'unknown-candidate', query: 'candidate' } }] }]);
    await expect(runQueryAgent(options().args)).rejects.toThrow('只能读取');
    provider([{ calls: [{ name: 'search_library', input: { queries: ['a'], arbitraryField: 'bad' } }] }]);
    await expect(runQueryAgent(options().args)).rejects.toThrow(/调用支持|返回格式/);
  });

  it('bounds history and rehydrates allowed IDs without resending past assistant prose', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/current', title: 'Current source', content: 'document knowledge base' });
    const history: AgentHistoryTurn[] = Array.from({ length: 8 }, (_, index) => ({
      question: `previous question ${index}`, answer: 'DELETED_ASSISTANT_CONTENT', itemIds: [item.id, 'deleted-id'],
    }));
    const { requests } = provider([search(['document']), finish(item.id)]);
    await runQueryAgent(options({ history }).args);
    const prompt = String(requests[0]?.messages.find(message => message.role === 'user')?.content);
    expect(prompt).not.toMatch(/DELETED_ASSISTANT_CONTENT|deleted-id|previous question 0|previous question 1/);
    expect(prompt).toContain('previous question 2');
    expect(prompt).toContain('Current source');
  });
});

describe('final answer argument streaming', () => {
  it('emits Markdown in arrival order before the tool JSON completes and appends clarification at the end', async () => {
    const live = streamingPresentation();
    const { requests } = provider([search(['missing']), async () => live.response]);
    const { args, text, steps } = options();
    let completed = false;
    const pending = runQueryAgent(args).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    live.push('{"answer":"  ## 标题\\n\\n**');
    await vi.waitFor(() => expect(text.join('')).toBe('## 标题\n\n**'));
    expect(completed).toBe(false);
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库')).map(step => step.tool)).toEqual(['search_library']);
    live.push('重点**\\n下一行\\u6807');
    await vi.waitFor(() => expect(text.join('')).toBe('## 标题\n\n**重点**\n下一行标'));
    live.push('\\u9898  ","results":[],"clarification":"还记得其他信息吗？"}');
    await vi.waitFor(() => expect(text.join('')).toBe('## 标题\n\n**重点**\n下一行标题'));
    expect(completed).toBe(false);
    live.finish();
    const result = await pending;
    expect(result.text).toBe('## 标题\n\n**重点**\n下一行标题\n\n还记得其他信息吗？');
    let prefix = '';
    for (const delta of text) { prefix += delta; expect(result.text.startsWith(prefix)).toBe(true); }
    expect(prefix).toBe(result.text);
    expect(text.at(-1)).toBe('\n\n还记得其他信息吗？');
    expect(requests.every(request => request.tools.length > 0)).toBe(true);
  });

  it('stops a partial answer without publishing later deltas or executing the final tool', async () => {
    const live = streamingPresentation();
    const controller = new AbortController();
    const { requests } = provider([search(['missing']), async () => live.response]);
    const { args, text, steps } = options({ signal: controller.signal });
    const pending = runQueryAgent(args);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    live.push('{"answer":"已到达的内容');
    await vi.waitFor(() => expect(text.join('')).toBe('已到达的内容'));
    controller.abort();
    live.push('不能出现","results":[],"clarification":"不能出现"}');
    live.finish();
    await rejected;
    expect(text.join('')).toBe('已到达的内容');
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库')).map(step => step.tool)).toEqual(['search_library']);
  });

  it('fails incomplete final JSON after streaming only its available answer prefix', async () => {
    provider([search(['missing']), { calls: [{ name: 'present_results', input: {}, fragments: [
      '{"answer":"## Partial\\n\\n**body**',
    ] }] }]);
    const { args, text, steps } = options();
    await expect(runQueryAgent(args)).rejects.toThrow(/调用支持|返回格式/);
    expect(text.join('')).toBe('## Partial\n\n**body**');
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库')).map(step => step.tool)).toEqual(['search_library']);
  });

  it('rejects an oversized streamed answer without delivering more than 6000 characters', async () => {
    provider([search(['missing']), { calls: [{ name: 'present_results', input: {}, fragments: [
      `{"answer":"${'a'.repeat(6000)}`, 'b","results":[]}',
    ] }] }]);
    const { args, text, steps } = options();
    await expect(runQueryAgent(args)).rejects.toThrow();
    expect(text.join('')).toHaveLength(6000);
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库')).map(step => step.tool)).toEqual(['search_library']);
  });

  it('does not stream nested answer fields or reference JSON from invalid tool input', async () => {
    provider([search(['missing']), { calls: [{ name: 'present_results', input: {}, fragments: [
      '{"results":[{"answer":"PRIVATE_NESTED","quote":"PRIVATE_QUOTE"}],',
      '"answer":"Visible answer"}',
    ] }] }]);
    const { args, text } = options();
    await expect(runQueryAgent(args)).rejects.toThrow(/调用支持|返回格式/);
    expect(text.join('')).toBe('Visible answer');
  });
});

describe('run lifecycle and budgets', () => {
  it.each(['delete', 'update'])('rejects a %s before the late final model response is accepted', async mode => {
    const { item } = await saveCapture({ url: 'https://example.com/changed', content: 'document knowledge base' });
    provider([search(['document']), async () => {
      if (mode === 'delete') await db.items.delete(item.id);
      else await db.items.update(item.id, { content: 'changed content', contentVersion: 2 });
      return sse(finish(item.id));
    }]);
    await expect(runQueryAgent(options().args)).rejects.toThrow(/删除|更新/);
  });

  it('rechecks after final presentation callbacks, before returning citations', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/final', content: 'document knowledge base' });
    provider([search(['document']), finish(item.id)]);
    await expect(runQueryAgent(options({
      onPhase: async phase => { if (phase === '查询完成') await db.items.delete(item.id); },
    }).args)).rejects.toThrow(/删除|更新/);
  });

  it.each(['revision', 'disabled', 'blocked', 'permission', 'inactive'])(
    'stops before another request after %s changes', async change => {
      const { fetcher } = provider([search(['none']), finish()]);
      let inactive = false;
      const { args } = options({
        assertActive: async () => { if (inactive) throw new DOMException('Inactive', 'AbortError'); },
        onStep: async step => {
          if (step.tool === 'browse_library') return;
          if (change === 'revision') state.settings.revision++;
          if (change === 'disabled') state.settings.queryEnabled = false;
          if (change === 'blocked') state.settings.blockedDomains = ['example.com'];
          if (change === 'permission') state.granted = false;
          if (change === 'inactive') inactive = true;
        },
      });
      await expect(runQueryAgent(args)).rejects.toThrow(/变更|关闭|权限|停止/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a model that ignores the final submission tool restriction', async () => {
    const { fetcher } = provider(Array.from({ length: 7 }, () => ({ calls: [{ name: 'get_library_facets', input: {} }] })));
    const { args, steps } = options();
    await expect(runQueryAgent(args)).rejects.toThrow(/工具调用|返回格式/);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库'))).toHaveLength(4);
  });

  it('limits parallel model tool calls to twelve executions', async () => {
    const { fetcher } = provider([{ calls: Array.from({ length: 13 }, () => ({ name: 'get_library_facets', input: {} })) }]);
    const { args, steps } = options();
    await expect(runQueryAgent(args)).rejects.toThrow('12 次工具调用');
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库'))).toHaveLength(12);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight network request and prevents late tool execution', async () => {
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        networkSignal?.addEventListener('abort', () => reject(networkSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const { args, steps } = options({ signal: controller.signal });
    const pending = runQueryAgent(args);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    expect(networkSignal?.aborted).toBe(true);
    expect(steps.filter(step => !step.label.startsWith('已阅读小资料库'))).toEqual([]);
  });

  it('bounds each query step by the configured model timeout', async () => {
    state.settings.modelTimeoutSeconds = 60;
    state.settings.queryTimeoutSeconds = 240;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true }));
    });
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(runQueryAgent(options().args)).rejects.toThrow(/停止|超时/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(59900);
    expect(networkSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(networkSignal?.aborted).toBe(true);
  });

  it('enforces the configured total query deadline across multiple model steps', async () => {
    state.settings.modelTimeoutSeconds = 60;
    state.settings.queryTimeoutSeconds = 90;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let completeFirst!: (value: Response) => void;
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        completeFirst ??= resolve;
        networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(runQueryAgent(options().args)).rejects.toThrow(/停止|超时/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50000);
    completeFirst(sse(search(['missing'])));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(39000);
    expect(networkSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(networkSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not access the provider when already stopped or query is disabled', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    await expect(runQueryAgent(options({ signal: controller.signal }).args)).rejects.toMatchObject({ name: 'AbortError' });
    state.settings.queryEnabled = false;
    await expect(runQueryAgent(options().args)).rejects.toThrow('关闭');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sanitizes provider errors without retrying or logging request payloads', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => new Response('SECRET_PROVIDER_PAYLOAD', { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(runQueryAgent(options().args)).rejects.toThrow('HTTP 429');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: SECRET_INVALID_PAYLOAD\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    await expect(runQueryAgent(options().args)).rejects.toThrow(/调用支持|返回格式/);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('tool capability probe and provider routing', () => {
  it('uses a minimal real tool probe without opening the library or enabling automatic analysis', async () => {
    const load = vi.spyOn(db.items, 'toArray');
    const get = vi.spyOn(db.items, 'get');
    const { fetcher, requests } = provider([{ calls: [{ name: 'probe', input: { nonce: 'starts-tool-probe' } }] }]);
    await expect(testQueryConnection({ ...state.settings, queryEnabled: false, aiEnabled: false })).resolves.toEqual({ ok: true, model: 'test-model' });
    expect(load).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requests[0]?.tools.map(entry => entry.function.name)).toEqual(['probe']);
    expect(requests[0]?.tool_choice).toEqual({ type: 'function', function: { name: 'probe' } });
    expect(JSON.stringify(requests)).not.toContain(state.settings.apiKey);
  });

  it('routes Workers AI through its official OpenAI-compatible endpoint', async () => {
    const accountId = 'a'.repeat(32);
    const { fetcher, requests } = provider([{ calls: [{ name: 'probe', input: { nonce: 'starts-tool-probe' } }] }]);
    await testQueryConnection({ ...state.settings, provider: 'workers-ai', accountId, model: '@cf/test/tool-model' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
    expect(requests[0]?.model).toBe('@cf/test/tool-model');
  });

  it('reports unsupported tools when the endpoint returns only text or rejects tool calls', async () => {
    provider([{ text: 'I cannot call tools.' }]);
    await expect(testQueryConnection(state.settings)).rejects.toThrow('tools/tool_calls');
    provider([{ text: 'Here is an unverified answer.' }]);
    await expect(runQueryAgent(options().args)).rejects.toThrow('tools/tool_calls');
    const fetcher = vi.fn(async () => new Response('unsupported tool_choice', { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(testQueryConnection(state.settings)).rejects.toThrow('tools/tool_calls');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires credentials, a secure endpoint, valid account ID and granted permission', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(testQueryConnection({ ...state.settings, apiKey: '' })).rejects.toThrow('API Key');
    await expect(testQueryConnection({ ...state.settings, endpoint: 'http://remote.example/v1' })).rejects.toThrow('HTTPS');
    await expect(testQueryConnection({ ...state.settings, provider: 'workers-ai', accountId: 'bad' })).rejects.toThrow('Account ID');
    state.granted = false;
    await expect(testQueryConnection(state.settings)).rejects.toThrow('权限');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the configured probe deadline while waiting for response headers', async () => {
    state.settings.modelTimeoutSeconds = 75;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let networkSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true }));
    });
    vi.stubGlobal('fetch', fetcher);
    const rejected = expect(testQueryConnection(state.settings)).rejects.toThrow('超时');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(70000);
    expect(networkSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(networkSignal?.aborted).toBe(true);
  });

  it('times out a stalled first content chunk within the per-step deadline', async () => {
    state.settings.modelTimeoutSeconds = 60;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const pending = testQueryConnection(state.settings);
    const rejection = expect(pending).rejects.toThrow(/停止|超时/);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(state.settings.modelTimeoutSeconds * 1000 + 1);
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
