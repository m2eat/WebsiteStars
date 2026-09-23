import { browser } from 'wxt/browser';
import { z } from 'zod';
import { runQueryAgent, testQueryConnection } from './agent';
import { db } from './library';
import { getSettings, withCurrentSettings } from './settings';
import { beginChatRun, chatId, chatQuestion, chatStopTarget, completeChatRun, createChat, matchesChatRun, recoverChatRuns, removeChat, terminateChat, updateChatRun } from './chat-store';
import { CHAT_PORT, type AgentHistoryTurn, type ChatPortReply, type ChatRun, type ChatStep, type ChatStopTarget } from './chat-types';
import type { Settings } from './types';
import { queryTimeoutMs } from './model-timeout';

const active = new Map<string, { run: ChatRun; controller: AbortController }>();
const cancelledRequests = new Set<string>();
const requestKey = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`;
const probes = new Map<AbortController, number>();
let initialization: Promise<void> | undefined;
export const initializeChats = () => initialization ??= recoverChatRuns();
const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), sessionId: chatId, messageId: chatId, requestId: chatId, text: chatQuestion }).strict(),
  z.object({ type: z.literal('retry'), sessionId: chatId, messageId: chatId, requestId: chatId }).strict(),
  z.object({ type: z.literal('stop'), sessionId: chatId, target: chatStopTarget }).strict(),
]);

export async function createChatSession() { await initializeChats(); return createChat(); }
export async function stopChat(id: string, target: ChatStopTarget) {
  chatId.parse(id);
  const parsed = chatStopTarget.parse(target);
  if ('requestId' in parsed) cancelledRequests.add(requestKey(id, parsed.requestId));
  for (const task of active.values()) {
    if (task.run.sessionId === id && matchesChatRun(task.run, parsed)) task.controller.abort();
  }
  await initializeChats();
  await terminateChat(id, 'stopped', '查询已停止。', parsed);
}
export async function deleteChat(id: string) {
  chatId.parse(id);
  for (const task of active.values()) if (task.run.sessionId === id) task.controller.abort();
  await initializeChats();
  await removeChat(id);
  for (const key of cancelledRequests) if (key.startsWith(`${id}:`)) cancelledRequests.delete(key);
}
export async function cancelAllChats(savedRevision: number) {
  z.number().int().nonnegative().parse(savedRevision);
  for (const task of active.values()) {
    if (task.run.settingsRevision < savedRevision) task.controller.abort();
  }
  for (const [controller, revision] of probes) if (revision < savedRevision) controller.abort();
  await initializeChats();
  const runs = await db.chatRuns.where('status').equals('running').filter(run => run.settingsRevision < savedRevision).toArray();
  for (const run of runs) {
    const error = '模型或隐私设置已变更，请确认配置后重试。';
    await updateChatRun(run, { status: 'stopped', error, phase: error }, { status: 'stopped', error });
  }
}
export async function checkQueryConnection() {
  const controller = new AbortController();
  const settings = await withCurrentSettings(async current => {
    if (!current.queryEnabled) throw new Error('请先保存并启用对话查询。');
    probes.set(controller, current.revision);
    return current;
  });
  try {
    return await testQueryConnection(settings, controller.signal);
  } finally { probes.delete(controller); }
}

function safeError(error: unknown, secret: string): string {
  if (error instanceof z.ZodError) return '输入格式无效，请检查后重试。';
  const message = error instanceof Error ? error.message : '';
  if (/^[\s\S]{0,800}$/.test(message) && /[\u4e00-\u9fff]/.test(message) && !message.includes(secret || '\u0000')) return message;
  if (/401|403|unauthorized|forbidden/i.test(message)) return '模型请求未获授权，请检查 API Key 和服务权限。';
  if (/429|rate.?limit/i.test(message)) return '模型服务额度或请求频率受限，请稍后重试。';
  if (/tool|function|schema|NoOutput/i.test(message)) return '模型未能完成工具调用，请测试 Agent 连接或更换支持工具调用的模型。';
  return '查询未完成，请检查网络和模型配置后重试。';
}

async function historyFor(sessionId: string, userMessageId: string): Promise<AgentHistoryTurn[]> {
  const messages = await db.chatMessages.where('sessionId').equals(sessionId).sortBy('sequence');
  const history: AgentHistoryTurn[] = [];
  for (let index = 0; index < messages.length; index++) {
    const user = messages[index]!;
    if (user.id === userMessageId) break;
    const assistant = messages[index + 1];
    if (user.role === 'user' && assistant?.role === 'assistant' && assistant.status === 'completed') {
      history.push({ question: user.text, answer: '', itemIds: assistant.citations.map(citation => citation.itemId) });
    }
  }
  return history.slice(-6);
}

async function execute(request: z.infer<typeof requestSchema>, send: (reply: ChatPortReply) => void) {
  if (request.type === 'stop') { await stopChat(request.sessionId, request.target); return; }
  await initializeChats();
  const controller = new AbortController();
  let settings!: Settings;
  const { run, question } = await withCurrentSettings(async current => {
    if (!current.queryEnabled) throw new Error('请先在设置中启用对话查询。');
    if (!current.apiKey || !current.model) throw new Error('请先填写并保存模型连接信息。');
    settings = current;
    const started = await beginChatRun(request.sessionId, request.type === 'send'
      ? { text: request.text, messageId: request.messageId } : { retryId: request.messageId }, current, request.requestId);
    active.set(started.run.id, { run: started.run, controller });
    if (cancelledRequests.has(requestKey(request.sessionId, request.requestId))) controller.abort();
    return started;
  });
  const timeout = setTimeout(() => controller.abort(new DOMException('查询超时，请重试或缩小问题范围。', 'TimeoutError')), queryTimeoutMs(settings));
  const assertActive = async () => {
    controller.signal.throwIfAborted();
    const [currentSettings, session, currentRun] = await Promise.all([getSettings(), db.chatSessions.get(run.sessionId), db.chatRuns.get(run.id)]);
    if (!currentSettings.queryEnabled || currentSettings.revision !== run.settingsRevision || session?.activeRunId !== run.id || currentRun?.status !== 'running') {
      controller.abort(); throw new DOMException('查询已停止或配置已变化。', 'AbortError');
    }
    controller.signal.throwIfAborted();
  };
  let text = '';
  let lastWrite = 0;
  const steps: ChatStep[] = [];
  send({ type: 'chunk', chunk: { type: 'start', messageId: run.assistantMessageId } });
  send({ type: 'chunk', chunk: { type: 'start-step' } });
  let textId = run.id;
  send({ type: 'chunk', chunk: { type: 'text-start', id: textId } });
  try {
    await assertActive();
    const history = await historyFor(run.sessionId, run.userMessageId);
    const result = await runQueryAgent({
      settings, question, history, signal: controller.signal, assertActive,
      onText: async delta => {
        await assertActive();
        if (text.length + delta.length > 7002) throw new Error('查询答案已达到长度上限。');
        text += delta;
        send({ type: 'chunk', chunk: { type: 'text-delta', id: textId, delta } });
        if (Date.now() - lastWrite > 150) {
          if (!await updateChatRun(run, { phase: '正在整理回答' }, { text })) throw new DOMException('查询已停止。', 'AbortError');
          lastWrite = Date.now();
        }
      },
      onPhase: async phase => { await assertActive(); await updateChatRun(run, { phase: phase.slice(0, 200) }); },
      onStep: async step => {
        await assertActive();
        if (steps.length < 20) steps.push(step);
        await updateChatRun(run, { steps: [...steps], phase: step.label });
      },
    });
    await completeChatRun(run, result, steps, controller.signal);
    if (!result.text.startsWith(text)) {
      send({ type: 'chunk', chunk: { type: 'text-end', id: textId } });
      send({ type: 'chunk', chunk: { type: 'reset-step' } });
      send({ type: 'chunk', chunk: { type: 'start-step' } });
      textId = `${run.id}:final`;
      send({ type: 'chunk', chunk: { type: 'text-start', id: textId } });
      text = '';
    }
    const suffix = result.text.slice(text.length);
    if (suffix) send({ type: 'chunk', chunk: { type: 'text-delta', id: textId, delta: suffix } });
    send({ type: 'chunk', chunk: { type: 'text-end', id: textId } });
    send({ type: 'chunk', chunk: { type: 'finish-step' } });
    send({ type: 'chunk', chunk: { type: 'finish', finishReason: 'stop' } });
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const reason = aborted ? controller.signal.reason instanceof Error && controller.signal.reason.message.includes('超时') ? '查询超时，请重试或缩小问题范围。' : '查询已停止。' : safeError(error, settings.apiKey);
    await updateChatRun(run, { status: aborted ? 'stopped' : 'failed', error: reason, phase: reason, steps }, { status: aborted ? 'stopped' : 'failed', text, error: reason });
    send({ type: 'chunk', chunk: aborted ? { type: 'abort' } : { type: 'error', errorText: reason } });
  } finally {
    clearTimeout(timeout);
    active.delete(run.id);
    cancelledRequests.delete(requestKey(run.sessionId, request.requestId));
    send({ type: 'end' });
  }
}

export function registerChatPorts() {
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== CHAT_PORT) return;
    if (port.sender?.id !== browser.runtime.id || !port.sender.url?.startsWith(browser.runtime.getURL('/'))) { port.disconnect(); return; }
    let disconnected = false;
    let submitted = false;
    port.onDisconnect.addListener(() => { disconnected = true; });
    const send = (reply: ChatPortReply) => {
      if (disconnected) return;
      try { port.postMessage(reply); } catch { disconnected = true; }
    };
    port.onMessage.addListener(message => {
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success) { send({ type: 'error', error: '查询参数无效。' }); return; }
      if (parsed.data.type !== 'stop' && submitted) return;
      if (parsed.data.type !== 'stop') submitted = true;
      void execute(parsed.data, send).catch(error => send({ type: 'error', error: safeError(error, '') }));
    });
  });
  void initializeChats().catch(() => undefined);
}
