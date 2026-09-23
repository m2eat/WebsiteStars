# Third-party notices

## Beautiful UI

The local components in `ui/beautiful/primitives.tsx` and their scoped styles in
`ui/chat.css` adapt actual component source from [Beautiful UI](https://www.beautifului.dev),
by Shane Levine. This is a source-level integration, not an installed npm package.

Upstream repository: https://github.com/slev12397/beautiful-ui

Source revision: `c99a3586cf4fc093091feb47d3c066da1fb2e342` (retrieved 2026-09-22).

Original source files:

- [components/primitives/LoadingState.tsx](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/components/primitives/LoadingState.tsx): Drive's nine-cell chevron timing, loading label and elapsed-time presentation.
- [components/atoms/StreamText.tsx](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/components/atoms/StreamText.tsx): text/tail split and streaming caret.
- [components/primitives/ChatComposer.tsx](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/components/primitives/ChatComposer.tsx): controlled input, focusable inset composer and send-action layout.
- [components/primitives/ToolChips.tsx](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/components/primitives/ToolChips.tsx): expandable tool rows, chip presentation and Set-based row state.
- [components/primitives/ContextCards.tsx](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/components/primitives/ContextCards.tsx): retrieved-chunk header, content and source-chip composition.
- [app/globals.css](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/app/globals.css): component style and animation reference.

The official [README](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/README.md)
documents manual copying from the gallery and registry installation, for example
`npx shadcn add https://www.beautifului.dev/r/approval-card.json`. This project uses
the manual source-copy approach; no installer or additional dependency was used.
The official [license page](https://www.beautifului.dev/license) and repository
[LICENSE](https://github.com/slev12397/beautiful-ui/blob/c99a3586cf4fc093091feb47d3c066da1fb2e342/LICENSE)
both identify the components as MIT licensed.

Local changes: demo messages, synthetic phase timers, delayed source reveals,
reasoning content, file diffs, external source links, and unused actions were
removed. Loading duration is computed from the persisted run start timestamp;
phase and tool steps come from real runs. StreamText renders accumulated received Markdown immediately through react-markdown and remark-gfm rather than splitting the last characters or replaying text with a synthetic interval. The composer
uses a controlled native textarea with the application's existing submission,
IME, draft, and cancellation logic. Context cards use plain text and resolve
existing Items before invoking the application's detail action. Tailwind and
upstream theme utilities are replaced with scoped CSS using the application's
existing light/dark tokens. Icons use the existing lucide-react dependency.
Reduced-motion preferences are respected. The upstream demos were not imported
as live application data.

### MIT License

Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
