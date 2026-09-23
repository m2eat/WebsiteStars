import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  isStepCount, tool, ToolChoiceViolationError, ToolLoopAgent,
  type StreamTextTransform, type TextStreamPart, type ToolSet,
} from 'ai';
import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { AgentHistoryTurn, AgentResult, ChatStep } from './chat-types';
import {
  assertQuerySettings, CitationError, LocalRetrievalService, QueryError, RETRIEVAL_LIMITS,
  type ResultReference, type RetrievalService,
} from './retrieval';
import { endpointOrigin, getSettings } from './settings';
import type { Settings } from './types';
import { modelFetch } from './model-fetch';
import { agentTimeout, modelTimeoutMs, queryTimeoutMs } from './model-timeout';
import { buildQueryContext } from './query-context';
import { CITATION_REPAIR_INSTRUCTIONS, QUERY_INSTRUCTIONS, RERANK_INSTRUCTIONS } from './query-instructions';
import { MAX_ANSWER_CHARS, StreamingAnswer } from './streaming-answer';

const MAX_STEPS = 6;
const MAX_TOOLS = 12;
const TOOL_CAPABILITY_ERROR = '模型未完成标准工具调用，请选择支持 tools/tool_calls 的模型后重新测试连接。';
const safeText = (max: number, min = 0) => z.string().min(min).max(max).refine(
  value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), '文本含有不支持的控制字符',
);
const searchSchema = z.object({
  queries: z.array(safeText(200, 1)).min(1).max(RETRIEVAL_LIMITS.queries),
  source: z.enum(['github', 'article', 'docs']).optional(),
  language: safeText(100).optional(), tag: safeText(100).optional(),
  after: safeText(40).optional(), before: safeText(40).optional(),
  excludeIds: z.array(safeText(128, 1)).max(20).optional(),
}).strict();
const presentSchema = z.object({
  answer: safeText(MAX_ANSWER_CHARS).describe('Final answer in the requested language, or otherwise the user question language. Recommended names, count, and order must match results.'),
  results: z.array(z.object({
    itemId: safeText(128, 1), evidenceId: safeText(160, 1).optional(), quote: safeText(RETRIEVAL_LIMITS.snippet, 1).optional(),
    reason: safeText(600, 1).describe('Specific match and limitations, in the same output language as answer.'), kind: z.enum(['identity', 'capability']).optional(),
  }).strict()).max(RETRIEVAL_LIMITS.candidates).describe('Final selected bookmarks in display order, not all retrieved candidates. Use an empty array when nothing matches.'),
  clarification: safeText(1000).optional().describe('One useful clarification question in the same output language as answer.'),
}).strict().refine(value => !!(value.answer.trim() || value.clarification?.trim()), '请提供答案或澄清问题');

function safeError(error: unknown): Error {
  if (error instanceof QueryError) return error;
  if (ToolChoiceViolationError.isInstance(error)) return new QueryError(TOOL_CAPABILITY_ERROR);
  if (error instanceof Error && error.name === 'TimeoutError') return new QueryError('查询超时，请缩小问题范围后重试。');
  if (error instanceof Error && error.name === 'AbortError') return new DOMException('查询已停止。', 'AbortError');
  return new QueryError('模型查询失败，请检查连接、工具调用支持和返回格式后重试。');
}

function lifetime(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new DOMException('查询已停止。', 'AbortError'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('查询超时。', 'TimeoutError')), timeoutMs);
  return {
    controller,
    dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

function queryModel(settings: Settings, signal: AbortSignal, assertActive: () => Promise<void>) {
  if (!settings.apiKey.trim() || !settings.model.trim()) throw new QueryError('请先填写查询模型和 API Key。');
  if (settings.provider === 'workers-ai' && !/^[a-f\d]{32}$/iu.test(settings.accountId)) {
    throw new QueryError('请填写有效的 Cloudflare Account ID（32 位）。');
  }
  let origin: string;
  try { origin = endpointOrigin(settings); } catch { throw new QueryError('模型端点无效，请使用 HTTPS 或本机 HTTP 地址。'); }
  const baseURL = settings.provider === 'workers-ai'
    ? `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/v1`
    : settings.endpoint.replace(/\/+$/u, '');
  const completionURL = new URL(`${baseURL}/chat/completions`).href;
  return createOpenAICompatible({
    name: settings.provider, baseURL, apiKey: settings.apiKey, includeUsage: true,
    fetch: async (input, init) => {
      signal.throwIfAborted();
      await assertActive();
      const requested = input instanceof Request ? input.url : String(input);
      if (requested !== completionURL) throw new QueryError('模型请求地址与已授权端点不一致。');
      if (!await browser.permissions.contains({ origins: [`${origin}/*`] })) {
        throw new QueryError('模型端点权限已撤销，请在设置中重新授权。');
      }
      await assertActive();
      const requestSignal = AbortSignal.any([
        signal, AbortSignal.timeout(modelTimeoutMs(settings)), ...(init?.signal ? [init.signal] : []),
      ]);
      requestSignal.throwIfAborted();
      let response: Response;
      try { response = await modelFetch(input, { ...init, signal: requestSignal, redirect: 'error' }); }
      catch (error) { throw safeError(requestSignal.aborted ? requestSignal.reason : error); }
      await assertActive();
      requestSignal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        throw new QueryError([400, 404, 422].includes(response.status)
          ? `模型端点拒绝查询（HTTP ${response.status}），请检查模型名称及 tools/tool_calls 支持。`
          : `模型请求失败（HTTP ${response.status}），请检查凭证、连接和额度。`);
      }
      return response;
    },
  }).chatModel(settings.model);
}

function withoutReasoning<TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> {
  return () => new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
    transform(part, controller) {
      if (!part.type.startsWith('reasoning')) controller.enqueue(part);
    },
  });
}

export interface RunQueryAgentOptions {
  settings: Settings; question: string; history: AgentHistoryTurn[]; signal: AbortSignal;
  assertActive: () => Promise<void>; onText: (textDelta: string) => Promise<void>;
  onStep: (step: ChatStep) => Promise<void>; onPhase: (phase: string) => Promise<void>;
}

export async function runQueryAgent(options: RunQueryAgentOptions): Promise<AgentResult> {
  const { settings, signal: externalSignal, assertActive, onText, onStep, onPhase } = options;
  const question = options.question.trim();
  let context = buildQueryContext(question, []);
  if (!question || question.length > 4000) throw new QueryError('问题须为 1 至 4000 字符。');
  const { controller, dispose } = lifetime(queryTimeoutMs(settings), externalSignal);
  const signal = controller.signal;
  let failure: Error | undefined;
  const guard = async () => {
    signal.throwIfAborted();
    await assertActive();
    assertQuerySettings(settings, await getSettings());
    signal.throwIfAborted();
  };
  const retrieval: RetrievalService = new LocalRetrievalService(settings, guard, { signal });
  let calls = 0;
  let steps = 0;
  let rerankCalls = 0;
  let rerankInputTokens = 0;
  let rerankOutputTokens = 0;
  let usedLibrary = false;
  const searchCache = new Map<string, Awaited<ReturnType<RetrievalService['search']>>>();
  const readCache = new Map<string, Awaited<ReturnType<RetrievalService['read']>>>();
  const readCandidate = async (itemId: string, query: string) => {
    await retrieval.assertFresh();
    if (context.excludeIds.includes(itemId)) throw new QueryError('该候选已被用户排除，请选择其他资料。');
    const key = JSON.stringify([itemId, query.trim().toLowerCase()]);
    const cached = readCache.get(key);
    if (cached) { retrieval.accountOutput(cached); return cached; }
    const result = await retrieval.read({ itemId, query });
    readCache.set(key, result);
    return result;
  };
  let presentation: { text: string; references: ResultReference[] } | undefined;
  let citationRepairs = 0;
  let answerStream: { toolCallId: string; decoder: StreamingAnswer } | undefined;
  let streamedAnswer = '';
  const emitAnswer = async (delta: string) => {
    if (!delta) return;
    await guard();
    await onText(delta);
    streamedAnswer += delta;
    await guard();
  };
  let toolQueue: Promise<unknown> = Promise.resolve();
  const execute = <T>(
    name: string, label: string,
    action: () => Promise<{ output: T; resultIds: string[]; retrievalMode?: 'lexical' | 'hybrid' | 'fallback'; warning?: string; repair?: boolean }>,
  ): Promise<T> => {
    const pending = toolQueue.then(async () => {
      await retrieval.assertFresh();
      if (calls >= MAX_TOOLS) throw new QueryError('查询已达到 12 次工具调用上限，请缩小问题范围。');
      if (presentation) throw new QueryError('结果已提交，不能继续调用工具。');
      calls++;
      const start = Date.now();
      await onPhase(name === 'present_results' ? '正在校验结果' : '正在检索收藏');
      await guard();
      const result = await action();
      await retrieval.assertFresh();
      await onStep({ tool: result.repair ? 'repair_citations' : name, label: result.repair ? '引用不匹配，正在根据原文纠正' : label, resultIds: result.resultIds, durationMs: Date.now() - start, at: new Date().toISOString(), retrievalMode: result.retrievalMode, warning: result.warning });
      await retrieval.assertFresh();
      return result.output;
    });
    toolQueue = pending.catch(error => {
      failure ??= safeError(error);
      controller.abort(failure);
    });
    return pending;
  };

  try {
    await guard();
    const model = queryModel(settings, signal, () => retrieval.assertFresh());
    const history = await retrieval.history(options.history);
    context = buildQueryContext(question, history.map(turn => ({ question: turn.question, answer: '', itemIds: turn.selectedIds })));
    const facets = await retrieval.facets();
    const smallLibrary = facets.total <= 12;
    let catalog: unknown;
    if (smallLibrary) {
      const started = Date.now();
      const overview = await retrieval.browse({ limit: 12, excludeIds: context.excludeIds, language: context.language, source: context.source });
      catalog = overview;
      usedLibrary = true;
      await onStep({ tool: 'browse_library', label: `已阅读小资料库的 ${overview.items.length} 条概况`, resultIds: overview.items.map(item => item.itemId), durationMs: Date.now() - started, at: new Date().toISOString() });
    }
    const tools = {
      browse_library: tool({
        description: 'Browse a paginated overview of eligible bookmarks. Useful for small libraries, explicit listings, or requests without search clues. titleId proves identity only; descriptionId cites the source description. Read source content for more detailed capability claims.',
        inputSchema: z.object({ source: z.enum(['github', 'article', 'docs']).optional(), language: safeText(100).optional(), offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(12).optional(), excludeIds: z.array(safeText(128, 1)).max(20).optional() }).strict(),
        execute: input => execute('browse_library', '浏览了收藏概况', async () => {
          const output = await retrieval.browse({ ...input, language: context.language ?? input.language, source: context.source ?? input.source, excludeIds: [...new Set([...context.excludeIds, ...input.excludeIds ?? []])] });
          usedLibrary = true;
          return { output, resultIds: output.items.map(item => item.itemId) };
        }),
      }),
      search_library: tool({
        description: 'Retrieve candidates with the full request and focused multilingual keywords. Combines semantic vectors with keywords when enabled and ready, returning relevant source passages. Relax only self-imposed filters on retry. Diagnostics report actual fallback; retrieved candidates are not final recommendations.',
        inputSchema: searchSchema,
        execute: input => execute('search_library', `搜索了 ${input.queries.length} 组关键词`, async () => {
          const searchInput = { ...input, question: context.retrievalQuestion, language: context.language ?? input.language, source: context.source ?? input.source, excludeIds: [...new Set([...context.excludeIds, ...input.excludeIds ?? []])] };
          const key = JSON.stringify({ ...searchInput, queries: [...new Set(input.queries.map(query => query.trim().toLowerCase()))].sort() });
          const cached = searchCache.get(key);
          const output = cached ?? await retrieval.search(searchInput);
          if (cached) retrieval.accountOutput(cached);
          else searchCache.set(key, output);
          usedLibrary = true;
          return { output, resultIds: output.items.map(item => item.itemId), retrievalMode: output.diagnostics?.mode, warning: output.diagnostics?.warning };
        }),
      }),
      read_item: tool({
        description: 'Read source passages relevant to query from a candidate already returned in this run. Locates relevant sections in long content.',
        inputSchema: z.object({ itemId: safeText(128, 1), query: safeText(400, 1) }).strict(),
        execute: input => execute('read_item', '读取了 1 条候选收藏', async () => {
          const output = await readCandidate(input.itemId, input.query);
          usedLibrary = true;
          return { output, resultIds: [output.item.itemId] };
        }),
      }),
      read_items: tool({
        description: 'Read relevant source passages for 2–6 retrieved candidates in one call for selection or comparison. Supply only plausible matches, not the entire library. Identical reads reuse earlier evidence.',
        inputSchema: z.object({ itemIds: z.array(safeText(128, 1)).min(2).max(6), query: safeText(400, 1) }).strict(),
        execute: input => execute('read_items', '批量核对候选收藏', async () => {
          const items = [];
          for (const itemId of [...new Set(input.itemIds)]) items.push((await readCandidate(itemId, input.query)).item);
          usedLibrary = true;
          return { output: { items }, resultIds: items.map(item => item.itemId) };
        }),
      }),
      rerank_candidates: tool({
        description: 'Read discovered candidates and compare their relevance to the full request using a model. Use only for difficult comparisons. Reorders supplied IDs without creating candidates; ranking does not select final results.',
        inputSchema: z.object({ query: safeText(1000, 1), itemIds: z.array(safeText(128, 1)).min(2).max(6) }).strict(),
        execute: input => execute('rerank_candidates', '按完整需求重新比较了候选', async () => {
          if (++rerankCalls > 2) throw new QueryError('本轮最多重排两次，请根据现有证据整理结果。');
          const candidates = [];
          for (const itemId of [...new Set(input.itemIds)]) {
            if (context.excludeIds.includes(itemId)) continue;
            candidates.push((await readCandidate(itemId, input.query)).item);
          }
          await guard();
          const rankingSchema = z.object({ rankings: z.array(z.object({ itemId: safeText(128, 1), relevance: z.enum(['strong', 'partial', 'weak']), reason: safeText(400, 1) }).strict()).max(6) }).strict();
          let ranking: z.infer<typeof rankingSchema> | undefined;
          const ranker = new ToolLoopAgent({
            model, maxRetries: 0, maxOutputTokens: 1800, timeout: agentTimeout(settings),
            tools: { rank_results: tool({ description: 'Order the supplied candidates by relevance to the query.', inputSchema: rankingSchema, execute: async value => { ranking = value; return { accepted: true }; } }) },
            toolChoice: { type: 'tool', toolName: 'rank_results' }, stopWhen: isStepCount(1),
            instructions: RERANK_INSTRUCTIONS,
            telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
            include: { requestBody: false, requestMessages: false, responseBody: false, rawChunks: false },
            prepareCall: value => ({ ...value, onError: () => undefined }),
          });
          const ranked = await ranker.stream({ prompt: JSON.stringify({ question, query: input.query, candidates }), abortSignal: signal, experimental_transform: withoutReasoning() });
          for await (const part of ranked.stream) {
            await guard();
            if (part.type === 'error' || part.type === 'tool-error') throw safeError(part.error);
          }
          await retrieval.assertFresh();
          const rankUsage = await ranked.totalUsage;
          rerankInputTokens += rankUsage.inputTokens ?? 0; rerankOutputTokens += rankUsage.outputTokens ?? 0;
          if (!ranking) throw new QueryError('重排模型未返回有效排序，请根据来源继续查询。');
          const validIds = new Set(candidates.map(item => item.itemId));
          const seen = new Set<string>();
          for (const entry of ranking.rankings) {
            if (!validIds.has(entry.itemId) || seen.has(entry.itemId)) throw new QueryError('重排返回了无效或重复的候选。');
            seen.add(entry.itemId);
          }
          const output = { rankings: ranking.rankings, candidates };
          retrieval.accountOutput(output);
          return { output, resultIds: ranking.rankings.map(item => item.itemId) };
        }),
      }),
      get_library_facets: tool({
        description: 'Get bounded aggregate counts of eligible bookmark sources, programming languages, tags, and categories to guide filtering.',
        inputSchema: z.object({}).strict(),
        execute: () => execute('get_library_facets', '查看了收藏筛选概况', async () => {
          const output = await retrieval.facets();
          usedLibrary = true;
          return { output, resultIds: [] };
        }),
      }),
      present_results: tool({
        description: 'Submit the final answer and a citation card for each selected bookmark only. Prefer itemId and evidenceId: snippetIds correspond to snippets, descriptionId cites the description, and titleId is only for kind=identity. The system resolves IDs to original text; quote may be omitted. Verbatim quote is also accepted, but must not be translated or paraphrased. If accepted=false, correct and resubmit the complete answer and results. State insufficient evidence when appropriate. Match the user requested language in answer, clarification, and reasons.',
        inputSchema: presentSchema,
        onInputStart: async ({ toolCallId }) => {
          await guard();
          if ((answerStream && !citationRepairs) || presentation) throw new QueryError('结果已提交，不能重复提交答案。');
          answerStream = { toolCallId, decoder: new StreamingAnswer() };
          await onPhase('正在整理回答');
        },
        onInputDelta: async ({ toolCallId, inputTextDelta }) => {
          await guard();
          if (answerStream?.toolCallId !== toolCallId) throw new QueryError('工具答案流无效。');
          const delta = answerStream.decoder.push(inputTextDelta);
          if (!citationRepairs) await emitAnswer(delta);
        },
        execute: input => execute<{ accepted: boolean; itemIds?: string[]; error?: string; instruction?: string }>('present_results', '校验并整理了推荐结果', async () => {
          if (!usedLibrary) throw new QueryError('须先查询本地收藏，才能提交结果。');
          if (input.results.some(result => context.excludeIds.includes(result.itemId))) throw new QueryError('结果包含已被用户排除的收藏，请重新查找。');
          let citations;
          try { citations = await retrieval.validate(input.results, context); }
          catch (error) {
            if (!(error instanceof CitationError) || citationRepairs >= 1 || steps >= MAX_STEPS - 1 || calls >= MAX_TOOLS) throw error;
            citationRepairs++;
            const output = { accepted: false, error: 'Selection or citation validation failed. Check source IDs, evidence, duplicates, and explicit user constraints.', instruction: CITATION_REPAIR_INSTRUCTIONS };
            retrieval.accountOutput(output);
            return { output, resultIds: [], repair: true };
          }
          const output = { accepted: true, itemIds: citations.map(citation => citation.itemId) };
          retrieval.accountOutput(output);
          presentation = {
            text: [input.answer.trim(), input.clarification?.trim()].filter(Boolean).join('\n\n'),
            references: input.results,
          };
          return { output, resultIds: output.itemIds };
        }),
      }),
    };
    const agent = new ToolLoopAgent({
      model, tools, maxRetries: 0, maxOutputTokens: 4096, timeout: agentTimeout(settings),
      include: { requestBody: false, requestMessages: false, responseBody: false, rawChunks: false },
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      // The SDK's default stream error handler logs provider errors with request data.
      prepareCall: input => ({ ...input, onError: () => undefined }),
      instructions: QUERY_INSTRUCTIONS,
      toolChoice: 'required',
      stopWhen: [isStepCount(MAX_STEPS), () => !!presentation || calls >= MAX_TOOLS || !!failure],
      prepareStep: async ({ stepNumber }) => {
        await retrieval.assertFresh();
        await onPhase(stepNumber === 0 ? '正在检索收藏' : '正在整理依据');
        await guard();
        if (citationRepairs || stepNumber >= MAX_STEPS - 2 || calls >= MAX_TOOLS - 2) {
          return { activeTools: ['present_results'], toolChoice: { type: 'tool', toolName: 'present_results' } };
        }
        return stepNumber === 0
          ? { activeTools: smallLibrary ? ['search_library', 'browse_library', 'get_library_facets', 'read_item', 'read_items', 'present_results'] : ['search_library', 'browse_library', 'get_library_facets'], toolChoice: 'required' }
          : { toolChoice: 'required' };
      },
      onStepEnd: async () => { steps++; await retrieval.assertFresh(); },
    });
    const response = await agent.stream({
      prompt: JSON.stringify({ question, history, context, ...(catalog ? { catalog } : {}) }), abortSignal: signal,
      experimental_transform: withoutReasoning(),
    });
    let textChars = 0;
    for await (const part of response.stream) {
      signal.throwIfAborted();
      if (part.type === 'error' || part.type === 'tool-error') throw safeError(part.error);
      if (part.type === 'abort') throw new QueryError('查询已停止或超时，请重试。');
      if (part.type === 'text-delta') {
        textChars += part.text.length;
        if (textChars > 12000) throw new QueryError('查询解释已达到长度上限，请缩小问题范围。');
      }
    }
    await toolQueue;
    if (failure) throw failure;
    if (!presentation) {
      if (calls >= MAX_TOOLS) throw new QueryError('查询已达到 12 次工具调用上限，未获得可验证结果。');
      if (steps >= MAX_STEPS) throw new QueryError('查询已达到 6 个模型步骤上限，未获得可验证结果。');
      throw new QueryError(calls ? '模型未提交可验证结果，请重新提问。' : TOOL_CAPABILITY_ERROR);
    }
    const usage = await response.totalUsage;
    const citations = await retrieval.validate(presentation.references, context);
    await onPhase('查询完成');
    await retrieval.assertFresh();
    if (!citationRepairs) {
      if (!presentation.text.startsWith(streamedAnswer)) throw new QueryError('工具答案与已接收的内容不一致，请重试。');
      await emitAnswer(presentation.text.slice(streamedAnswer.length));
    }
    await retrieval.assertFresh();
    return { text: presentation.text, citations, inputTokens: (usage.inputTokens ?? 0) + rerankInputTokens, outputTokens: (usage.outputTokens ?? 0) + rerankOutputTokens };
  } catch (error) {
    const reason = failure ?? safeError(signal.aborted ? signal.reason : error);
    controller.abort(reason);
    await toolQueue;
    throw reason;
  } finally { dispose(); }
}

export async function testQueryConnection(settings: Settings, externalSignal?: AbortSignal): Promise<{ ok: true; model: string }> {
  const { controller, dispose } = lifetime(modelTimeoutMs(settings), externalSignal);
  const signal = controller.signal;
  let called = false;
  try {
    const guard = async () => { signal.throwIfAborted(); };
    const agent = new ToolLoopAgent({
      model: queryModel(settings, signal, guard), maxRetries: 0, maxOutputTokens: 100, timeout: agentTimeout(settings, true),
      tools: {
        probe: tool({
          description: 'Confirm standard tool calling; no user library is accessed.',
          inputSchema: z.object({ nonce: z.literal('starts-tool-probe') }).strict(),
          execute: async () => { await guard(); called = true; return { ok: true }; },
        }),
      },
      toolChoice: { type: 'tool', toolName: 'probe' }, stopWhen: isStepCount(1),
      include: { requestBody: false, requestMessages: false, responseBody: false, rawChunks: false },
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      prepareCall: input => ({ ...input, onError: () => undefined }),
      prepareStep: async () => { await guard(); return undefined; },
    });
    const response = await agent.stream({
      prompt: 'Call probe once with nonce "starts-tool-probe". No other content is needed.',
      abortSignal: signal, experimental_transform: withoutReasoning(),
    });
    for await (const part of response.stream) {
      signal.throwIfAborted();
      if (part.type === 'error' || part.type === 'tool-error') throw safeError(part.error);
      if (part.type === 'abort') throw new QueryError('连接测试已停止或超时。');
    }
    signal.throwIfAborted();
    if (!called) throw new QueryError(TOOL_CAPABILITY_ERROR);
    return { ok: true, model: settings.model };
  } catch (error) {
    const reason = safeError(signal.aborted ? signal.reason : error);
    controller.abort(reason);
    throw reason;
  } finally { dispose(); }
}
