import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: vi.fn(async () => ({})) } } } }));
import { db, saveCapture } from '../lib/library';
import { beginChatRun, createChat, recoverChatRuns, removeChat, terminateChat, updateChatRun } from '../lib/chat-store';
import { DEFAULT_SETTINGS } from '../lib/types';

beforeEach(async () => { await db.chatSessions.clear(); await db.chatMessages.clear(); await db.chatRuns.clear(); await db.items.clear(); });
const settings = { ...DEFAULT_SETTINGS, queryEnabled: true, apiKey: 'secret', revision: 1 };

describe('persistent conversations', () => {
  it('serializes duplicate or concurrent submissions and preserves one authoritative run', async () => {
    const session = await createChat();
    const attempts = await Promise.allSettled([
      beginChatRun(session.id, { text: '那个终端界面工具', messageId: 'first' }, settings),
      beginChatRun(session.id, { text: '重复点击', messageId: 'second' }, settings),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.chatMessages.count()).toBe(2);
    expect(await db.chatRuns.count()).toBe(1);
    const stored = await db.chatSessions.get(session.id);
    expect(stored?.status).toBe('running');
    expect(JSON.stringify(await db.chatRuns.toArray())).not.toContain('secret');
  });

  it('marks interrupted work for manual retry without recreating user messages', async () => {
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: '查找本地知识库', messageId: 'question' }, settings);
    await updateChatRun(run, { phase: '读取候选' }, { text: '部分结果' });
    await recoverChatRuns();
    expect((await db.chatSessions.get(session.id))?.status).toBe('interrupted');
    expect((await db.chatMessages.get(run.assistantMessageId))?.text).toBe('部分结果');
    const next = await beginChatRun(session.id, { retryId: run.userMessageId }, settings);
    expect(next.run.id).not.toBe(run.id);
    expect(next.run.assistantMessageId).toBe(run.assistantMessageId);
    expect(await db.chatMessages.count()).toBe(2);
    expect(await updateChatRun(run, { status: 'completed' }, { text: '过期结果' })).toBe(false);
    expect((await db.chatMessages.get(run.assistantMessageId))?.text).toBe('');
  });

  it('does not revive cancelled or deleted conversations when an old response arrives', async () => {
    const session = await createChat();
    const { run } = await beginChatRun(session.id, { text: 'SQLite', messageId: 'request' }, settings);
    await terminateChat(session.id, 'stopped', '用户停止');
    expect(await updateChatRun(run, { status: 'completed' }, { text: '迟到' })).toBe(false);
    await removeChat(session.id);
    expect(await updateChatRun(run, { status: 'completed' }, { text: '迟到' })).toBe(false);
    expect(await db.chatMessages.count()).toBe(0);
    expect(await db.chatRuns.count()).toBe(0);
  });

  it('keeps completed history and scopes retry IDs to the correct session', async () => {
    const first = await createChat(); const second = await createChat();
    const { run } = await beginChatRun(first.id, { text: '终端UI', messageId: 'unique-question' }, settings);
    await updateChatRun(run, { status: 'completed' }, { text: '结果', status: 'completed' });
    await expect(beginChatRun(first.id, { retryId: run.userMessageId }, settings)).rejects.toThrow('只能重试');
    await expect(beginChatRun(second.id, { retryId: run.userMessageId }, settings)).rejects.toThrow('只能重试');
    const followUp = await beginChatRun(first.id, { text: '只看TypeScript', messageId: 'follow-up' }, settings);
    expect((await db.chatMessages.get(followUp.run.assistantMessageId))?.sequence).toBe(4);
  });

  it('retains existing version-one library records when adding conversation stores', async () => {
    const { item } = await saveCapture({ url: 'https://example.com/preserved', title: '原有收藏', content: '重要正文' });
    expect(db.verno).toBe(3);
    await createChat();
    expect(await db.items.get(item.id)).toEqual(item);
    const name = `starts-migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ items: 'id, &normalizedUrl', jobs: 'itemId' });
    await legacy.table('items').add(item); legacy.close();
    const upgraded = new Dexie(name);
    upgraded.version(1).stores({ items: 'id, &normalizedUrl', jobs: 'itemId' });
    upgraded.version(2).stores({ chatSessions: 'id, updatedAt, status', chatMessages: 'id, sessionId, [sessionId+sequence], runId', chatRuns: 'id, sessionId, status, updatedAt' });
    expect(await upgraded.table('items').get(item.id)).toEqual(item);
    await upgraded.delete();
  });
});
