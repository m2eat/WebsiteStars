import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../ui/Markdown';
import { StreamText } from '../ui/beautiful/primitives';

const baseUrl = 'https://github.com/owner/repo/blob/HEAD/';

function render(text: string, mode: 'chat' | 'readme' = 'readme', base: string | undefined = baseUrl) {
  return renderToStaticMarkup(<Markdown text={text} mode={mode} baseUrl={base} />);
}

describe('Markdown rendering', () => {
  it('renders semantic headings, emphasis, lists, quotes and fenced code', () => {
    const html = render('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n**bold** and *italic* and ~~removed~~\n\n- bullet\n\n1. ordered\n\n> quote\n\n`inline`\n\n```ts\nconst value = "<tag>";\n```');
    for (const [index, title] of ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].entries()) {
      expect(html).toContain(`<h${index + 1}>${title}</h${index + 1}>`);
    }
    for (const tag of ['<strong>bold</strong>', '<em>italic</em>', '<del>removed</del>', '<ul>', '<ol>', '<li>bullet</li>', '<blockquote>', '<code>inline</code>']) expect(html).toContain(tag);
    expect(html).toContain('<pre tabindex="0" aria-label="代码块，可横向滚动"><code class="language-ts">');
    expect(html).toContain('&lt;tag&gt;');
    expect(html).not.toContain('<tag>');
  });

  it('renders GFM tables in a focusable scroll region and task lists as disabled checkboxes', () => {
    const html = render('| Name | State |\n| --- | --- |\n| task | done |\n\n- [x] finished\n- [ ] pending');
    expect(html).toContain('<div class="markdown-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0"><table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>done</td>');
    expect(html).toContain('class="contains-task-list"');
    expect(html).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*disabled="")(?=[^>]*checked="")[^>]*\/>/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it('keeps model-generated links and image URLs inert in chat mode', () => {
    const html = render('[A source](https://attacker.example/collect?secret=value)\n\nhttps://attacker.example/auto\n\n![private image](https://attacker.example/pixel)', 'chat');
    expect(html).toContain('A source');
    expect(html).toContain('private image');
    expect(html).not.toMatch(/<(?:a|img|button|link)\b/);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('collect?secret=value');
  });

  it('escapes raw HTML instead of mounting HTML elements or executing handlers', () => {
    const html = render('<script>alert(1)</script>\n\n<details><summary>More</summary>Body</details>\n\n<img src="https://attacker.example/pixel" onerror="alert(1)">');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;details&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(?:script|details|summary|img)\b/);
  });

  it('renders complete accumulated Markdown with the caret outside the parsed structure', () => {
    const html = renderToStaticMarkup(<StreamText text="**complete**" streaming />);
    expect(html).toContain('<strong>complete</strong>');
    expect(html).toContain('</p></div><span aria-hidden="true" class="beautiful-stream-caret"></span>');
    expect(html).not.toContain('beautiful-stream-tail');
    expect(renderToStaticMarkup(<StreamText text="**complete**" />)).not.toContain('beautiful-stream-caret');
  });

  it('renders every streaming prefix, including unfinished strong text and code fences', () => {
    const text = '**A streamed answer**\n\n```js\nconst value = "<script>";\n```\n\n| A | B |\n| --- | --- |\n| x | y |';
    for (let length = 0; length <= text.length; length++) {
      expect(() => renderToStaticMarkup(<StreamText text={text.slice(0, length)} streaming />)).not.toThrow();
    }
    expect(render('```js\nconst a = 1', 'chat')).toContain('<code class="language-js">const a = 1\n</code>');
    expect(render('**unfinished', 'chat')).toContain('**unfinished');
  });
});

describe('README URLs', () => {
  it.each([
    ['https://example.com/docs', 'https://example.com/docs'],
    ['http://example.com/docs', 'http://example.com/docs'],
    ['mailto:team@example.com', 'mailto:team@example.com'],
    ['./docs/start.md', `${baseUrl}docs/start.md`],
    ['docs/使用.md', `${baseUrl}docs/%E4%BD%BF%E7%94%A8.md`],
    ['#usage', `${baseUrl}#usage`],
    ['//example.com/docs', 'https://example.com/docs'],
  ])('allows and resolves %s', (url, expected) => {
    expect(render(`[Open](${url})`)).toContain(`<a href="${expected}" target="_blank" rel="noopener noreferrer">Open</a>`);
  });

  it('resolves links against the actual README path when a caller provides it', () => {
    const html = render('[Guide](../guide.md)', 'readme', 'https://github.com/owner/repo/blob/release/docs/README.md');
    expect(html).toContain('href="https://github.com/owner/repo/blob/release/guide.md"');
  });

  it.each([
    'javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'javascript&#58;alert%281%29',
    'data:text/html,hello', 'file:///etc/passwd', 'chrome-extension://id/options.html',
    'moz-extension://id/options.html', 'ftp://example.com/file',
    'https://user:password@example.com/private', '//user:password@example.com/private',
    'https://example.com/%0asecret', 'https://example.com/%00secret', 'https://example.com/%7fsecret',
    'https://example.com/&#9;secret', 'https://example.com/%C2%85secret',
    'mailto:team@example.com?subject=hi%0d%0abcc:other@example.com',
  ])('removes unsafe URL %s', url => {
    const html = render(`[blocked](${url})`);
    expect(html).toContain('blocked');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it('does not resolve relative links against the extension origin when no base is known', () => {
    const html = renderToStaticMarkup(<Markdown text="[Local](./file.md)" mode="readme" />);
    expect(html).toContain('Local');
    expect(html).not.toContain('href=');
  });

  it('requires an explicit action before requesting README images', () => {
    const html = render('![Diagram](./images/diagram.png)\n\n![Remote](https://images.example/diagram.svg)');
    expect(html).toContain('Diagram');
    expect(html).toContain('加载图片');
    expect(html).toContain(`href="${baseUrl}images/diagram.png"`);
    expect(html).toContain('href="https://images.example/diagram.svg"');
    expect(html).not.toMatch(/<(?:img|link)\b/);
    expect(html).not.toContain('src=');
  });

  it('does not nest image buttons or links inside a README link', () => {
    const html = render('[![Build](https://images.example/badge.svg)](https://example.com/build)');
    expect(html).toContain('href="https://example.com/build"');
    expect(html).toContain('加载图片');
    for (const anchor of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)) expect(anchor[1]).not.toMatch(/<(?:button|a)\b/);
  });

  it.each(['data:image/svg+xml,bad', 'javascript:alert%281%29', 'mailto:team@example.com', 'https://user:password@example.com/image'])('keeps unsafe image %s inert', url => {
    const html = render(`![blocked image](${url})`);
    expect(html).toContain('blocked image');
    expect(html).not.toMatch(/<(?:a|img|button|link)\b/);
  });
});
