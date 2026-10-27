import type { AssessmentCitation, AssessmentContext } from '../../shared/assessments';
import type { Segment } from '../../shared/domain';
import { formatTime } from '../../shared/media-controls';
import { Button } from '../design/components';
import type { T } from '../i18n';

export function AssessmentCitations({
  citations,
  context,
  t,
  navigate,
}: {
  citations: AssessmentCitation[];
  context: AssessmentContext;
  t: T;
  navigate: (sourceId: string, segment: Segment) => void;
}) {
  return (
    <details className="assessment-citations">
      <summary>
        {t.sourceEvidence} ({citations.length})
      </summary>
      {citations.map((citation, index) => {
        const source = context.sources.find((s) => s.id === citation.sourceId),
          segment = source?.segments.find((s) => s.id === citation.segmentId);
        return source && segment ? (
          <div key={index}>
            <blockquote>{citation.quote}</blockquote>
            <Button variant="ghost" onClick={() => navigate(source.id, segment)}>
              {source.name} ·{' '}
              {segment.page
                ? `${t.page} ${segment.page}`
                : segment.start != null
                  ? formatTime(segment.start)
                  : segment.id}{' '}
              · v{source.version}
            </Button>
          </div>
        ) : null;
      })}
    </details>
  );
}
export function AssessmentScope({ context, t }: { context: AssessmentContext; t: T }) {
  return (
    <details className="assessment-scope-details">
      <summary>
        {t.assessmentCapturedScope} · {context.sources.length}{' '}
        {context.sources.length === 1 ? t.reviewFile : t.files.toLowerCase()}
      </summary>
      <p className="muted">{t.assessmentScopeHint}</p>
      {context.sources.map((source) => (
        <section key={source.id}>
          <strong>
            {source.name} · v{source.version}
          </strong>
          <p className="muted">
            {source.segments.length} / {source.studiedCount} {t.assessmentEvidenceSegments} ·{' '}
            {source.reviewed ? t.reviewed : t.assessmentStudiedRange}
          </p>
          <small>
            {t.preparationRevision}: {source.learningVersion}
          </small>
          {source.notes.length > 0 && (
            <details>
              <summary>
                {t.assessmentIncludedNotes} ({source.notes.length})
              </summary>
              {source.notes.map((note) => (
                <div key={note.id}>
                  <h4>{note.title}</h4>
                  <p>{note.text}</p>
                  {note.quote && <blockquote>{note.quote}</blockquote>}
                  <small>
                    {note.id} · v{note.revision}
                  </small>
                </div>
              ))}
            </details>
          )}
        </section>
      ))}
      {context.gaps.length > 0 && (
        <div className="notice">
          <strong>{t.assessmentCoverageLimits}</strong>
          <ul>
            {context.gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </div>
      )}
      {context.conversation.length > 0 && (
        <details>
          <summary>
            {t.assessmentLinkedConversation} ({context.conversation.length})
          </summary>
          {context.conversation.map((message, index) => (
            <p className="assessment-message" key={index}>
              <strong>{message.role === 'user' ? t.assessmentLearner : t.assessmentTutor}:</strong>{' '}
              {message.content}
            </p>
          ))}
        </details>
      )}
      {context.prior.length > 0 && (
        <p className="muted">
          {context.prior.length} {t.assessmentPriorResults}
        </p>
      )}
    </details>
  );
}
