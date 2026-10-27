import { useMemo } from 'react';
import { renderFormula } from './math';

export function Formula({
  source,
  display = false,
  label = 'Formula',
}: {
  source: string;
  display?: boolean;
  label?: string;
}) {
  const html = useMemo(() => renderFormula(source, display), [source, display]);
  return (
    <span
      className={`study-formula${display ? ' study-formula-display' : ''}`}
      tabIndex={display ? 0 : undefined}
      role={display ? 'region' : undefined}
      aria-label={display ? label : undefined}
    >
      {html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="formula-source">{source}</code>
      )}
    </span>
  );
}
