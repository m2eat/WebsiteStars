import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function noChineseChrome(page: Page) {
  const texts = await page.locator('body').evaluate(body => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const values: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('script,style')) values.push(node.textContent ?? '');
    }
    return values.join(' ');
  });
  expect(texts).not.toMatch(/[\u3400-\u9fff]/u);
}

for (const locale of ['en-US', 'zh-CN', 'fr-FR']) {
  test(`browser language ${locale} controls all empty extension pages`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'websitestars-locale-'));
    const extension = resolve('.output/chrome-mv3');
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale, headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const base = `chrome-extension://${new URL(worker.url()).hostname}`;
      for (const route of ['library', 'sidepanel', 'options']) {
        const page = await context.newPage(); await page.goto(`${base}/${route}.html`);
        await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh-CN' ? 'zh-CN' : 'en');
        await expect(page).toHaveTitle(/WebsiteStars/);
        await expect(page.locator('.brand').first()).toContainText('WebsiteStars');
        if (route !== 'options') {
          await page.getByRole('group', { name: locale === 'zh-CN' ? '浏览模式' : 'View mode' }).getByRole('button', { name: locale === 'zh-CN' ? '对话查询' : 'Chat search', exact: true }).click();
          await expect(page.getByRole('button', { name: locale === 'zh-CN' ? '发送' : 'Send', exact: true })).toBeDisabled();
        }
        if (locale !== 'zh-CN') await noChineseChrome(page);
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          }
        }
        await page.close();
      }
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

test('English capture, edit, search, backup, chat and injected controls preserve shared data', async () => {
  test.setTimeout(90000);
  let call = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const prompt = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
    const identity = prompt.question.includes('name only');
    const source = prompt.catalog.items.find((item: { title: string }) => item.title === 'Preserved 中文 title');
    const args = { answer: 'Here is the saved article.', results: [{ itemId: source.itemId, evidenceId: identity ? source.titleId : source.descriptionId, reason: 'The saved description matches.', ...(identity ? { kind: 'identity' } : {}) }] };
    const id = `i18n-${++call}`;
    const packet = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    response.end(packet({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'present_results', arguments: JSON.stringify(args) } }] }) + packet({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No model port');
  const profile = await mkdtemp(join(tmpdir(), 'websitestars-english-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'en-US', headless: true, viewport: { width: 1280, height: 900 },
    args: ['--no-proxy-server', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const errors: string[] = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    await context.route('https://locale.example/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><title>Original article</title><meta name="description" content="A saved article about browser tools."><article><h1>Original article</h1>' + '<p>This article describes local browser tools and searching saved resources.</p>'.repeat(15) + '</article></html>' }));
    await context.route('https://github.com/i18n-fixture/tool', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GitHub fixture</title><div id="repository-container-header"><ul class="pagehead-actions"><li><form action="/i18n-fixture/tool/star"><button type="submit" aria-label="Star this repository">Star</button></form></li></ul></div>' }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).hostname}`;
    const library = await context.newPage(); await library.goto(`${base}/library.html`);
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    const sidebar = await context.newPage(); await sidebar.goto(`${base}/sidepanel.html`);
    const article = await context.newPage(); await article.goto('https://locale.example/article');
    await expect(article.getByRole('button', { name: 'Save this page to WebsiteStars', exact: true })).toBeVisible();
    await article.getByRole('button', { name: 'Collapse to the edge', exact: true }).click();
    await article.getByRole('button', { name: 'Expand save button', exact: true }).click();
    await expect(library.locator('.item-list > li')).toHaveCount(0);
    await article.getByRole('button', { name: 'Save this page to WebsiteStars', exact: true }).click();
    await expect(library.getByRole('button', { name: 'View details: Original article' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'View details: Original article' })).toBeVisible();
    await library.getByRole('button', { name: 'View details: Original article' }).click();
    await library.getByRole('tab', { name: 'Content', exact: true }).click();
    await expect(library.locator('.content-text')).toContainText('local browser tools');
    await library.getByRole('button', { name: 'Edit', exact: true }).click();
    await library.getByLabel('Title', { exact: true }).fill('Preserved 中文 title');
    await library.getByLabel('Private notes', { exact: true }).fill('私人笔记 stays unchanged');
    await library.getByRole('button', { name: 'Save changes', exact: true }).click();
    await library.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await sidebar.getByRole('searchbox', { name: 'Search bookmarks', exact: true }).fill('中文');
    await expect(sidebar.getByRole('button', { name: 'View details: Preserved 中文 title' })).toBeVisible();
    await sidebar.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await expect(sidebar.getByRole('searchbox', { name: 'Search bookmarks', exact: true })).toHaveValue('中文');
    await options.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(options.getByText('Settings saved. AI is disabled. Local bookmarks and search remain available.', { exact: true })).toBeVisible();
    const downloadReady = options.waitForEvent('download'); await options.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const download = await downloadReady; expect(download.suggestedFilename()).toMatch(/^websitestars-backup-/);
    const backup = await readFile((await download.path())!, 'utf8'); expect(backup).toContain('私人笔记 stays unchanged');
    await options.getByLabel('Choose a JSON backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await options.getByRole('button', { name: 'Confirm import of 1 bookmarks', exact: true }).click();
    await expect(options.getByText('Import complete: 0 bookmarks added and 1 duplicates skipped.', { exact: true })).toBeVisible();
    await options.getByLabel('Choose a JSON backup file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('not-json') });
    await expect(options.getByRole('alert').or(options.locator('.feedback-error')).first()).toBeVisible();
    await noChineseChrome(options);
    await options.getByLabel('Service URL', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await options.getByLabel('Model', { exact: true }).fill('fixture');
    await options.getByLabel('API Key', { exact: true }).fill('fixture');
    await options.locator('label').filter({ has: options.getByRole('switch', { name: 'Enable chat search', exact: true }) }).click();
    await options.getByRole('button', { name: 'Save settings', exact: true }).click();
    await library.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Chat search', exact: true }).click();
    await library.getByRole('textbox', { name: 'Describe what you want to find' }).fill('Find my browser article');
    await library.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(library.getByText('Here is the saved article.', { exact: true })).toBeVisible();
    await expect(library.locator('.chat-result-card')).toHaveCount(1);
    await library.locator('.chat-run summary').click();
    expect(await library.locator('.chat-run').innerText()).not.toMatch(/[\u3400-\u9fff]/u);
    await sidebar.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Chat search', exact: true }).click();
    await expect(sidebar.getByText('Here is the saved article.', { exact: true })).toBeVisible();
    await library.getByRole('textbox', { name: 'Describe what you want to find' }).fill('Show the name only');
    await library.getByRole('button', { name: 'Send', exact: true }).click();
    const lastReply = library.locator('.chat-message-assistant').last();
    await expect(lastReply.getByText('Bookmark identity confirmed only', { exact: true })).toBeVisible();
    await expect(lastReply).toContainText('Used only to identify the saved item, not as evidence of its capabilities.');
    const github = await context.newPage(); await github.goto('https://github.com/i18n-fixture/tool');
    await expect(github.getByRole('button', { name: 'Save tool to WebsiteStars', exact: true })).toBeVisible();
    for (const page of [library, sidebar, options]) {
      await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await sidebar.screenshot({ path: 'test-results/websitestars-chat-en-mobile.png', animations: 'disabled' });
    await library.reload(); await expect(library.locator('html')).toHaveAttribute('lang', 'en');
    expect(errors).toEqual([]);
  } finally {
    await context.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await rm(profile, { recursive: true, force: true });
  }
});
