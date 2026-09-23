import { z } from 'zod';
import { db } from './library';
import type { AgentResult, ChatMessage, ChatRun, ChatSession, ChatStatus, ChatStep, ChatStopTarget } from './chat-types';
import { canQueryItem } from './retrieval';
import { withCurrentSettings } from './settings';
import type { Settings } from './types';

export const chatId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const chatStopTarget = z.union([
  z.object({ requestId: chatId }).strict(), z.object({ runId: chatId }).strict(),
]);
export function matchesChatRun(run: ChatRun, target: ChatStopTarget): boolean {
  return target.runId !== undefined ? run.id === target.runId : run.clientRequestId === target.requestId;
}
export const chatQuestion = z.string().trim().min(1, '请输入想查找的内容。').max(4000, '每条问题不能超过 4000 字。').refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), '问题含有无效字符。');

export async function createChat(): Promise<ChatSession> {
  return db.transaction('rw', db.chatSessions, async () => {
    if (await db.chatSessions.count() >= 100) throw new Error('最多保留 100 个对话，请先删除不再需要的会话。');
    const now = new Date().toISOString();
    const session: ChatSession = { id: crypto.randomUUID(), title: '新对话', createdAt: now, updatedAt: now, status: 'idle' };
    await db.chatSessions.add(session);
    return session;
  });
}

export async function beginChatRun(
  sessionId: string, input: { text: string; messageId: string } | { retryId: string }, settings: Settings,
  clientRequestId: string = crypto.randomUUID(),
): Promise<{ run: ChatRun; question: string }> {
  chatId.parse(sessionId);
  chatId.parse(clientRequestId);
  return db.transaction('rw', db.chatSessions, db.chatMessages, db.chatRuns, async () => {
    const session = await db.chatSessions.get(sessionId);
    if (!session) throw new Error('对话不存在或已删除。');
    if (session.status === 'running') throw new Error('当前对话正在查询，请先等待或停止。');
    if (await db.chatRuns.where('sessionId').equals(sessionId).filter(run => run.clientRequestId === clientRequestId).first()) {
      throw new Error('这次查询请求已经提交，请使用新的重试请求。');
    }
    const messages = await db.chatMessages.where('sessionId').equals(sessionId).sortBy('sequence');
    let user: ChatMessage;
    let assistantId: string = crypto.randomUUID();
    let sequence = (messages.at(-1)?.sequence ?? 0) + 1;
    const now = new Date().toISOString();
    if ('retryId' in input) {
      const retryId = chatId.parse(input.retryId);
      const last = messages.at(-1);
      const previous = messages.at(-2);
      if (!last || last.role !== 'assistant' || !['failed', 'stopped', 'interrupted'].includes(last.status) || !previous || previous.role !== 'user' || ![last.id, previous.id].includes(retryId)) throw new Error('只能重试最后一条未完成的查询。');
      user = previous; assistantId = last.id; sequence = last.sequence;
    } else {
      if (messages.length >= 200) throw new Error('此对话已达到 100 轮，请新建对话继续。');
      const id = chatId.parse(input.messageId);
      if (await db.chatMessages.get(id)) throw new Error('这条问题已经提交，请等待结果或使用重试。');
      user = { id, sessionId, role: 'user', text: chatQuestion.parse(input.text), sequence, createdAt: now, status: 'completed', citations: [] };
      await db.chatMessages.add(user); sequence++;
    }
    const run: ChatRun = {
      id: crypto.randomUUID(), sessionId, userMessageId: user.id, assistantMessageId: assistantId, clientRequestId,
      status: 'running', phase: '正在准备查询', startedAt: now, updatedAt: now,
      settingsRevision: settings.revision, provider: settings.provider, model: settings.model, steps: [],
    };
    await db.chatRuns.add(run);
    await db.chatMessages.put({ id: assistantId, sessionId, runId: run.id, role: 'assistant', text: '', createdAt: now, sequence, status: 'running', citations: [] });
    await db.chatSessions.update(sessionId, { title: messages.length ? session.title : user.text.slice(0, 60), updatedAt: now, status: 'running', activeRunId: run.id, error: undefined });
    return { run, question: user.text };
  });
}

export async function updateChatRun(run: ChatRun, patch: Partial<ChatRun>, messagePatch?: Partial<ChatMessage>): Promise<boolean> {
  return db.transaction('rw', db.chatSessions, db.chatRuns, db.chatMessages, async () => {
    const session = await db.chatSessions.get(run.sessionId);
    const current = await db.chatRuns.get(run.id);
    const message = await db.chatMessages.get(run.assistantMessageId);
    if (session?.activeRunId !== run.id || current?.status !== 'running' || message?.runId !== run.id) return false;
    const now = new Date().toISOString();
    await db.chatRuns.update(run.id, { ...patch, updatedAt: now });
    if (messagePatch) await db.chatMessages.update(run.assistantMessageId, messagePatch);
    if (patch.status && patch.status !== 'running') {
      await db.chatSessions.update(run.sessionId, { status: patch.status, activeRunId: undefined, updatedAt: now, error: patch.error });
    }
    return true;
  });
}

export async function completeChatRun(run: ChatRun, result: AgentResult, steps: ChatStep[], signal: AbortSignal): Promise<void> {
  await withCurrentSettings(async settings => {
    signal.throwIfAborted();
    if (!settings.queryEnabled || settings.revision !== run.settingsRevision) {
      throw new DOMException('查询已停止或配置已变化。', 'AbortError');
    }
    // Settings are read before the transaction; only IndexedDB work may be awaited inside it.
    await db.transaction('rw', db.items, db.chatSessions, db.chatRuns, db.chatMessages, async () => {
      const session = await db.chatSessions.get(run.sessionId);
      const current = await db.chatRuns.get(run.id);
      const message = await db.chatMessages.get(run.assistantMessageId);
      signal.throwIfAborted();
      if (session?.activeRunId !== run.id || current?.status !== 'running' || message?.runId !== run.id) {
        throw new DOMException('查询已停止。', 'AbortError');
      }
      for (const citation of result.citations) {
        const item = await db.items.get(citation.itemId);
        if (!item || !canQueryItem(item, settings) || item.contentVersion !== citation.contentVersion
          || item.title !== citation.title || item.url !== citation.url || item.source !== citation.source) {
          throw new Error('引用的收藏已删除、更新或禁止发送，请重新查询。');
        }
      }
      signal.throwIfAborted();
      const updated = await updateChatRun(run, {
        status: 'completed', phase: '查询完成', steps,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      }, { status: 'completed', text: result.text, citations: result.citations, error: undefined });
      signal.throwIfAborted();
      if (!updated) throw new DOMException('查询已停止。', 'AbortError');
    });
  });
}

export async function terminateChat(
  sessionId: string, status: Extract<ChatStatus, 'stopped' | 'interrupted' | 'failed'>, error: string,
  target?: ChatStopTarget,
) {
  chatId.parse(sessionId);
  if (target) chatStopTarget.parse(target);
  await db.transaction('rw', db.chatSessions, db.chatRuns, db.chatMessages, async () => {
    const session = await db.chatSessions.get(sessionId);
    if (!session?.activeRunId) return;
    const run = await db.chatRuns.get(session.activeRunId);
    if (run && (!target || matchesChatRun(run, target))) {
      await updateChatRun(run, { status, error, phase: error }, { status, error });
    }
  });
}

export async function recoverChatRuns() {
  for (const session of await db.chatSessions.where('status').equals('running').toArray()) {
    await terminateChat(session.id, 'interrupted', '扩展后台已重启，上次查询中断。可手动重试，不会自动重复请求。');
  }
}

export async function removeChat(sessionId: string) {
  chatId.parse(sessionId);
  await db.transaction('rw', db.chatSessions, db.chatMessages, db.chatRuns, async () => {
    await db.chatMessages.where('sessionId').equals(sessionId).delete();
    await db.chatRuns.where('sessionId').equals(sessionId).delete();
    await db.chatSessions.delete(sessionId);
  });
}
