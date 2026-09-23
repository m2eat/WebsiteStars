import { describe, expect, it } from 'vitest';
import { buildQueryContext } from '../lib/query-context';

describe('follow-up query state', () => {
  it('preserves explicit language constraints and excludes the referenced prior result', () => {
    const history = [{ question: '只看 ts 的终端项目', answer: '', itemIds: ['first', 'second'] }];
    expect(buildQueryContext('不要第一个，找另一个', history)).toMatchObject({ language: 'TypeScript', source: 'github', excludeIds: ['first'], previousCandidateIds: ['first', 'second'] });
  });
  it('keeps comparison targets and removes explicitly excluded candidates', () => {
    const history = [{ question: '找终端工具', answer: '', itemIds: ['first', 'second'] }, { question: '不要第一个', answer: '', itemIds: ['second', 'third'] }];
    expect(buildQueryContext('比较这两个', history)).toMatchObject({ intent: 'compare', compareIds: ['second', 'third'], excludeIds: ['first'] });
  });
  it('keeps the topic for a short follow-up and resets it for a new request', () => {
    const history = [{ question: '找微信机器人', answer: '', itemIds: ['one'] }];
    expect(buildQueryContext('只看 TypeScript 的', history).retrievalQuestion).toContain('找微信机器人');
    expect(buildQueryContext('只看 TypeScript 的', history).retrievalQuestion).toContain('只看 TypeScript 的');
    expect(buildQueryContext('找数据库工具', history).retrievalQuestion).toBe('找数据库工具');
    expect(buildQueryContext('重新找 Python 编辑器', history).retrievalQuestion).toBe('重新找 Python 编辑器');
  });
  it('keeps the selected ordering beyond three results for exclusions', () => {
    expect(buildQueryContext('不要第二个', [{ question: '列出工具', answer: '', itemIds: ['four', 'one', 'two', 'three'] }]).excludeIds).toEqual(['one']);
  });
  it('does not reuse an older selection after the latest answer returned no matches', () => {
    expect(buildQueryContext('不要第一个', [
      { question: '找终端工具', answer: '', itemIds: ['old'] },
      { question: '只看 Python 的', answer: '', itemIds: [] },
    ])).toMatchObject({ previousCandidateIds: [], excludeIds: [] });
  });
  it('only hard-filters explicit requirements and can clear them', () => {
    expect(buildQueryContext('好像是Python写的', [])).not.toHaveProperty('language');
    expect(buildQueryContext('不限语言', [{ question: '只要py', answer: '', itemIds: [] }]).language).toBeUndefined();
    expect(buildQueryContext('换个话题，列出所有收藏', [{ question: '只看ts项目', answer: '', itemIds: ['old'] }])).toMatchObject({ intent: 'list', previousCandidateIds: [], excludeIds: [] });
  });
});
