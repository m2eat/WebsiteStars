export const MAX_ANSWER_CHARS = 6000;
const MAX_INPUT_CHARS = 300000;
const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// Decode only a top-level answer string; full schema validation belongs to the tool.
export class StreamingAnswer {
  private depth = 0;
  private position: 'key' | 'colon' | 'value' | 'after' = 'after';
  private stringRole: 'key' | 'answer' | 'ignore' | undefined;
  private key = '';
  private escaped = false;
  private unicode: string | undefined;
  private seenAnswer = false;
  private answerClosed = false;
  private answer = '';
  private emitted = 0;
  private inputChars = 0;

  push(input: string): string {
    this.inputChars += input.length;
    if (this.inputChars > MAX_INPUT_CHARS) throw new Error('工具输入已达到长度上限。');
    for (const char of input) {
      if (this.stringRole) {
        if (this.unicode !== undefined) {
          if (!/^[\da-f]$/iu.test(char)) throw new Error('工具输入含无效 Unicode 转义。');
          this.unicode += char;
          if (this.unicode.length === 4) {
            this.append(String.fromCharCode(parseInt(this.unicode, 16)));
            this.unicode = undefined;
          }
        } else if (this.escaped) {
          this.escaped = false;
          if (char === 'u') this.unicode = '';
          else {
            if (!Object.hasOwn(escapes, char)) throw new Error('工具输入含无效转义。');
            this.append(escapes[char]!);
          }
        } else if (char === '\\') {
          this.escaped = true;
        } else if (char === '"') {
          if (this.stringRole === 'key') this.position = 'colon';
          if (this.stringRole === 'answer') this.answerClosed = true;
          this.stringRole = undefined;
        } else {
          if (char.charCodeAt(0) < 32) throw new Error('工具输入含无效字符。');
          this.append(char);
        }
        continue;
      }
      if (/\s/u.test(char)) continue;
      if (char === '"') {
        if (this.depth === 1 && this.position === 'key') {
          this.key = '';
          this.stringRole = 'key';
        } else if (this.depth === 1 && this.position === 'value' && this.key === 'answer') {
          if (this.seenAnswer) throw new Error('工具输入重复提交答案。');
          this.seenAnswer = true;
          this.stringRole = 'answer';
          this.position = 'after';
        } else {
          this.stringRole = 'ignore';
          if (this.depth === 1) this.position = 'after';
        }
      } else if (this.depth === 1 && this.position === 'value' && this.key === 'answer') {
        throw new Error('工具答案必须是字符串。');
      } else if (char === '{' || char === '[') {
        this.depth++;
        if (this.depth > 64) throw new Error('工具输入嵌套过深。');
        if (this.depth === 1) {
          if (char !== '{') throw new Error('工具输入必须是对象。');
          this.position = 'key';
        }
      } else if (char === '}' || char === ']') {
        this.depth--;
        if (this.depth < 0) throw new Error('工具输入格式无效。');
        this.position = 'after';
      } else if (this.depth === 1 && char === ',') {
        this.position = 'key';
      } else if (this.depth === 1 && char === ':' && this.position === 'colon') {
        this.position = 'value';
      } else if (this.depth === 1) {
        this.position = 'after';
      }
    }
    // Trailing whitespace and a split surrogate pair are not stable display prefixes yet.
    let prefix = this.answer.trimStart();
    if (!this.answerClosed && /[\ud800-\udbff]$/u.test(prefix)) prefix = prefix.slice(0, -1);
    prefix = prefix.trimEnd();
    const delta = prefix.slice(this.emitted);
    this.emitted = prefix.length;
    return delta;
  }

  private append(char: string) {
    if (this.stringRole === 'key') {
      if (this.key.length <= 'answer'.length) this.key += char;
    } else if (this.stringRole === 'answer') {
      if (this.answer.length + char.length > MAX_ANSWER_CHARS) throw new Error('工具答案已达到长度上限。');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(char)) throw new Error('工具答案含有不支持的控制字符。');
      this.answer += char;
    }
  }
}
