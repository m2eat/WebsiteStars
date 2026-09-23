import { describe, expect, it } from 'vitest';
import { MAX_ANSWER_CHARS, StreamingAnswer } from '../lib/streaming-answer';

describe('StreamingAnswer', () => {
  it('decodes fragmented Markdown, escapes and Unicode as monotonic trimmed prefixes', () => {
    const input = String.raw`{"results":[{"answer":"PRIVATE_NESTED","quote":"quote"}],"\u0061nswer":"  ## \u6807\u9898\n\n**bold** \"quoted\" \\ path \/ \ud83d\ude80\tend  ","clarification":"PRIVATE_CLARIFICATION"}`;
    const expected = '## 标题\n\n**bold** "quoted" \\ path / 🚀\tend';
    const decoder = new StreamingAnswer();
    let text = '';
    for (const char of input) {
      text += decoder.push(char);
      expect(expected.startsWith(text)).toBe(true);
      expect(text).not.toMatch(/[\ud800-\udbff]$/u);
    }
    expect(text).toBe(expected);
  });

  it.each([
    '{"results":[{"answer":"nested"}],"answer":"visible"}',
    '{"other":{"deep":{"answer":"nested"}},"answer":"visible"}',
    '{"other":"\\\"answer\\\":\\\"nested\\\"","answer":"visible"}',
    '{"answer":"visible","other":{"answer":"nested"}}',
  ])('extracts only the top-level field from %s', input => {
    const decoder = new StreamingAnswer();
    expect(decoder.push(input)).toBe('visible');
  });

  it('withholds incomplete escapes, surrogate pairs and trailing whitespace until stable', () => {
    const decoder = new StreamingAnswer();
    expect(decoder.push('{"answer":"  first\\')).toBe('first');
    expect(decoder.push('n\\u68')).toBe('');
    expect(decoder.push('07\\ud83d')).toBe('\n标');
    expect(decoder.push('\\u')).toBe('');
    expect(decoder.push('de80  ')).toBe('🚀');
    expect(decoder.push('last  ","results":[')).toBe('  last');
  });

  it('accepts exactly 6000 decoded characters and rejects excess before emitting them', () => {
    const decoder = new StreamingAnswer();
    expect(decoder.push(`{"answer":"${'a'.repeat(MAX_ANSWER_CHARS)}`)).toHaveLength(MAX_ANSWER_CHARS);
    expect(() => decoder.push('x')).toThrow('长度上限');
    expect(() => new StreamingAnswer().push(`{"answer":"${' '.repeat(MAX_ANSWER_CHARS + 1)}`)).toThrow('长度上限');
    expect(() => new StreamingAnswer().push(`{"answer":"${'\\u0061'.repeat(MAX_ANSWER_CHARS + 1)}`)).toThrow('长度上限');
  });

  it('bounds ignored input and nesting without retaining the entire tool JSON', () => {
    const decoder = new StreamingAnswer();
    expect(decoder.push('{"other":"')).toBe('');
    for (let index = 0; index < 20; index++) expect(decoder.push('x'.repeat(10000))).toBe('');
    expect(decoder.push('","answer":"visible"}')).toBe('visible');
    expect(() => decoder.push(' '.repeat(100000))).toThrow('长度上限');
    expect(() => new StreamingAnswer().push('{"other":' + '['.repeat(65))).toThrow('嵌套');
  });

  it.each([
    '{"answer":"first","answer":"second"}',
    '{"answer":{"answer":"nested"}}',
    '{"answer":"bad\\x"}',
    '{"answer":"bad\\u00XZ"}',
    '{"answer":"bad\\u0000"}',
  ])('rejects ambiguous or unsafe input %s', input => {
    expect(() => new StreamingAnswer().push(input)).toThrow();
  });
});
