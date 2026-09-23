import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Item } from '../../lib/types';

const first = '## 查询结果\n\n1. **Terminal Garden**（TypeScript）\n   - 一个终端界面工具。\n\n';
const middle = Array.from({ length: 12 }, (_, index) => `### 使用场景 ${index + 1}\n\n逐步向下显示内容，已显示的段落应保持在原来的位置。\n\n`).join('');
const end = '## 最后一段\n\n```ts\nconst ready = true;\n```\n\n| 名称 | 语言 |\n| --- | --- |\n| Terminal Garden | TypeScript |\n\n[不可信外链](https://untrusted.example/)\n\n<script>window.__markdownExecuted = true</script>\n\n![跟踪图片](https://tracking.example/pixel.png)';
const readme = '# Terminal Garden\n\n**A terminal UI toolkit**\n\n- [x] Keyboard support\n- [ ] More themes\n\n> Readable documentation\n\n```ts\nconst greeting = "hello";\n```\n\n| Feature | Status |\n| --- | --- |\n| Keyboard | Ready |\n\n[Guide](docs/guide.md)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.__markdownExecuted = true</script>\n\n![Tracking](https://tracking.example/pixel.png)';
function fixture(): Item {
  const now = '2026-09-23T00:00:00.000Z';
  return { id: 'markdown-fixture', url: 'https://github.com/fixture/terminal', normalizedUrl: 'https://github.com/fixture/terminal', title: 'Terminal Garden', description: 'terminal UI toolkit', source: 'github', domain: 'github.com', excerpt: '', content: readme, truncated: false, tags: [], keywords: [], category: '', author: '', publishedAt: '', notes: '', selections: [], analysisStatus: 'disabled', createdAt: now, updatedAt: now, contentVersion: 1, githubVisibility: 'public', github: { owner: 'fixture', repo: 'terminal', language: 'TypeScript', license: 'MIT', topics: [], stars: 1, fetchedAt: now } };
}
async function openChat(page: Page) { await page.getByRole('group', { name: '浏览模式' }).getByRole('button', { name: '对话查询', exact: true }).click(); }

test('Markdown streams top to bottom, README renders and controls fit narrow headers', async () => {
  test.setTimeout(60000);
  let stream: ServerResponse | undefined;
  let writeNext: (() => void) | undefined;
  let finish: (() => void) | undefined;
  let serial = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const hasResults = body.messages.some((message: { role: string }) => message.role === 'tool');
    const name = hasResults ? 'present_results' : 'search_library';
    const id = `call-${++serial}`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const send = (args: string, initial = false) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(initial ? { id, type: 'function' } : {}), function: { ...(initial ? { name } : {}), arguments: args } }] }, finish_reason: null }] })}\n\n`);
    const done = () => { response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`); response.end('data: [DONE]\n\n'); };
    if (!hasResults) { send(JSON.stringify({ queries: ['terminal UI'] }), true); done(); return; }
    stream = response;
    const fragment = (value: string) => JSON.stringify(value).slice(1, -1);
    send('{"answer":"' + fragment(first), true);
    writeNext = () => { send(fragment(middle)); };
    finish = () => { send(fragment(end) + '","results":[{"itemId":"markdown-fixture","quote":"terminal UI toolkit","reason":"来源描述相符"}]}'); done(); };
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture server');
  const profile = await mkdtemp(join(tmpdir(), 'starts-markdown-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'zh-CN', headless: true, reducedMotion: 'reduce', viewport: { width: 1280, height: 900 }, args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const errors: string[] = []; const tracking: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => { if (request.url().includes('tracking.example')) tracking.push(request.url()); });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    await options.getByLabel('选择 JSON 备份文件').setInputFiles({ name: 'markdown.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: fixture().createdAt, items: [fixture()] })) });
    await options.getByRole('button', { name: '确认导入 1 条', exact: true }).click();
    await expect(options.getByText('导入完成：新增 1 条，跳过 0 条重复收藏。')).toBeVisible();
    await options.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await options.getByLabel('模型', { exact: true }).fill('markdown-model');
    await options.getByLabel('API Key', { exact: true }).fill('fixture-key');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: '启用对话查询', exact: true }) }).click();
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByText(/设置已保存，对话查询已启用/)).toBeVisible();
    const page = await context.newPage(); await page.goto(`${base}/sidepanel.html`); await page.setViewportSize({ width: 390, height: 844 });
    for (const width of [280, 390, 760]) {
      await page.setViewportSize({ width, height: 844 });
      const group = page.getByRole('group', { name: '浏览模式' });
      const brandBox = (await page.locator('.library-header .brand').boundingBox())!;
      const groupBox = (await group.boundingBox())!;
      expect(brandBox.x + brandBox.width).toBeLessThanOrEqual(groupBox.x);
      await expect(group.getByRole('button', { name: '资料库', exact: true })).toHaveText('');
      await expect(group.getByRole('button', { name: '对话查询', exact: true })).toHaveText('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '查看详情：Terminal Garden' }).click();
    await page.getByRole('tab', { name: 'README', exact: true }).click();
    const content = page.locator('.content-text');
    await expect(content.locator('h1')).toHaveText('Terminal Garden');
    await expect(content.locator('strong')).toHaveText('A terminal UI toolkit');
    await expect(content.locator('table')).toHaveCount(1); await expect(content.locator('pre code')).toContainText('const greeting');
    await expect(content.getByRole('link', { name: 'Guide', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/terminal/blob/HEAD/docs/guide.md');
    expect(await content.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(tracking).toEqual([]);
    await context.route('https://tracking.example/pixel.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
    await content.getByRole('button', { name: '加载图片', exact: true }).click();
    await expect(content.locator('img')).toHaveCount(1);
    await expect.poll(() => tracking.length).toBe(1);
    tracking.length = 0;
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: 'test-results/readme-markdown-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await openChat(page);
    await page.getByRole('textbox', { name: '描述你想找的资料' }).fill('找终端工具');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const reply = page.locator('.chat-message-assistant').last();
    await expect(reply.getByRole('heading', { name: '查询结果', exact: true })).toBeVisible();
    await expect(reply.locator('.chat-message-text strong')).toHaveText('Terminal Garden');
    await expect(page.getByRole('button', { name: '停止查询', exact: true })).toBeVisible();
    await expect(reply.getByRole('button', { name: '查看引用：Terminal Garden', exact: true })).toHaveCount(0);
    await expect(reply.locator('.chat-citations')).toHaveCount(0);
    await expect(reply.locator('.chat-result-card')).toHaveCount(0);
    const top = await page.locator('.chat-messages').evaluate(node => node.scrollTop);
    writeNext!();
    await expect(reply.getByRole('heading', { name: '使用场景 12', exact: true })).toBeAttached();
    expect(await page.locator('.chat-messages').evaluate(node => node.scrollTop)).toBeLessThanOrEqual(top + 2);
    await page.screenshot({ path: 'test-results/chat-markdown-streaming.png', animations: 'disabled' });
    finish!();
    await expect(reply.getByRole('button', { name: '查看引用：Terminal Garden', exact: true })).toBeAttached();
    await expect(reply.locator('.chat-result-card')).toHaveCount(1);
    await expect(reply.getByRole('region', { name: '本次结果 · 1 条', exact: true })).toBeAttached();
    await expect(reply.locator('table')).toHaveCount(1); await expect(reply.locator('pre code')).toContainText('const ready');
    const headings = await reply.locator('h2,h3').allTextContents();
    expect(headings[0]).toBe('查询结果'); expect(headings.at(-1)).toBe('最后一段');
    expect(await reply.locator('.chat-message-text a').count()).toBe(0); expect(tracking).toEqual([]);
    expect(await page.evaluate(() => '__markdownExecuted' in window)).toBe(false);
    await page.getByRole('button', { name: '查看最新内容', exact: true }).click();
    await expect(reply.getByRole('button', { name: '查看引用：Terminal Garden', exact: true })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: 'test-results/chat-markdown-light.png', animations: 'disabled' });
    await page.reload(); await openChat(page);
    await expect(page.locator('.chat-message-assistant h2').first()).toHaveText('查询结果');
    const library = await context.newPage(); await library.goto(`${base}/library.html`); await openChat(library);
    await expect(library.locator('.chat-message-assistant h2').first()).toHaveText('查询结果');
    await library.screenshot({ path: 'test-results/chat-markdown-desktop.png', animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally { stream?.destroy(); await context.close(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); await rm(profile, { recursive: true, force: true }); }
});
