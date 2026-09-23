import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Item } from '../../lib/types';

function item(id: string, content: string, patch: Partial<Item> = {}): Item {
  const now = '2026-09-23T00:00:00.000Z'; const url = `https://fixture.example/${id}`;
  return { id, url, normalizedUrl: url, title: id, description: content.split('\n').at(-1) ?? '', content, excerpt: '', truncated: false, source: 'article', domain: 'fixture.example', tags: [], keywords: [], category: '', author: '', publishedAt: '', notes: 'PRIVATE-INDEX-NOTE', selections: ['PRIVATE-INDEX-SELECTION'], summaryOverride: 'PRIVATE-INDEX-SUMMARY', tagsOverride: ['PRIVATE-INDEX-TAG'], analysisStatus: 'disabled', createdAt: now, updatedAt: now, contentVersion: 1, ...patch };
}
const corpus = [item('PagePilot', '# Browser\n\nAn agent that automates browser navigation and fills forms.'), item('ConsoleCanvas', '# Terminal\n\nA toolkit for interactive terminal user interfaces.'), item('LinkOnly', ''), item('Blocked', 'SECRET-BLOCKED', { domain: 'blocked.example', url: 'https://blocked.example/', normalizedUrl: 'https://blocked.example/' })];

test('persistent semantic indexing, hybrid query, fallback and rebuild preserve private data', async () => {
  test.setTimeout(90000);
  const embeddingInputs: string[] = []; const chatInputs: string[] = [];
  let failEmbeddings = false; let serial = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url?.endsWith('/embeddings')) {
      if (failEmbeddings) { response.writeHead(503); response.end('{}'); return; }
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input]; embeddingInputs.push(...input);
      const values = input.map(text => /browser|网页|表单/i.test(text) ? [1, 0, 0] : /terminal|终端/i.test(text) ? [0, 1, 0] : [0, 0, 1]);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify({ data: values.map((embedding, index) => ({ index, embedding })) })); return;
    }
    chatInputs.push(raw);
    const toolResults = body.messages.filter((message: { role: string }) => message.role === 'tool');
    const prompt = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
    const name = toolResults.length ? 'present_results' : 'search_library';
    const result = toolResults.length ? JSON.parse(toolResults.at(-1).content) : null;
    const picked = result?.items.find((entry: { itemId: string }) => entry.itemId === 'PagePilot');
    const args = toolResults.length ? { answer: picked ? '找到可自动操作网页的 PagePilot。' : '本次未找到匹配。', results: picked ? [{ itemId: picked.itemId, quote: picked.snippets[0], reason: '来源说明支持网页操作。' }] : [] } : { queries: [prompt.question] };
    const id = `semantic-${++serial}`;
    const frames = [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }, { delta: {}, finish_reason: 'tool_calls' }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    response.end(frames.map(part => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...part }] })}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const profile = await mkdtemp(join(tmpdir(), 'starts-semantic-')); const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'zh-CN', headless: true, reducedMotion: 'reduce', viewport: { width: 1280, height: 960 }, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    await options.getByLabel('选择 JSON 备份文件').setInputFiles({ name: 'semantic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: corpus[0]!.createdAt, items: corpus })) });
    await options.getByRole('button', { name: '确认导入 4 条', exact: true }).click();
    await expect(options.getByText('导入完成：新增 4 条，跳过 0 条重复收藏。', { exact: true })).toBeVisible();
    expect(embeddingInputs).toHaveLength(0);
    await options.getByLabel('服务地址', { exact: true }).fill(endpoint); await options.getByLabel('模型', { exact: true }).fill('fixture'); await options.getByLabel('API Key', { exact: true }).fill('fixture-key');
    await options.getByLabel('禁止分析的域名', { exact: true }).fill('blocked.example');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await options.getByLabel('Embedding 服务地址', { exact: true }).fill(endpoint); await options.getByLabel('Embedding 模型', { exact: true }).fill('multilingual-fixture');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用语义检索', exact: true }) }).click();
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByText(/设置已保存，对话查询已启用/)).toBeVisible();
    await expect.poll(() => embeddingInputs.length).toBeGreaterThan(0);
    const library = await context.newPage(); await library.goto(`${base}/library.html`);
    await expect(library.getByText('向量就绪', { exact: true }).first()).toBeVisible();
    await library.getByRole('button', { name: '查看详情：PagePilot' }).click();
    await expect(library.getByText('向量就绪', { exact: true }).last()).toBeVisible();
    await library.getByRole('button', { name: '关闭弹窗' }).click();
    await library.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '对话查询' }).click();
    await library.getByRole('textbox', { name: '描述你想找的资料' }).fill('自己操作网页填写表单的工具'); await library.getByRole('button', { name: '发送', exact: true }).click();
    await expect(library.getByRole('button', { name: '查看引用：PagePilot', exact: true })).toBeVisible();
    expect(embeddingInputs.join('\n')).not.toMatch(/PRIVATE-INDEX|SECRET-BLOCKED/);
    expect(chatInputs.join('\n')).not.toMatch(/PRIVATE-INDEX|SECRET-BLOCKED/);
    expect(embeddingInputs).toContain('自己操作网页填写表单的工具');
    const embeddingsBefore = embeddingInputs.length;
    await options.reload(); await options.getByRole('button', { name: '刷新索引状态' }).click();
    await expect(options.getByRole('button', { name: '刷新索引状态' })).toBeEnabled(); expect(embeddingInputs.length).toBe(embeddingsBefore);
    failEmbeddings = true;
    await library.getByRole('textbox', { name: '描述你想找的资料' }).fill('browser'); await library.getByRole('button', { name: '发送', exact: true }).click();
    await expect(library.locator('.chat-message-assistant')).toHaveCount(2);
    await expect(library.locator('.chat-message-assistant').last().getByRole('button', { name: '查看引用：PagePilot' })).toBeVisible();
    expect(chatInputs.at(-1)).toContain('fallback');
    failEmbeddings = false;
    await options.setViewportSize({ width: 390, height: 844 }); await options.emulateMedia({ colorScheme: 'dark' });
    expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await options.screenshot({ path: 'test-results/semantic-settings-dark.png', animations: 'disabled', fullPage: true });
    await library.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '资料库' }).click();
    await library.getByRole('button', { name: '查看详情：PagePilot' }).click(); await library.getByRole('tab', { name: '笔记与划词' }).click();
    await expect(library.getByText('PRIVATE-INDEX-NOTE', { exact: true })).toBeVisible();
    await library.getByRole('button', { name: '删除收藏', exact: true }).click(); await library.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(library.locator('.item-list > li')).toHaveCount(3);
    await options.getByRole('button', { name: '重建检索索引', exact: true }).click();
    await options.getByRole('dialog').getByRole('button', { name: /确认重建/ }).click();
    await expect(options.getByText(/重建任务已排队/)).toBeVisible();
    await expect(library.getByRole('button', { name: '查看详情：ConsoleCanvas' })).toBeVisible();
  } finally { await context.close(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); await rm(profile, { recursive: true, force: true }); }
});
