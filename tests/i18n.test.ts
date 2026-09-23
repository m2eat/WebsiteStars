import { afterEach, describe, expect, it, vi } from 'vitest';
import { englishMessages, getLocale, resolveLocale, t, translateError } from '../lib/i18n';

const locale = (language: string) => vi.stubGlobal('navigator', { language, languages: [language] });
afterEach(() => vi.unstubAllGlobals());

describe('browser language and translated system messages', () => {
  it.each(['zh', 'zh-CN', 'zh-TW', 'zh_HK'])('uses Chinese for %s', language => {
    locale(language);
    expect(getLocale()).toBe('zh-CN');
    expect(t('设置与数据')).toBe('设置与数据');
  });
  it.each(['en-US', 'en-GB', 'fr-FR', 'ja-JP', ''])('uses English fallback for %s', language => {
    expect(resolveLocale(language)).toBe('en');
    locale(language);
    expect(t('设置与数据')).toBe('Settings & data');
  });
  it('uses the first preferred language rather than a later supported language', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['fr-FR', 'zh-CN'] });
    expect(getLocale()).toBe('en');
  });
  it('interpolates parameters without interpreting their content', () => {
    locale('en');
    const entry = Object.entries(englishMessages).find(([key]) => key.includes('{count}'))!;
    expect(t(entry[0], { count: 12 })).toBe(entry[1].replaceAll('{count}', '12'));
    expect(t('用户内容：{value}', { value: '<img src=x> 中文 {count}' })).toBe('用户内容：<img src=x> 中文 {count}');
  });
  it('translates persisted runtime errors with already substituted parameters', () => {
    locale('en');
    expect(translateError(new Error('模型请求失败（HTTP 403），请检查凭证、连接和额度。'))).toContain('403');
    expect(translateError(new Error('模型请求失败（HTTP 403），请检查凭证、连接和额度。'))).not.toMatch(/[\u3400-\u9fff]/u);
    expect(translateError(new Error('操作未完成，请重试。'))).toBe('The operation could not be completed. Please try again.');
  });
  it('keeps source data unchanged and gives unknown system errors a localized fallback', () => {
    locale('en');
    expect(t('我的私人收藏标题')).toBe('我的私人收藏标题');
    expect(translateError(new Error('无法识别的内部错误'))).toBe('The operation could not be completed. Please try again.');
    expect(translateError(new Error('Network disconnected'))).toBe('Network disconnected');
  });
  it('keeps placeholders consistent in every catalog entry', () => {
    for (const [source, translated] of Object.entries(englishMessages)) {
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      expect(placeholders(translated), source).toEqual(placeholders(source));
      expect(translated.trim(), source).not.toBe('');
    }
  });
});
