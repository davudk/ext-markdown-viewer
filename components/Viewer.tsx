import { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown';

export function Viewer({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);

  return (
    <div className="mdv">
      <header className="mdv-header">
        <span className="mdv-badge">Markdown Viewer 2</span>
        <span className="mdv-status">Rendered successfully</span>
      </header>
      <main
        className="mdv-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
