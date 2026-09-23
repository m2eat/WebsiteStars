import { describe, expect, it } from 'vitest';
import { normalizeUrl, parseGithubRepo } from '../lib/urls';

describe('normalizeUrl', () => {
  it('removes only known trackers and ordinary anchors', () => {
    expect(normalizeUrl('https://EXAMPLE.com:443/docs?utm_source=x&v=2&fbclid=y&gclid=z#intro'))
      .toBe('https://example.com/docs?v=2');
    expect(normalizeUrl('https://example.com/?UTM_campaign=x&ref=feed&source=mail&dclid=keep'))
      .toBe('https://example.com/?ref=feed&source=mail&dclid=keep');
    expect(normalizeUrl('https://example.com/?q=a%20b&x=%2f&x=2&utm_medium=email'))
      .toBe('https://example.com/?q=a%20b&x=%2f&x=2');
  });

  it('keeps versions, case, trailing slashes, significant query parameters, and hash routes distinct', () => {
    const values = [
      'https://example.com/docs', 'https://example.com/docs/', 'https://example.com/Docs',
      'https://example.com/docs?v=1', 'https://example.com/docs?v=2',
      'https://example.com/docs#/v1/start', 'https://example.com/docs#/v2/start',
      'https://example.com/docs#!/start', 'https://example.com/docs#page=2',
    ];
    expect(new Set(values.map((url) => normalizeUrl(url))).size).toBe(values.length);
  });

  it('accepts matching canonicals but cannot use them to merge distinct pages', () => {
    const url = 'https://example.com/v2/docs?lang=zh&utm_source=mail#/guide';
    const expected = 'https://example.com/v2/docs?lang=zh#/guide';
    for (const canonical of [
      '/v2/docs?lang=zh#/guide', '/v1/docs', '/v2/docs', '/v2/docs?lang=en#/guide',
      'https://other.example/v2/docs', 'http://example.com/v2/docs',
      'https://user:password@example.com/v2/docs', 'javascript:alert(1)', 'not a url',
    ]) expect(normalizeUrl(url, canonical)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)', 'file:///tmp/a', 'chrome://settings', 'ftp://example.com/a',
    'https://user:secret@example.com/a', 'https://user@example.com', '//example.com',
    '/relative', 'not a url', 'https://exam\nple.com/', '',
  ])('rejects unsafe or invalid URL %s', (url) => {
    expect(() => normalizeUrl(url)).toThrow();
  });
});

describe('parseGithubRepo', () => {
  it.each([
    'https://github.com/owner/repo', 'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git', 'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/tree/feature/branch/docs',
    'https://github.com/owner/repo/blob/main/README.md',
    'https://github.com/owner/repo/blob/feature/branch/docs/readme.md?plain=1',
  ])('identifies supported repository URL %s', (url) => {
    expect(parseGithubRepo(url)).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('allows real organizations whose names resemble platform features', () => {
    expect(parseGithubRepo('https://github.com/actions/checkout')).toEqual({ owner: 'actions', repo: 'checkout' });
    expect(parseGithubRepo('https://github.com/github/docs')).toEqual({ owner: 'github', repo: 'docs' });
  });

  it.each([
    'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/2',
    'https://github.com/owner/repo/pulls', 'https://github.com/owner/repo/wiki/Home',
    'https://github.com/owner/repo/discussions/3', 'https://github.com/owner/repo/releases',
    'https://github.com/owner/repo/blob/main/index.ts', 'https://github.com/owner/repo/tree',
    'https://github.com/owner/repo/blob/README.md', 'https://github.com/owner//repo',
    'https://github.com/search/code', 'https://github.com/topics/typescript',
    'https://github.com/settings/profile', 'https://github.com/orgs/example',
    'https://github.com/login/oauth', 'https://github.com/marketplace/actions',
    'https://github.com/owner', 'https://github.com.evil.example/owner/repo',
    'https://example.com/owner/repo', 'https://secret@github.com/owner/repo',
    'https://github.com:8080/owner/repo', 'file://github.com/owner/repo', 'not a url',
  ])('leaves non-repository URL as a webpage: %s', (url) => {
    expect(parseGithubRepo(url)).toBeNull();
  });
});
