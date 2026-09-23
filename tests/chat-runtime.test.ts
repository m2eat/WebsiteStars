import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunQueryAgentOptions } from '../lib/agent';
import type { AgentResult, ChatPortReply, ChatPortRequest, ChatRun } from '../lib/chat-types';
import type { Command, Settings } from '../lib/types';

const state = vi.hoisted(() => ({
  settings: {} as Settings,
  agent: vi.fn<(options: RunQueryAgentOptions) => Promise<AgentResult>>(),
  probe: vi.fn<(settings: Settings, signal?: AbortSignal) => Promise<{ ok: true; model: string }>>(),
  connect: vi.fn(), sendMessage: vi.fn(), onConnect: vi.fn(), onMessage: vi.fn(),
  cancelAnalyses: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('../lib/agent', () => ({ runQueryAgent: state.agent, testQueryConnection: state.probe }));
vi.mock('../lib/analysis', () => ({
  cancelAnalyses: state.cancelAnalyses, abortAnalysis: vi.fn(), drainQueue: vi.fn(async () => undefined), queueAnalysis: vi.fn(),
}));
vi.mock('../lib/capture', () => ({ captureTab: vi.fn(), refreshGithub: vi.fn(), saveUrl: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension${path}`,
    connect: state.connect, sendMessage: state.sendMessage,
    onConnect: { addListener: state.onConnect }, onMessage: { addListener: state.onMessage },
    onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
  },
  storage: { local: {
    get: vi.fn(async () => ({ settings: structuredClone(state.settings) })),
    set: vi.fn(async ({ settings }: { settings: Settings }) => { state.settings = structuredClone(settings); }),
    setAccessLevel: vi.fn(async () => undefined),
  } },
  permissions: { contains: vi.fn(async () => true) },
  action: { onClicked: { addListener: vi.fn() } }, contextMenus: { onClicked: { addListener: vi.fn() } },
  commands: { onCommand: { addListener: vi.fn() } },
  alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn(async () => undefined) },
  tabs: { query: vi.fn(async () => []) },
} }));

import { createChatTransport } from '../lib/chat-client';
import { cancelAllChats, checkQueryConnection, createChatSession, deleteChat, initializeChats, stopChat } from '../lib/chat-server';
import { beginChatRun, completeChatRun, createChat, recoverChatRuns, updateChatRun } from '../lib/chat-store';
import { db, saveCapture } from '../lib/library';
import { getSettings, saveSettings, withCurrentSettings } from '../lib/settings';
import { DEFAULT_SETTINGS } from '../lib/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    addListener: (listener: (value: T) => void) => { listeners.add(listener); },
    removeListener: (listener: (value: T) => void) => { listeners.delete(listener); },
    emit: (value: T) => { for (const listener of listeners) listener(value); },
  };
}
let connectHandler: (port: unknown) => void;
let messageHandler: (command: unknown, sender: { id: string; url: string }, reply: (value: { ok: boolean; data?: unknown; error?: string }) => void) => void;

function connection(url = 'chrome-extension://test-extension/library.html') {
  const serverMessages = event<unknown>();
  const clientMessages = event<ChatPortReply>();
  const serverDisconnected = event<void>();
  const clientDisconnected = event<void>();
  const replies: ChatPortReply[] = [];
  const requests: unknown[] = [];
  const server = {
    name: 'starts-agent-query', sender: { id: 'test-extension', url },
    onMessage: serverMessages, onDisconnect: serverDisconnected,
    postMessage: (reply: ChatPortReply) => { replies.push(reply); clientMessages.emit(reply); },
    disconnect: vi.fn(() => clientDisconnected.emit()),
  };
  connectHandler(server);
  const client = {
    onMessage: clientMessages, onDisconnect: clientDisconnected,
    postMessage: (request: unknown) => { requests.push(request); queueMicrotask(() => serverMessages.emit(request)); },
    disconnect: () => serverDisconnected.emit(),
  };
  return { server, client, replies, requests };
}
function backgroundRequest(command: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise(resolve => {
    messageHandler(command, { id: 'test-extension', url: 'chrome-extension://test-extension/library.html' }, resolve);
  });
}
function send(sessionId: string, input: Partial<Extract<ChatPortRequest, { type: 'send' }>> = {}) {
  const port = connection();
  const request: ChatPortRequest = {
    type: 'send', sessionId, messageId: crypto.randomUUID(), requestId: crypto.randomUUID(), text: '查找资料', ...input,
  };
  port.client.postMessage(request);
  return { ...port, request };
}
async function settled(port: ReturnType<typeof connection>) {
  await vi.waitFor(() => expect(port.replies.some(reply => reply.type === 'end' || reply.type === 'error')).toBe(true));
}
function hasFinish(port: ReturnType<typeof connection>) {
  return port.replies.some(reply => reply.type === 'chunk' && reply.chunk.type === 'finish');
}
async function liveRun(sessionId: string): Promise<ChatRun> {
  const session = await db.chatSessions.get(sessionId);
  const run = session?.activeRunId ? await db.chatRuns.get(session.activeRunId) : undefined;
  expect(run).toBeDefined();
  return run!;
}
function holdAgent() {
  state.agent.mockImplementation(async options => {
    await options.assertActive();
    return new Promise((_resolve, reject) => {
      options.signal.throwIfAborted();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
}
async function consume(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  try { while (!(await reader.read()).done) { /* Drain SDK transport messages. */ } }
  catch { /* Aborted transports close with AbortError. */ }
  finally { reader.releaseLock(); }
}
async function citationFixture() {
  const { item } = await saveCapture({ url: `https://example.com/${crypto.randomUUID()}`, title: 'Current source', content: 'source evidence' });
  const result: AgentResult = { text: 'Verified answer', citations: [{
    itemId: item.id, title: item.title, url: item.url, source: item.source,
    contentVersion: item.contentVersion, quote: 'source evidence', reason: 'matches',
  }], inputTokens: 10, outputTokens: 5 };
  return { item, result };
}

beforeAll(async () => {
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  const { default: background } = await import('../entrypoints/background');
  (background as unknown as () => void)();
  connectHandler = state.onConnect.mock.calls[0]![0];
  messageHandler = state.onMessage.mock.calls[0]![0];
  await initializeChats();
});
beforeEach(async () => {
  await db.chatSessions.clear(); await db.chatRuns.clear(); await db.chatMessages.clear(); await db.items.clear();
  state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, apiKey: 'fixture-key', revision: 1 };
  state.agent.mockReset().mockResolvedValue({ text: 'answer', citations: [] });
  state.probe.mockReset().mockResolvedValue({ ok: true, model: 'fixture-model' });
  state.cancelAnalyses.mockReset().mockResolvedValue(undefined);
  state.connect.mockReset().mockImplementation(() => connection().client);
  state.sendMessage.mockReset().mockImplementation(backgroundRequest);
});
afterEach(async () => {
  await cancelAllChats(Number.MAX_SAFE_INTEGER);
  await vi.waitFor(async () => expect(await db.chatRuns.where('status').equals('running').count()).toBe(0));
});

describe('streamed answer finalization', () => {
  it.each(['prefix', 'complete', 'different', 'empty'])('keeps one authoritative SDK message when the stream is %s', async mode => {
    const session = await createChatSession();
    const finalText = '## 标题\n\n**完整答案**\n\n澄清问题？';
    const streamed = mode === 'prefix' ? '## 标题\n\n**完整' : mode === 'complete' ? finalText : mode === 'different' ? '旧的内容' : '';
    state.agent.mockImplementation(async options => {
      if (streamed) await options.onText(streamed);
      return { text: finalText, citations: [] };
    });
    const port = send(session.id);
    await settled(port);
    const chunks = port.replies.flatMap(reply => reply.type === 'chunk' ? [reply.chunk] : []);
    let message: UIMessage | undefined;
    for await (const update of readUIMessageStream({ stream: new ReadableStream<UIMessageChunk>({
      start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); },
    }), terminateOnError: true })) message = update;
    const saved = (await db.chatMessages.where('sessionId').equals(session.id).sortBy('sequence')).at(-1)!;
    expect(saved).toMatchObject({ text: finalText, status: 'completed' });
    expect(message?.id).toBe(saved.id);
    expect(message?.parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([finalText]);
    expect(chunks.filter(chunk => chunk.type === 'start')).toHaveLength(1);
    expect(chunks.filter(chunk => chunk.type === 'reset-step')).toHaveLength(mode === 'different' ? 1 : 0);
    expect(await db.chatMessages.where('sessionId').equals(session.id).count()).toBe(2);
    expect(hasFinish(port)).toBe(true);
  });

  it('persists a live answer before completion without publishing citations early', async () => {
    const session = await createChatSession();
    const { result } = await citationFixture();
    const gate = deferred<void>();
    const emitted = deferred<void>();
    state.agent.mockImplementation(async options => {
      await options.onText('Verified');
      emitted.resolve();
      await gate.promise;
      return result;
    });
    const port = send(session.id);
    await emitted.promise;
    const run = await liveRun(session.id);
    expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({ text: 'Verified', status: 'running', citations: [] });
    expect(hasFinish(port)).toBe(false);
    gate.resolve();
    await settled(port);
    expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({ text: result.text, status: 'completed', citations: result.citations });
    const text = port.replies.flatMap(reply => reply.type === 'chunk' && reply.chunk.type === 'text-delta' ? [reply.chunk.delta] : []);
    expect(text).toEqual(['Verified', ' answer']);
  });

  it('marks streamed text failed without citations when final tool validation fails', async () => {
    const session = await createChatSession();
    state.agent.mockImplementation(async options => {
      await options.onText('尚未校验的答案');
      throw new Error('引用校验失败。');
    });
    const port = send(session.id);
    await settled(port);
    const message = (await db.chatMessages.where('sessionId').equals(session.id).sortBy('sequence')).at(-1)!;
    expect(message).toMatchObject({ text: '尚未校验的答案', status: 'failed', citations: [], error: '引用校验失败。' });
    expect(hasFinish(port)).toBe(false);
    expect(port.replies.some(reply => reply.type === 'chunk' && reply.chunk.type === 'error')).toBe(true);
  });
});

describe('atomic finalization', () => {
  it.each(['disabled', 'revision', 'blocked'])(
    'does not commit a late result after %s settings are saved', async change => {
      const { result } = await citationFixture();
      const session = await createChatSession();
      state.agent.mockImplementation(async options => {
        await options.assertActive();
        const current = await getSettings();
        await saveSettings({ ...current, ...(change === 'disabled' ? { queryEnabled: false }
          : change === 'blocked' ? { blockedDomains: ['example.com'] } : { model: 'changed-model' }) });
        return result;
      });
      const port = send(session.id);
      await settled(port);
      const message = (await db.chatMessages.where('sessionId').equals(session.id).sortBy('sequence')).at(-1)!;
      expect(message.status).toBe('stopped');
      expect(message.citations).toEqual([]);
      expect(message.text).not.toBe(result.text);
      expect(hasFinish(port)).toBe(false);
    },
  );

  it.each(['deleted', 'private', 'unverified', 'version', 'title'])(
    'rejects a source made %s after the agent validates it', async change => {
      const { item, result } = await citationFixture();
      const session = await createChatSession();
      state.agent.mockImplementation(async options => {
        await options.assertActive();
        if (change === 'deleted') await db.items.delete(item.id);
        if (change === 'private') await db.items.update(item.id, { githubVisibility: 'private' });
        if (change === 'unverified') await db.items.update(item.id, { source: 'github' });
        if (change === 'version') await db.items.update(item.id, { contentVersion: 2, content: 'changed' });
        if (change === 'title') await db.items.update(item.id, { title: 'changed title' });
        return result;
      });
      const port = send(session.id);
      await settled(port);
      const message = (await db.chatMessages.where('sessionId').equals(session.id).sortBy('sequence')).at(-1)!;
      expect(message.status).toBe('failed');
      expect(message.citations).toEqual([]);
      expect(message.error).toMatch(/删除|更新|禁止/);
      expect(hasFinish(port)).toBe(false);
    },
  );

  it('checks blocked domains even when a caller presents the current revision', async () => {
    state.settings.blockedDomains = ['example.com'];
    const { result } = await citationFixture();
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: 'question', messageId: 'blocked-final' }, await getSettings());
    await expect(completeChatRun(run, result, [], new AbortController().signal)).rejects.toThrow('禁止');
    expect((await db.chatMessages.get(run.assistantMessageId))?.citations).toEqual([]);
  });

  it('serializes a settings save behind an in-progress final commit without closing the Dexie transaction', async () => {
    const { item, result } = await citationFixture();
    const session = await createChat();
    const settings = await getSettings();
    const { run } = await beginChatRun(session.id, { text: 'question', messageId: 'serialized-settings' }, settings);
    const order: string[] = [];
    let save!: Promise<Settings>;
    vi.spyOn(db.items, 'get').mockImplementationOnce(() => {
      expect(Dexie.currentTransaction?.storeNames.sort()).toEqual(['chatMessages', 'chatRuns', 'chatSessions', 'items']);
      save = saveSettings({ ...settings, queryEnabled: false }).then(value => { order.push('saved-settings'); return value; });
      expect(state.settings.queryEnabled).toBe(true);
      return db.items.where('id').equals(item.id).first();
    });
    await completeChatRun(run, result, [], new AbortController().signal);
    order.push('completed');
    await save;
    expect(order).toEqual(['completed', 'saved-settings']);
    expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({ status: 'completed', text: result.text, citations: result.citations });
    expect(state.settings.queryEnabled).toBe(false);
  });

  it('prevents source mutations from interleaving between validation and final storage', async () => {
    const { item, result } = await citationFixture();
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: 'question', messageId: 'atomic-source' }, await getSettings());
    let removal!: Promise<void>;
    let statusAtRemoval: string | undefined;
    vi.spyOn(db.items, 'get').mockImplementationOnce(() => {
      removal = Dexie.ignoreTransaction(() => db.transaction('rw', db.items, db.chatRuns, async () => {
        statusAtRemoval = (await db.chatRuns.get(run.id))?.status;
        await db.items.delete(item.id);
      }));
      return db.items.where('id').equals(item.id).first();
    });
    await completeChatRun(run, result, [], new AbortController().signal);
    await removal;
    expect(statusAtRemoval).toBe('completed');
  });

  it('rolls back the whole completion if stopped while its writes are still in flight', async () => {
    const { result } = await citationFixture();
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: 'question', messageId: 'abort-final' }, await getSettings());
    const controller = new AbortController();
    const update = db.chatMessages.update.bind(db.chatMessages);
    vi.spyOn(db.chatMessages, 'update').mockImplementationOnce((key, patch) => update(key, patch).then(changed => {
      controller.abort();
      return changed;
    }));
    await expect(completeChatRun(run, result, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.chatRuns.get(run.id)).toMatchObject({ status: 'running' });
    expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({ status: 'running', text: '', citations: [] });
  });

  it('does not overwrite a replacement run or send a success event after stop wins', async () => {
    const session = await createChatSession();
    state.agent.mockImplementation(async () => {
      const run = await liveRun(session.id);
      await stopChat(session.id, { runId: run.id });
      return { text: 'late answer', citations: [] };
    });
    const port = send(session.id);
    await settled(port);
    expect(hasFinish(port)).toBe(false);
    const old = (await db.chatRuns.where('sessionId').equals(session.id).toArray())[0]!;
    const next = await beginChatRun(session.id, { retryId: old.userMessageId }, await getSettings());
    await expect(completeChatRun(old, { text: 'stale', citations: [] }, [], new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.chatMessages.get(next.run.assistantMessageId)).toMatchObject({ runId: next.run.id, text: '', status: 'running' });
  });
});

describe('submission-scoped stop', () => {
  it('ignores the old transport fallback after a new retry has started', async () => {
    holdAgent();
    const session = await createChatSession();
    const deferredStops: { command: Command; resolve: (value: unknown) => void }[] = [];
    state.sendMessage.mockImplementation((command: Command) => new Promise(resolve => deferredStops.push({ command, resolve })));
    const transport = createChatTransport(session.id);
    const controller = new AbortController();
    const messages = [{ id: 'transport-question', role: 'user' as const, parts: [{ type: 'text' as const, text: 'question' }] }];
    const first = consume(await transport.sendMessages({ chatId: session.id, trigger: 'submit-message', messageId: undefined, messages, abortSignal: controller.signal }));
    await vi.waitFor(() => expect(state.agent).toHaveBeenCalledTimes(1));
    const original = await liveRun(session.id);
    controller.abort();
    await first;
    await vi.waitFor(async () => expect((await db.chatRuns.get(original.id))?.status).toBe('stopped'));
    const retry = consume(await transport.sendMessages({ chatId: session.id, trigger: 'regenerate-message', messageId: messages[0]!.id, messages, abortSignal: undefined }));
    await vi.waitFor(() => expect(state.agent).toHaveBeenCalledTimes(2));
    const current = await liveRun(session.id);
    expect(current.clientRequestId).not.toBe(original.clientRequestId);
    expect(deferredStops).toHaveLength(1);
    for (const delayed of deferredStops) delayed.resolve(await backgroundRequest(delayed.command));
    await stopChat(session.id, { runId: original.id });
    expect(state.agent.mock.calls[1]![0].signal.aborted).toBe(false);
    expect(await db.chatSessions.get(session.id)).toMatchObject({ activeRunId: current.id, status: 'running' });
    await stopChat(session.id, { runId: current.id });
    await retry;
  });

  it('honors request cancellation before the run ID exists without dispatching the agent', async () => {
    const session = await createChatSession();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const lock = withCurrentSettings(async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const controller = new AbortController();
    const transport = createChatTransport(session.id);
    const stream = consume(await transport.sendMessages({ chatId: session.id, trigger: 'submit-message', messageId: undefined,
      messages: [{ id: 'early-stop', role: 'user', parts: [{ type: 'text', text: 'question' }] }], abortSignal: controller.signal }));
    controller.abort();
    gate.resolve(); await lock; await stream;
    await vi.waitFor(async () => expect((await db.chatSessions.get(session.id))?.status).toBe('stopped'));
    expect(state.agent).not.toHaveBeenCalled();
  });

  it('handles a stop arriving before its send and leaves a different request alone', async () => {
    const session = await createChatSession();
    await stopChat(session.id, { requestId: 'cancel-before-send' });
    const first = send(session.id, { requestId: 'cancel-before-send' });
    await settled(first);
    expect(state.agent).not.toHaveBeenCalled();
    const next = send(session.id);
    await settled(next);
    expect(state.agent).toHaveBeenCalledTimes(1);
    expect(hasFinish(next)).toBe(true);
  });

  it('rejects session-only or ambiguous stop commands and scopes valid IDs to their session', async () => {
    holdAgent();
    const session = await createChatSession();
    const other = await createChatSession();
    const port = send(session.id);
    await vi.waitFor(() => expect(state.agent).toHaveBeenCalledTimes(1));
    const run = await liveRun(session.id);
    expect((await backgroundRequest({ type: 'stopChat', id: session.id })).ok).toBe(false);
    expect((await backgroundRequest({ type: 'stopChat', id: session.id, target: { runId: run.id, requestId: run.clientRequestId } })).ok).toBe(false);
    await stopChat(other.id, { runId: run.id });
    await stopChat(other.id, { requestId: run.clientRequestId! });
    const invalid = connection(); invalid.client.postMessage({ type: 'stop', sessionId: session.id });
    await settled(invalid);
    expect(state.agent.mock.calls[0]![0].signal.aborted).toBe(false);
    expect((await backgroundRequest({ type: 'stopChat', id: session.id, target: { runId: run.id } })).ok).toBe(true);
    await settled(port);
    expect(state.agent.mock.calls[0]![0].signal.aborted).toBe(true);
  });

  it('does not rerun a previously persisted client request ID', async () => {
    const session = await createChatSession();
    state.agent.mockRejectedValue(new Error('模型暂时失败。'));
    const first = send(session.id, { requestId: 'duplicate-request' });
    await settled(first);
    const port = connection();
    port.client.postMessage({ type: 'retry', sessionId: session.id, messageId: first.request.messageId, requestId: first.request.requestId });
    await settled(port);
    expect(state.agent).toHaveBeenCalledTimes(1);
    expect(await db.chatRuns.where('sessionId').equals(session.id).count()).toBe(1);
  });

  it('keeps deleted sessions deleted when their submitted or running requests finish late', async () => {
    const session = await createChatSession();
    state.agent.mockImplementation(async () => {
      await deleteChat(session.id);
      return { text: 'late answer', citations: [] };
    });
    const port = send(session.id);
    await settled(port);
    expect(await db.chatSessions.get(session.id)).toBeUndefined();
    expect(await db.chatMessages.where('sessionId').equals(session.id).count()).toBe(0);
    expect(hasFinish(port)).toBe(false);
    const missing = send(session.id);
    await settled(missing);
    expect(state.agent).toHaveBeenCalledTimes(1);
  });

  it('does not accept query ports from page content scripts', () => {
    const port = connection('https://example.com/');
    expect(port.server.disconnect).toHaveBeenCalledTimes(1);
    expect(state.agent).not.toHaveBeenCalled();
  });
});

describe('revision-scoped settings cancellation', () => {
  it('aborts older runs and probes while keeping those using the saved revision alive', async () => {
    holdAgent();
    const probeSignals: AbortSignal[] = [];
    state.probe.mockImplementation(async (_settings, signal) => {
      probeSignals.push(signal!);
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const oldSession = await createChatSession();
    const oldPort = send(oldSession.id);
    const oldProbe = checkQueryConnection().catch(error => error);
    await vi.waitFor(() => { expect(state.agent).toHaveBeenCalledTimes(1); expect(probeSignals).toHaveLength(1); });
    const saved = await saveSettings({ ...await getSettings(), model: 'new-model' });
    const newSession = await createChatSession();
    const newPort = send(newSession.id);
    const newProbe = checkQueryConnection().catch(error => error);
    await vi.waitFor(() => { expect(state.agent).toHaveBeenCalledTimes(2); expect(probeSignals).toHaveLength(2); });
    await cancelAllChats(saved.revision);
    await oldProbe; await settled(oldPort);
    expect(probeSignals.map(signal => signal.aborted)).toEqual([true, false]);
    expect(state.agent.mock.calls.map(([options]) => options.signal.aborted)).toEqual([true, false]);
    const run = await liveRun(newSession.id);
    expect(run.settingsRevision).toBe(saved.revision);
    await cancelAllChats(saved.revision);
    expect((await db.chatRuns.get(run.id))?.status).toBe('running');
    await cancelAllChats(saved.revision + 1);
    await newProbe; await settled(newPort);
  });

  it('does not cancel a new-revision run while background analysis cleanup is delayed', async () => {
    holdAgent();
    const oldSession = await createChatSession();
    const oldPort = send(oldSession.id);
    await vi.waitFor(() => expect(state.agent).toHaveBeenCalledTimes(1));
    const cleanup = deferred<void>();
    state.cancelAnalyses.mockImplementationOnce(() => cleanup.promise);
    const saved = backgroundRequest({ type: 'saveSettings', settings: { ...await getSettings(), model: 'new-model' } });
    await vi.waitFor(() => expect(state.cancelAnalyses).toHaveBeenCalledTimes(1));
    const session = await createChatSession();
    const port = send(session.id);
    await vi.waitFor(() => expect(state.agent).toHaveBeenCalledTimes(2));
    const run = await liveRun(session.id);
    expect(run.settingsRevision).toBe(2);
    expect(run.model).toBe('new-model');
    cleanup.resolve();
    expect((await saved).ok).toBe(true);
    await settled(oldPort);
    expect(state.agent.mock.calls[1]![0].signal.aborted).toBe(false);
    expect((await db.chatRuns.get(run.id))?.status).toBe('running');
    await stopChat(session.id, { runId: run.id }); await settled(port);
  });

  it('recovers interrupted legacy runs without request IDs and does not replay the agent', async () => {
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: 'question', messageId: 'legacy' }, await getSettings());
    await db.chatRuns.update(run.id, { clientRequestId: undefined });
    await recoverChatRuns();
    expect((await db.chatRuns.get(run.id))?.status).toBe('interrupted');
    expect(state.agent).not.toHaveBeenCalled();
    const next = await beginChatRun(session.id, { retryId: run.userMessageId }, await getSettings(), 'new-retry');
    await stopChat(session.id, { runId: run.id });
    expect((await db.chatRuns.get(next.run.id))?.status).toBe('running');
    expect(await updateChatRun(run, { status: 'completed' }, { text: 'late' })).toBe(false);
  });
});
