import { ArrowUpRight } from 'lucide-react';
import type { GlossarySense } from '../../shared/glossary';
import type { T } from '../i18n';

/** What a meaning written by the tutor rests on, when it is not the library, and its pages. */
export function SenseBasis({ t, sense }: { t: T; sense: GlossarySense }) {
  const links = sense.links || [];
  if (sense.basis !== 'web' && sense.basis !== 'general' && !links.length) return null;
  return (
    <div className="glossary-basis">
      {sense.basis === 'web' && <p>{t.basisWeb}</p>}
      {sense.basis === 'general' && <p>{t.basisGeneral}</p>}
      {!!links.length && (
        <ul>
          {links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noreferrer noopener">
                {link.title || new URL(link.url).hostname}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
