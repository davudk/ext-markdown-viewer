import { useEffect, useRef, useState } from 'react';

import { useDocument, usePluginSettings } from '../../lib/plugins/react.tsx';
import { readingStats, type ReadingStats } from '../../lib/reading.ts';

import { unitOf, type ReadingStatusSettings } from './plugin.ts';

import './reading-status.css';

/**
 * Custom property the fill is scaled by. Written straight onto the element from
 * an animation frame, never through React state — a re-render per scroll frame
 * would reconcile the whole shell to move a bar two pixels.
 */
const PROGRESS_VAR = '--mdv-progress';

/**
 * Word count, reading time, and a progress bar for the rendered document.
 *
 * Both halves are chrome layered over a body React does not own, so neither
 * reads the document's HTML for its content: the counts come from one walk of
 * the live body element, and `doc.html` is only the signal that the walk is
 * stale. That keeps a multi-MB document from being parsed a second time just to
 * be counted.
 *
 * The two props this used to take are both gone. `html` and the body element
 * come from `useDocument()`, which is the one shared answer to "what is on
 * screen" — no `main.mdv-body` lookup of its own. The `stats` and `progress`
 * flags were `settings.readingStats && !showRaw` computed by the shell; they are
 * now this plugin's own settings and `doc.isRaw`, decided here.
 */
export function ReadingStatus() {
  const doc = useDocument();
  const { showStats, showProgress } = usePluginSettings<ReadingStatusSettings>();

  // The raw view is a different `<main>` holding the source as one `<pre>`.
  // Counting its words is counting markdown syntax, and a progress bar over it
  // measures a document that is not the one the estimate describes.
  const stats = showStats && !doc.isRaw;
  const progress = showProgress && !doc.isRaw;

  const [measured, setMeasured] = useState<ReadingStats | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const body = doc.body;
  /** The document identity: a live reload swaps the HTML, not the element. */
  const html = doc.html;

  /* --- counting ----------------------------------------------------------- */

  useEffect(() => {
    if (!stats) {
      setMeasured(null);
      return;
    }
    if (!body) return;

    // Deferred rather than run inline: the walk is proportional to the document,
    // and a reading time is worth nothing if the reader waited for it. On a
    // large README the page is scrollable long before this resolves.
    const measure = () => setMeasured(readingStats(body));

    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(measure, 0);
      return () => clearTimeout(timer);
    }

    const handle = requestIdleCallback(measure, { timeout: 2000 });
    return () => cancelIdleCallback(handle);
  }, [html, body, stats]);

  /* --- progress ----------------------------------------------------------- */

  useEffect(() => {
    const bar = barRef.current;
    if (!progress || !bar || !body) return;

    let frame = 0;
    let top = 0;
    let height = 0;

    // The two numbers that describe the *document*: where it starts on the page
    // and how tall it is. Everything else is scroll state, which is free to
    // read. Measuring the window instead is what produces a bar stuck at zero
    // on a document that does not scroll.
    const remeasure = () => {
      const box = body.getBoundingClientRect();
      top = box.top + window.scrollY;
      height = box.height;
    };

    const paint = () => {
      frame = 0;
      // How much of the document has passed the bottom of the viewport. A
      // document shorter than the window is entirely past it from the start,
      // which reads as complete rather than as untouched.
      const seen = window.scrollY + window.innerHeight - top;
      const ratio = height > 0 ? seen / height : 1;
      bar.style.setProperty(PROGRESS_VAR, String(Math.min(1, Math.max(0, ratio))));
    };

    // Coalesced to one write per frame. A scroll handler that measured and
    // wrote on every event would read layout dozens of times a frame, which is
    // the difference between a smooth multi-MB document and a janky one.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    const onResize = () => {
      remeasure();
      schedule();
    };

    remeasure();
    paint();

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);

    // The document's height changes without a scroll or a window resize: images
    // decode, a diagram renders in place of its code block, a section folds.
    // The observer also fires once on observe, so nothing is missed at startup.
    const observer = new ResizeObserver(onResize);
    observer.observe(body);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [progress, html, body]);

  if (!progress && !stats) return null;

  return (
    // Read by the print rule in viewer.css, which strips every piece of chrome
    // by attribute — and by Search, which skips the same attribute so this
    // readout is never itself a search result.
    <div className="mdv-reading" data-mdv-chrome>
      {progress ? (
        // Not exposed as a progressbar: it would have to announce a new value
        // on every frame of every scroll, and the position it reports is one
        // the browser already conveys through the scrollbar.
        <div ref={barRef} className="mdv-progress" aria-hidden="true">
          <span className="mdv-progress-fill" />
        </div>
      ) : null}

      {stats && measured && measured.words > 0 ? (
        <p className="mdv-reading-stats">
          <span>
            {measured.words.toLocaleString()} {unitOf(measured)}
          </span>
          <Dot />
          <span>{measured.minutes} min read</span>

          {/* Said out loud rather than quietly left out: a document whose word
              count ignores a third of its lines has to admit which third. */}
          {measured.codeBlocks > 0 ? (
            <>
              <Dot />
              <span className="mdv-reading-note">
                {measured.codeBlocks === 1
                  ? '1 code block not counted'
                  : `${measured.codeBlocks.toLocaleString()} code blocks not counted`}
              </span>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function Dot() {
  return (
    <span className="mdv-reading-dot" aria-hidden="true">
      ·
    </span>
  );
}
