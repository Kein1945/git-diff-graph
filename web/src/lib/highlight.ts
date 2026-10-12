import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

export const THEME = 'github-dark-default';

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter() {
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-dark-default.mjs')],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/csharp.mjs'),
    ],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

const cache = new Map<string, ThemedToken[][]>();

/** Tokenizes lines as one block (so multi-line constructs colour correctly). */
export async function highlightLines(lines: readonly string[], lang: string | undefined): Promise<ThemedToken[][] | undefined> {
  if (!lang) return undefined;
  const code = lines.join('\n');
  const key = `${lang}\0${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = await getHighlighter();
  const { tokens } = h.codeToTokens(code, { lang, theme: THEME });
  if (cache.size > 300) cache.clear();
  cache.set(key, tokens);
  return tokens;
}
