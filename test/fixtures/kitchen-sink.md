# Kitchen Sink

Every Bucket 1 rendering requirement in one file, plus the payloads that must
*not* survive sanitization. Open this in the extension to eyeball a release.

## Headings

# H1
## H2
### H3
#### H4
##### H5
###### H6

## Inline formatting

**Bold**, _italic_, **_bold italic_**, ~~strikethrough~~, `inline code`, and a
[link](https://example.com). An autolink: <https://example.com>.

Reference-style [link][ref] and a real footnote[^note].

[ref]: https://example.com
[^note]: Footnote content, rendered at the foot of the document.

Emoji shortnames resolved from a bundled table, never a network call:
:rocket: :tada: :warning: :white_check_mark:

An unknown shortname must survive untouched: :definitely_not_an_emoji:

## Heading slugs

Headings get GitHub-compatible ids so hand-written anchors resolve. These two
share a slug and must be disambiguated, and the link below must reach the
second one.

### Options

First one.

### Options

Second one — reachable as [#options-1](#options-1).

### Install & Setup

Punctuation is dropped but its space is not, so this is `install--setup`:
[jump](#install--setup).

## Lists

- First
- Second
  - Nested one
    - Nested two
- Third

1. One
2. Two
   1. Two point one
   2. Two point two
3. Three

- [x] Completed task
- [ ] Incomplete task
  - [x] Nested completed task

## Blockquotes

> A blockquote.
>
> > Nested, containing `code` and **bold**.

## Rules

---

## Code

Inline: `const x = 1;`

```js
// Syntax highlighting, unclosed-string safe
function greet(name) {
  const parts = [1, 2, 3].map((n) => n * 2);
  return `Hello, ${name}! ${parts.join(', ')}`;
}
```

```python
class Widget:
    """Docstring."""
    def __init__(self, size: int = 0) -> None:
        self.size = size
```

```rust
fn main() {
    let nums: Vec<i32> = (0..10).filter(|n| n % 2 == 0).collect();
    println!("{:?}", nums);
}
```

```
Fenced block with no language — must not throw.
```

```definitely-not-a-real-language
Unknown language must fall back to plaintext, not crash.
```

## Tables

| Left | Center | Right |
| :--- | :----: | ----: |
| a    |   b    |     c |
| longer cell | x | 1000 |

A wide table that must scroll inside its own container rather than making the
page scroll sideways:

| col1 | col2 | col3 | col4 | col5 | col6 | col7 | col8 | col9 | col10 | col11 | col12 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----- | ----- | ----- |
| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee | ffffffffff | gggggggggg | hhhhhhhhhh | iiiiiiiiii | jjjjjjjjjj | kkkkkkkkkk | llllllllll |

## Images

Inline image with a broken source (should degrade, not break layout):

![alt text](./does-not-exist.png)

Reference-style image:

![ref image][img]

[img]: ./also-missing.png

## Malformed markdown

Unclosed emphasis: **bold that never closes

Unclosed fence:

```js
const dangling = true;

## Heading after unclosed fence

Ragged table:

| a | b |
| --- |
| 1 | 2 | 3 |

## Sanitization — none of the following may execute

<script>window.__XSS_SCRIPT = true;</script>

<img src="x" onerror="window.__XSS_IMG = true">

<a href="javascript:window.__XSS_HREF = true">javascript: link</a>

<iframe src="https://example.com"></iframe>

<svg><script>window.__XSS_SVG = true;</script></svg>

<div onclick="window.__XSS_CLICK = true">click handler</div>

<form action="https://example.com"><input name="x"><button>submit</button></form>

<style>body { display: none !important; }</style>

<math><mtext><script>window.__XSS_MATH = true;</script></mtext></math>
