// Existing fixtures assert Chinese system messages independently of the host OS.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'zh-CN', languages: ['zh-CN'] },
});
