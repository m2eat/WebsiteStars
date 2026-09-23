import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Item } from '../../lib/types';

type ModelMessage = { role: string; content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
const requests: string[] = [];
let count = 0;
let failNext = false;
let holdNext = false;
let delayNextMs = 0;
let held: ServerResponse | undefined;
let heldReply: (() => void) | undefined;
const answer = '找到一个符合描述的收藏：Terminal Garden，可用于构建终端交互界面。';

function writeTool(response: ServerResponse, name: string, input: unknown, text = '') {
  const id = `call-${++count}`;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  const packet = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: `chat-${count}`, object: 'chat.completion.chunk', created: 1750000000, model: 'query-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } } : {}) })}\n\n`;
  if (text) response.write(packet({ role: 'assistant', content: text }));
  const args = JSON.stringify(input);
  response.write(packet({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args.slice(0, Math.floor(args.length / 2)) } }] }));
  setTimeout(() => {
    if (response.destroyed) return;
    response.write(packet({ tool_calls: [{ index: 0, function: { arguments: args.slice(Math.floor(args.length / 2)) } }] }));
    response.write(packet({}, 'tool_calls')); response.end('data: [DONE]\n\n');
  }, 80);
}

function responseFor(body: { messages: ModelMessage[]; tools?: { function: { name: string } }[] }, response: ServerResponse, invalidCitation = false) {
  if (body.tools?.some(tool => tool.function.name === 'probe')) { writeTool(response, 'probe', { nonce: 'starts-tool-probe' }); return; }
  const prompt = JSON.parse(body.messages.find(message => message.role === 'user')!.content!);
  const toolMessages = body.messages.filter(message => message.role === 'tool');
  const last = toolMessages.at(-1);
  const lastCall = body.messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === last?.tool_call_id);
  if (!last) {
    writeTool(response, 'search_library', { queries: prompt.question.includes('不存在') ? ['no-such-resource-987654'] : ['terminal UI', '命令行 界面'], ...(prompt.question.includes('只看') ? { language: 'TypeScript', source: 'github' } : {}) }, '正在检索收藏中的终端界面工具。');
  } else if (lastCall?.function.name === 'search_library') {
    const data = JSON.parse(last.content!);
    if (!data.items.length) writeTool(response, 'present_results', { answer: '没有找到符合描述的收藏，你还记得它的用途或编程语言吗？', results: [] });
    else writeTool(response, 'read_item', { itemId: data.items[0].itemId, query: 'terminal UI' }, '正在核对候选资料的来源。');
  } else if (lastCall?.function.name === 'read_item' || lastCall?.function.name === 'present_results') {
    const read = toolMessages.find(message => body.messages.flatMap(value => value.tool_calls ?? []).some(call => call.id === message.tool_call_id && call.function.name === 'read_item'))!;
    const data = JSON.parse(read.content!);
    const finalAnswer = lastCall?.function.name === 'present_results' && !invalidCitation ? '已重新核对来源：Terminal Garden 支持终端交互界面。' : answer;
    writeTool(response, 'present_results', { answer: finalAnswer, results: [{ itemId: data.item.itemId, quote: invalidCitation ? 'Invented unsupported capability absent from the saved source.' : data.item.snippets[0], reason: '原文明确描述了 terminal UI 功能。' }] });
  } else throw new Error('Unexpected tool step');
}

function fixtures(): Item[] {
  const now = '2026-09-22T00:00:00.000Z';
  const make = (id: string, url: string, title: string): Item => ({ id, url, normalizedUrl: url, title, source: 'github', domain: new URL(url).hostname, description: 'A TypeScript terminal UI toolkit for interactive command-line apps.', content: 'Terminal Garden provides terminal UI components and keyboard navigation for command-line applications.', excerpt: 'A terminal UI toolkit.', truncated: false, author: '', publishedAt: '', tags: ['terminal', 'cli'], keywords: ['terminal UI'], category: '', notes: 'DO-NOT-SEND-PRIVATE-NOTE', selections: ['DO-NOT-SEND-SELECTION'], summaryOverride: 'DO-NOT-SEND-OVERRIDE', tagsOverride: ['DO-NOT-SEND-TAG'], analysisStatus: 'disabled', createdAt: now, updatedAt: now, contentVersion: 1, githubVisibility: 'public', github: { owner: 'fixture', repo: id, language: 'TypeScript', license: 'MIT', stars: 100, topics: ['terminal'], fetchedAt: now } });
  return [make('terminal-garden', 'https://github.com/fixture/terminal-garden', 'Terminal Garden'), { ...make('private', 'https://github.com/fixture/private', 'DO-NOT-SEND-PRIVATE-REPO'), githubVisibility: 'private' }, { ...make('blocked', 'https://blocked.example/article', 'DO-NOT-SEND-BLOCKED'), source: 'article', github: undefined, githubVisibility: undefined }];
}
async function openChat(page: Page) { await page.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '对话查询', exact: true }).click(); }
async function send(page: Page, question: string) { await page.getByRole('textbox', { name: '描述你想找的资料' }).fill(question); await page.getByRole('button', { name: '发送', exact: true }).click(); }

test('real framework searches via standard tools, streams, follows up, persists and cancels safely', async () => {
  test.setTimeout(240000);
  requests.length = 0; count = 0; failNext = false; holdNext = false; delayNextMs = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    requests.push(text);
    if (failNext) { failNext = false; response.writeHead(503); response.end('fixture unavailable'); return; }
    const body = JSON.parse(text);
    if (delayNextMs) {
      const delay = delayNextMs; delayNextMs = 0;
      const timer = setTimeout(() => { if (!response.destroyed) responseFor(body, response); }, delay);
      response.on('close', () => clearTimeout(timer)); return;
    }
    if (holdNext) { holdNext = false; held = response; heldReply = () => { if (!response.destroyed) responseFor(body, response); }; return; }
    try { responseFor(body, response); } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const profile = await mkdtemp(join(tmpdir(), 'starts-agent-browser-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'zh-CN', headless: true, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const errors: string[] = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const library = await context.newPage(); await library.goto(`${base}/library.html`); await openChat(library);
    await expect(library.getByText('启用对话查询', { exact: true })).toBeVisible();
    await expect(library.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect(requests).toHaveLength(0);
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    await options.getByLabel('选择 JSON 备份文件').setInputFiles({ name: 'agent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: '2026-09-22T00:00:00.000Z', items: fixtures() })) });
    await options.getByRole('button', { name: '确认导入 3 条', exact: true }).click();
    await expect(options.getByText('导入完成：新增 3 条，跳过 0 条重复收藏。', { exact: true })).toBeVisible();
    await expect(options.getByLabel('服务地址', { exact: true })).toHaveValue('https://api.x.ai/v1');
    await options.getByLabel('服务地址', { exact: true }).fill(endpoint);
    await options.getByLabel('模型', { exact: true }).fill('query-fixture');
    await options.getByLabel('API Key', { exact: true }).fill('fixture-secret-key');
    await options.getByLabel('禁止分析的域名', { exact: true }).fill('blocked.example');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await expect(options.getByLabel('服务地址', { exact: true })).toHaveValue(endpoint);
    await expect(options.getByLabel('模型', { exact: true })).toHaveValue('query-fixture');
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByText(/设置已保存，对话查询已启用/)).toBeVisible();
    await expect(options.getByLabel('服务地址', { exact: true })).toHaveValue(endpoint);
    await expect(options.getByRole('switch', { name: '启用 AI 分析', exact: true })).not.toBeChecked();
    expect(requests).toHaveLength(0);
    delayNextMs = 35000;
    const probeStarted = Date.now();
    await options.getByRole('button', { name: '测试 Agent 连接', exact: true }).click();
    await expect(options.getByText('Agent 连接可用，模型 query-fixture 已通过工具调用测试。', { exact: true })).toBeVisible({ timeout: 60000 });
    expect(Date.now() - probeStarted).toBeGreaterThanOrEqual(34000);
    expect(requests).toHaveLength(1);
    delayNextMs = 35000;
    const slowQueryStarted = Date.now();
    await send(library, '那个能做终端交互界面的工具叫什么？');
    await expect(library.getByRole('timer')).toBeVisible();
    await library.screenshot({ path: 'test-results/beautiful-agent-waiting.png', animations: 'disabled' });
    await expect(library.getByRole('button', { name: '查看引用：Terminal Garden', exact: true })).toBeVisible({ timeout: 60000 });
    expect(Date.now() - slowQueryStarted).toBeGreaterThanOrEqual(34000);
    await expect(library.getByText(answer, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(4);
    expect(requests.join('\n')).not.toContain('DO-NOT-SEND');
    await library.locator('.chat-run summary').last().click();
    await expect(library.getByText('读取了 1 条候选收藏', { exact: true })).toBeVisible();
    await library.screenshot({ path: 'test-results/agent-desktop.png', fullPage: true, animations: 'disabled' });
    await library.getByRole('button', { name: '查看引用：Terminal Garden', exact: true }).click();
    await expect(library.getByRole('heading', { name: 'Terminal Garden', exact: true })).toBeVisible();
    await library.getByRole('button', { name: '关闭弹窗' }).last().click();
    await send(library, '只看 TypeScript 的');
    await expect(library.locator('.chat-message-user')).toHaveCount(2);
    await expect(library.locator('.chat-message-assistant')).toHaveCount(2);
    await expect(library.locator('.chat-message-assistant').last().getByText(answer, { exact: true })).toBeVisible();
    const followup = requests.map(value => JSON.parse(value)).find(value => value.messages?.some((message: ModelMessage) => message.role === 'user' && message.content?.includes('只看 TypeScript')));
    expect(followup.messages.find((message: ModelMessage) => message.role === 'user').content).toContain('那个能做终端交互界面的工具叫什么');
    const sidebar = await context.newPage(); await sidebar.goto(`${base}/sidepanel.html`); await sidebar.setViewportSize({ width: 390, height: 844 }); await sidebar.emulateMedia({ colorScheme: 'dark' }); await openChat(sidebar);
    await expect(sidebar.locator('.chat-message-user')).toHaveCount(2);
    await expect(sidebar.locator('.chat-message-assistant')).toHaveCount(2);
    expect(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await sidebar.screenshot({ path: 'test-results/agent-sidepanel-dark.png', animations: 'disabled' });
    const beforeLayout = requests.length;
    const draft = sidebar.getByRole('textbox', { name: '描述你想找的资料' });
    await draft.fill('暂不发送的查询草稿');
    await draft.dispatchEvent('compositionstart');
    await draft.press('Enter');
    await draft.dispatchEvent('compositionend');
    const preservedDraft = await draft.inputValue();
    expect(requests).toHaveLength(beforeLayout);
    for (const theme of ['light', 'dark'] as const) {
      await sidebar.emulateMedia({ colorScheme: theme });
      for (const [width, height] of [[280, 480], [320, 360], [540, 600]]) {
        await sidebar.setViewportSize({ width: width!, height: height! });
        const box = (await sidebar.locator('.chat-composer').boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width!);
        expect(box.y + box.height).toBeLessThanOrEqual(height!);
        expect(await sidebar.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await sidebar.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '资料库', exact: true }).click();
    await openChat(sidebar); await expect(draft).toHaveValue(preservedDraft);
    await draft.fill(''); await sidebar.setViewportSize({ width: 390, height: 844 });
    expect(requests).toHaveLength(beforeLayout);
    await send(sidebar, '不存在的收藏');
    await expect(sidebar.getByText('没有找到符合描述的收藏，你还记得它的用途或编程语言吗？', { exact: true })).toBeVisible();
    await expect(sidebar.locator('.chat-message-assistant').last().locator('.chat-result-card')).toHaveCount(0);
    const beforeFailure = requests.length;
    failNext = true; await send(sidebar, '失败测试');
    await expect(sidebar.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    expect(requests.length).toBe(beforeFailure + 1);
    await expect(sidebar.locator('.chat-message-assistant').last().locator('.chat-result-card')).toHaveCount(0);
    await sidebar.getByRole('button', { name: '重试', exact: true }).click();
    await expect(sidebar.locator('.chat-message-assistant').last().getByText(answer, { exact: true })).toBeVisible();
    expect(requests.length).toBe(beforeFailure + 4);
    holdNext = true; const beforeStop = requests.length; await send(sidebar, '停止测试');
    await expect.poll(() => requests.length).toBe(beforeStop + 1);
    await sidebar.getByRole('button', { name: '停止查询', exact: true }).click();
    await expect(sidebar.locator('.chat-message-assistant').last().getByText('已停止', { exact: true })).toBeVisible();
    heldReply?.();
    await expect(sidebar.locator('.chat-message-assistant').last().getByRole('button', { name: '查看引用：Terminal Garden' })).toHaveCount(0);
    await sidebar.reload(); await openChat(sidebar);
    await expect(sidebar.locator('.chat-message-user')).toHaveCount(5);
    await expect(sidebar.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    const protocol = await context.newCDPSession(sidebar);
    const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
    protocol.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
    await protocol.send('ServiceWorker.enable');
    holdNext = true; const beforeRestart = requests.length; await send(sidebar, '后台重启测试');
    await expect.poll(() => requests.length).toBe(beforeRestart + 1);
    await expect.poll(() => [...versions.values()].some(version => version.scriptURL.startsWith(base) && version.runningStatus === 'running')).toBe(true);
    const activeWorker = [...versions.values()].find(version => version.scriptURL.startsWith(base) && version.runningStatus === 'running')!;
    await protocol.send('ServiceWorker.stopWorker', { versionId: activeWorker.versionId });
    heldReply?.();
    await sidebar.reload(); await openChat(sidebar);
    await expect(sidebar.locator('.chat-message-assistant').last().getByText('查询中断', { exact: true })).toBeVisible();
    await expect(sidebar.locator('.chat-message-assistant').last().locator('.chat-result-card')).toHaveCount(0);
    expect(requests.length).toBe(beforeRestart + 1);
    await sidebar.getByRole('button', { name: '重试', exact: true }).click();
    await expect(sidebar.locator('.chat-message-assistant').last().getByText(answer, { exact: true })).toBeVisible();
    await protocol.detach();
    holdNext = true; const beforeSettings = requests.length; await send(sidebar, '配置变化停止测试');
    await expect.poll(() => requests.length).toBe(beforeSettings + 1);
    await options.reload();
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(sidebar.locator('.chat-message-assistant').last().getByText('已停止', { exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    heldReply?.();
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await options.getByLabel('单次模型请求超时（秒）', { exact: true }).fill('30');
    await options.getByLabel('整轮查询超时（秒）', { exact: true }).fill('60');
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByText(/设置已保存，对话查询已启用/)).toBeVisible();
    delayNextMs = 35000; const beforeTimeout = requests.length; const deadlineStart = Date.now();
    await send(sidebar, '验证配置的超时');
    await expect(sidebar.locator('.chat-message-assistant').last().getByText(/超时/).first()).toBeVisible({ timeout: 45000 });
    expect(Date.now() - deadlineStart).toBeGreaterThanOrEqual(29000);
    expect(requests.length).toBe(beforeTimeout + 1);
    await expect(sidebar.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    holdNext = true; const beforeDelete = requests.length; await send(sidebar, '删除运行中的对话');
    await expect.poll(() => requests.length).toBe(beforeDelete + 1);
    await sidebar.getByRole('button', { name: '删除对话', exact: true }).click();
    await sidebar.getByRole('dialog', { name: '删除对话' }).getByRole('button', { name: '确认删除', exact: true }).click();
    heldReply?.();
    await sidebar.reload(); await openChat(sidebar);
    await expect(sidebar.locator('.chat-message-user')).toHaveCount(0);
    await expect(library.locator('.chat-message-user')).toHaveCount(0);
    await library.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '资料库', exact: true }).click();
    await expect(library.locator('.item-list > li')).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally { held?.destroy(); await context.close(); server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); await rm(profile, { recursive: true, force: true }); }
});


test('only final selections become cards across repair, history, deletion and chat surfaces', async () => {
  test.setTimeout(180000);
  type Evidence = { itemId: string; title: string; snippets: string[] };
  let mode: 'success' | 'no-match' | 'failure' | 'repair' | 'hold' | 'identity' = 'hold';
  let paused: ServerResponse | undefined;
  let resume: (() => void) | undefined;
  const searchCounts: number[] = [];
  let selected: Evidence[] = [];
  let unselected: Evidence | undefined;
  const imported = Array.from({ length: 12 }, (_, index): Item => {
    const id = `terminal-${String(index + 1).padStart(2, '0')}`;
    return { ...fixtures()[0]!, id, title: `Terminal Toolkit ${index + 1}`, url: `https://github.com/fixture/${id}`, normalizedUrl: `https://github.com/fixture/${id}` };
  });
  function respond(body: { messages: ModelMessage[] }, response: ServerResponse) {
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    const calls = body.messages.flatMap(message => message.tool_calls ?? []);
    const last = toolMessages.at(-1);
    const call = calls.find(value => value.id === last?.tool_call_id);
    if (!last) { writeTool(response, 'search_library', { queries: ['terminal UI'] }); return; }
    const search = toolMessages.find(message => calls.some(value => value.id === message.tool_call_id && value.function.name === 'search_library'))!;
    const candidates: Evidence[] = JSON.parse(search.content!).items;
    if (call?.function.name === 'search_library') {
      searchCounts.push(candidates.length);
      selected = [candidates[10]!, candidates[1]!];
      unselected = candidates[0]!;
      if (mode === 'hold') {
        paused = response;
        resume = () => { if (!response.destroyed) writeTool(response, 'read_item', { itemId: unselected!.itemId, query: 'terminal UI' }); };
        return;
      }
      writeTool(response, 'read_item', { itemId: unselected.itemId, query: 'terminal UI' });
      return;
    }
    const invalid = mode === 'failure' || (mode === 'repair' && call?.function.name !== 'present_results');
    writeTool(response, 'present_results', {
      answer: mode === 'no-match' ? '没有找到符合本次要求的收藏。' : invalid ? '正在核对所选来源。' : mode === 'identity' ? '确认这两条收藏的名称。' : '推荐两条收藏，按本次选择顺序展示。',
      results: mode === 'no-match' ? [] : invalid
        ? [{ itemId: unselected!.itemId, quote: 'Invented unsupported capability absent from the saved source.', reason: '此引用需要修复。' }]
        : selected.map(item => ({ itemId: item.itemId, quote: mode === 'identity' ? item.title : item.snippets[0], reason: mode === 'identity' ? '仅确认名称。' : '原文描述了终端界面功能。', ...(mode === 'identity' ? { kind: 'identity' } : {}) })),
    });
  }
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    try { respond(JSON.parse(text), response); } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const profile = await mkdtemp(join(tmpdir(), 'starts-agent-cards-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'zh-CN', headless: true, reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const errors: string[] = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const library = await context.newPage(); await library.goto(`${base}/library.html`);
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    await options.getByLabel('选择 JSON 备份文件').setInputFiles({ name: 'cards.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: '2026-09-22T00:00:00.000Z', items: imported })) });
    await options.getByRole('button', { name: '确认导入 12 条', exact: true }).click();
    await expect(options.getByText('导入完成：新增 12 条，跳过 0 条重复收藏。', { exact: true })).toBeVisible();
    await options.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await options.getByLabel('模型', { exact: true }).fill('query-fixture');
    await options.getByLabel('API Key', { exact: true }).fill('fixture-secret-key');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByText(/设置已保存，对话查询已启用/)).toBeVisible();
    await openChat(library); await send(library, '查找终端界面工具');
    const latest = library.locator('.chat-message-assistant').last();
    await expect.poll(() => searchCounts).toEqual([12]);
    await expect(latest.getByText('查询中', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-result-card')).toHaveCount(0);
    await expect(latest.locator('.beautiful-context')).toHaveCount(0);
    mode = 'success'; resume!();
    await expect(latest.getByText('已完成', { exact: true })).toBeVisible();
    const names = selected.map(item => item.title);
    const ids = selected.map(item => item.itemId);
    const selectedItems = ids.map(id => imported.find(item => item.id === id)!);
    const unselectedItem = imported.find(item => item.id === unselected!.itemId)!;
    await expect(latest.locator('.chat-result-card')).toHaveCount(2);
    await expect(latest.locator('.beautiful-context-bar strong')).toHaveText(names);
    await expect(latest.getByRole('region', { name: '本次结果 · 2 条', exact: true })).toBeVisible();
    await expect(latest.locator('.beautiful-count')).toHaveText('2');
    await expect(latest.locator('.chat-run[open]')).toHaveCount(0);
    await expect(latest.locator('.chat-run-body')).not.toBeVisible();
    await latest.locator('.chat-run summary').click();
    await latest.getByRole('button', { name: /搜索了 1 组关键词/ }).click();
    await expect(latest.getByText('12 条资料', { exact: true })).toBeVisible();
    await latest.locator('.chat-run summary').click();
    await latest.getByRole('button', { name: `查看引用：${names[0]}`, exact: true }).click();
    await expect(library.getByRole('heading', { name: names[0], exact: true })).toBeVisible();
    await library.getByRole('button', { name: '关闭弹窗' }).last().click();
    const original = latest.getByRole('link', { name: `打开原网页：${names[0]}`, exact: true });
    await expect(original).toHaveAttribute('href', selectedItems[0]!.url);
    await expect(original).toHaveAttribute('target', '_blank');
    await expect(original).toHaveAttribute('rel', 'noopener noreferrer');
    await context.route(selectedItems[0]!.url, route => route.fulfill({ contentType: 'text/html', body: '<title>Original source fixture</title>' }));
    const popupReady = library.waitForEvent('popup'); await original.click();
    const popup = await popupReady; await expect(popup).toHaveURL(selectedItems[0]!.url); await popup.close();

    await library.reload(); await openChat(library);
    const sidebar = await context.newPage(); await sidebar.goto(`${base}/sidepanel.html`); await openChat(sidebar);
    for (const page of [library, sidebar]) {
      await page.reload(); await openChat(page);
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        for (const [width, height] of [[1440, 1000], [390, 844], [280, 480]]) {
          await page.setViewportSize({ width: width!, height: height! });
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('.chat-result-card')).toHaveCount(2);
          await expect(page.locator('.beautiful-context-bar strong')).toHaveText(names);
          await expect(page.locator('.beautiful-count')).toHaveText('2');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const cards = await page.locator('.chat-result-card').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth }; }));
          for (const card of cards) { expect(card.left).toBeGreaterThanOrEqual(0); expect(card.right).toBeLessThanOrEqual(card.width); }
          if (width !== 1440) await page.screenshot({ path: `test-results/agent-cards-${page === library ? 'library' : 'sidepanel'}-${theme}-${width}.png`, animations: 'disabled' });
        }
      }
    }
    await library.setViewportSize({ width: 1440, height: 1000 });
    mode = 'no-match'; await send(library, '按用途再次查找');
    await expect(latest.getByText('已完成', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-message-text')).toHaveText('没有找到符合本次要求的收藏。');
    await expect(latest.locator('.beautiful-context')).toHaveCount(0);
    await expect(library.locator('.chat-result-card')).toHaveCount(2);
    mode = 'failure'; await send(library, '核对来源功能');
    await expect(latest.getByText('查询失败', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-result-card')).toHaveCount(0);
    await expect(library.locator('.chat-result-card')).toHaveCount(2);
    mode = 'repair'; await latest.getByRole('button', { name: '重试', exact: true }).click();
    await expect(latest.getByText('已完成', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-result-card')).toHaveCount(2);
    await expect(latest.locator('.beautiful-context-bar strong')).toHaveText(names);
    await expect(latest.locator('[data-verification="verified"]')).toHaveCount(2);
    await expect(latest.locator('.beautiful-context').getByRole('button', { name: `查看引用：${unselectedItem.title}`, exact: true })).toHaveCount(0);
    await expect(latest.locator('.chat-run[open]')).toHaveCount(0);
    await latest.locator('.chat-run summary').last().click();
    await expect(latest.getByText('引用不匹配，正在根据原文纠正', { exact: true }).last()).toBeVisible();
    await latest.locator('.chat-run summary').last().click();
    await expect(library.locator('.chat-result-card')).toHaveCount(4);

    mode = 'hold'; await send(library, '继续查找终端界面工具');
    await expect.poll(() => searchCounts.length).toBe(5);
    await expect(latest.getByText('查询中', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-result-card')).toHaveCount(0);
    await library.getByRole('button', { name: '停止查询', exact: true }).click();
    await expect(latest.getByText('已停止', { exact: true })).toBeVisible();
    await expect(latest.locator('.chat-result-card')).toHaveCount(0);
    paused?.destroy();
    mode = 'identity'; await send(library, '列出收藏名称');
    await expect(latest.getByText('已完成', { exact: true })).toBeVisible();
    await expect(latest.locator('.beautiful-context-bar strong')).toHaveText(names);
    await expect(latest.getByText('仅确认收藏身份', { exact: true })).toHaveCount(2);
    await expect(latest.getByText('已核验引用', { exact: true })).toHaveCount(0);
    expect(searchCounts).toEqual([12, 12, 12, 12, 12, 12]);

    await library.evaluate(async ({ selectedIds, excludedId }) => {
      const database = await new Promise<IDBDatabase>((resolveDb, reject) => { const request = indexedDB.open('starts'); request.onsuccess = () => resolveDb(request.result); request.onerror = () => reject(request.error); });
      await new Promise<void>((resolveWrite, reject) => {
        const transaction = database.transaction(['chatMessages', 'chatRuns'], 'readwrite');
        const runs = transaction.objectStore('chatRuns');
        const messages = transaction.objectStore('chatMessages');
        const runRequest = runs.getAll();
        runRequest.onsuccess = () => {
          const run = runRequest.result.find(value => value.status === 'completed');
          const steps = ['browse_library', 'search_library', 'read_item', 'repair_citations', 'rerank_candidates'].map(tool => ({ tool, label: '旧版候选记录', resultIds: [excludedId, ...selectedIds], durationMs: 1, at: run.startedAt }));
          runs.put({ ...run, id: 'legacy-earlier-run', status: 'failed', steps });
          runs.put({ ...run, id: 'legacy-orphan-run', assistantMessageId: 'missing-assistant', startedAt: '2099-01-01T00:00:00.000Z', status: 'failed', steps });
          const messageRequest = messages.getAll();
          messageRequest.onsuccess = () => {
            const selectedMessage = messageRequest.result.find(value => value.citations.length === 2);
            for (const [index, status] of ['failed', 'stopped', 'running', 'interrupted'].entries()) {
              const id = `legacy-${status}`;
              messages.put({ ...selectedMessage, id, runId: id, status, text: `旧版${status}回答`, sequence: 100 + index });
              runs.put({ ...run, id, assistantMessageId: id, status, steps });
            }
          };
        };
        transaction.oncomplete = () => resolveWrite(); transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    }, { selectedIds: ids, excludedId: unselectedItem.id });
    for (const page of [library, sidebar]) {
      await page.reload(); await openChat(page);
      await expect(page.locator('.chat-result-card')).toHaveCount(6);
      await expect(page.locator('.beautiful-context-bar strong')).toHaveText([...names, ...names, ...names]);
      for (const status of ['failed', 'stopped', 'running', 'interrupted']) {
        await expect(page.locator(`[data-message-id="legacy-${status}"] .beautiful-context`)).toHaveCount(0);
      }
      await expect(page.locator('.chat-run[open]')).toHaveCount(0);
    }

    await library.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '资料库', exact: true }).click();
    await library.getByRole('button', { name: `查看详情：${unselectedItem.title}`, exact: true }).click();
    await library.getByRole('button', { name: '删除收藏', exact: true }).click();
    await library.getByRole('button', { name: '确认删除', exact: true }).click();
    await openChat(library);
    await expect(library.locator('.chat-result-card')).toHaveCount(6);
    await expect(library.locator('.chat-citation-missing')).toHaveCount(0);
    await expect(library.locator('.beautiful-context-bar strong')).toHaveText([...names, ...names, ...names]);
    await library.evaluate(async id => {
      const database = await new Promise<IDBDatabase>((resolveDb, reject) => { const request = indexedDB.open('starts'); request.onsuccess = () => resolveDb(request.result); request.onerror = () => reject(request.error); });
      await new Promise<void>((resolveWrite, reject) => {
        const transaction = database.transaction(['items', 'chatMessages'], 'readwrite');
        const items = transaction.objectStore('items');
        const item = items.get(id);
        item.onsuccess = () => items.put({ ...item.result, title: 'Updated selected toolkit', description: 'Current saved description', url: 'javascript:alert(1)', contentVersion: item.result.contentVersion + 1 });
        const messages = transaction.objectStore('chatMessages');
        const request = messages.getAll();
        request.onsuccess = () => { for (const message of request.result) { message.citations = message.citations.map((citation: { itemId: string }) => citation.itemId === id ? { ...citation, title: 'DO-NOT-SEND-STALE-TITLE', url: 'https://stale.example/private', quote: 'DO-NOT-SEND-STALE-QUOTE', reason: 'DO-NOT-SEND-STALE-REASON' } : citation); messages.put(message); } };
        transaction.oncomplete = () => resolveWrite(); transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    }, ids[0]!);
    await library.reload(); await openChat(library);
    const results = library.locator('.chat-message-assistant').filter({ has: library.locator('.beautiful-context') });
    await expect(results).toHaveCount(3);
    await expect(results.first().getByRole('button', { name: '查看收藏：Updated selected toolkit', exact: true })).toBeAttached();
    await expect(results.first().locator('[data-verification="changed"]')).toContainText('来源已变更');
    await expect(results.first().locator('[data-verification="changed"]')).toContainText('Current saved description');
    await expect(library.locator('.chat-panel').getByRole('link', { name: '打开原网页：Updated selected toolkit', exact: true })).toHaveCount(0);
    await expect(library.locator('.chat-panel')).not.toContainText('DO-NOT-SEND');
    await expect(library.locator('.chat-panel')).not.toContainText('检索候选');
    await results.first().getByRole('button', { name: `查看引用：${names[1]}`, exact: true }).click();
    await library.getByRole('button', { name: '删除收藏', exact: true }).click();
    await library.getByRole('button', { name: '确认删除', exact: true }).click();
    for (const page of [library, sidebar]) {
      await page.reload(); await openChat(page);
      await expect(page.locator('.chat-result-card')).toHaveCount(3);
      await expect(page.locator('.chat-citation-missing')).toHaveText(['收藏 2 已删除或不可用', '收藏 2 已删除或不可用', '收藏 2 已删除或不可用']);
      await expect(page.locator('.beautiful-count')).toHaveText(['2', '2', '2']);
      await expect(page.locator('.beautiful-context-bar strong')).toHaveText(['Updated selected toolkit', 'Updated selected toolkit', 'Updated selected toolkit']);
      await expect(page.locator('.chat-panel').getByRole('link', { name: `打开原网页：${names[1]}`, exact: true })).toHaveCount(0);
      await expect(page.locator('.chat-panel')).not.toContainText('DO-NOT-SEND');
      await expect(page.locator('.chat-run[open]')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally { paused?.destroy(); await context.close(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); await rm(profile, { recursive: true, force: true }); }
});
