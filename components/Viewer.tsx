import { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown';

export function Viewer({ source }: { source: string }) {
  // Parsing a large README is the expensive part of the mount; keep it off the
  // path of re-renders triggered by theme changes.
  const html = useMemo(() => renderMarkdown(source), [source]);

  return <main className="mdv-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
