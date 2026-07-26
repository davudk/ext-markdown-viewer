/**
 * Heading slugs.
 *
 * Shared, because two plugins mint them and must agree: `markdown-headings`
 * assigns the ids, and `markdown-wikilinks` resolves `[[Page#Some Heading]]`
 * into one. They cannot import each other — that is the rule the plugin API is
 * built on — so the thing they share lives here.
 */

/**
 * GitHub-compatible slugs, so links written against a README's own anchors
 * (`#installation`) resolve the way their author expected.
 */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      // Each whitespace character becomes its own hyphen rather than collapsing
      // runs — that is what github-slugger does, and it is why "Install & Setup"
      // is `install--setup`: the dropped `&` leaves two spaces behind. Collapsing
      // here would silently break hand-written anchors that target such headings.
      .replace(/\s/g, '-')
  );
}
