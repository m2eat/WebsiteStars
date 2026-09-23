import { browser } from 'wxt/browser';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { CHAT_PORT, type ChatPortReply, type ChatPortRequest } from './chat-types';
import type { Command } from './types';

export function createChatTransport(sessionId: string): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, trigger, messageId, abortSignal }) {
      const requestId = crypto.randomUUID();
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const command: ChatPortRequest = trigger === 'regenerate-message'
        ? { type: 'retry', sessionId, requestId, messageId: messageId ?? lastUser?.id ?? '' }
        : { type: 'send', sessionId, requestId, messageId: lastUser?.id ?? '', text: lastUser?.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '' };
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          const port = browser.runtime.connect({ name: CHAT_PORT });
          let ended = false;
          const cleanup = () => {
            abortSignal?.removeEventListener('abort', abort);
            port.onMessage.removeListener(onMessage);
            port.onDisconnect.removeListener(disconnect);
            port.disconnect();
          };
          const finish = (error?: Error) => {
            if (ended) return;
            ended = true;
            if (error) controller.error(error); else controller.close();
            cleanup();
          };
          const abort = () => {
            if (ended) return;
            try { port.postMessage({ type: 'stop', sessionId, target: { requestId } } satisfies ChatPortRequest); } catch { /* The backend may already be stopped. */ }
            void browser.runtime.sendMessage({ type: 'stopChat', id: sessionId, target: { requestId } } satisfies Command).catch(() => undefined);
            finish(new DOMException('查询已停止。', 'AbortError'));
          };
          const onMessage = (reply: ChatPortReply) => {
            if (ended) return;
            if (reply.type === 'chunk') controller.enqueue(reply.chunk);
            if (reply.type === 'end') finish();
            if (reply.type === 'error') finish(new Error(reply.error));
          };
          const disconnect = () => finish(new Error('后台连接已中断，已保存的会话仍在；可重新打开对话查看或重试。'));
          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(disconnect);
          abortSignal?.addEventListener('abort', abort, { once: true });
          if (abortSignal?.aborted) abort();
          else {
            try { port.postMessage(command); } catch { disconnect(); }
          }
        },
      });
    },
    async reconnectToStream() { return null; },
  };
}
