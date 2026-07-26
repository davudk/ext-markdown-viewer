/**
 * The parse env — and the seam the heading outline travels back along.
 *
 * `renderMarkdown` has to return `{ html, headings }`, but it no longer owns
 * the code that knows what a heading's id is: `plugins/markdown-headings`
 * assigns the ids and collects the outline. The two need somewhere to meet that
 * neither one owns, and markdown-it already provides the channel — the `env`
 * object threaded through every rule and never stored on the parser instance.
 *
 * So the contract is: `renderMarkdown` mints a fresh env per parse and reads
 * `env.headings` afterwards; the plugin pushes into it from a core rule. That
 * keeps a shared parser instance safe (two renders share the rules and share
 * nothing else) and keeps the plugin free of any knowledge of who called it.
 *
 * A plugin cannot be trusted to have run — it may be disabled, or it may have
 * thrown inside the host's boundary — so `renderEnvOf` repairs an env rather
 * than asserting one. A disabled heading plugin means an empty outline, which
 * is exactly right: there are no ids to point at.
 */

export interface Heading {
  id: string;
  text: string;
  level: number;
}

/** Everything one parse accumulates. */
export interface RenderEnv {
  headings: Heading[];
  /** Headings whose text slugs to nothing, numbered so they still get an id. */
  unnamed: number;
}

/**
 * Slugs and duplicate counters are per-document, so every parse needs its own
 * or a second render would start numbering duplicates where the first stopped.
 */
export function createRenderEnv(): RenderEnv {
  return { headings: [], unnamed: 0 };
}

/**
 * The env as a `RenderEnv`, filling in anything missing.
 *
 * markdown-it types `state.env` as `any` and will happily run with the `{}` a
 * caller passed by mistake. Coercing here means a plugin rule never has to
 * guard, and never invents a second shape by writing `env.headings ??= []`
 * five times in five places.
 */
export function renderEnvOf(env: unknown): RenderEnv {
  const candidate = (env ?? {}) as Partial<RenderEnv>;
  if (!Array.isArray(candidate.headings)) candidate.headings = [];
  if (typeof candidate.unnamed !== 'number') candidate.unnamed = 0;
  return candidate as RenderEnv;
}
