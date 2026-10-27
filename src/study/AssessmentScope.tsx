import type { AssessmentCitation, AssessmentContext } from '../../shared/assessments';
import type { Segment } from '../../shared/domain';
import { attachmentImages } from '../../shared/tutor-attachments';
import { formatTime } from '../../shared/media-controls';
import { Button } from '../design/components';
import type { T } from '../i18n';

export function AssessmentCitations({
  citations,
  context,
  t,
  navigate,
  inspect,
}: {
  citations: AssessmentCitation[];
  context: AssessmentContext;
  t: T;
  navigate: (sourceId: string, segment: Segment) => void;
  inspect: (id: string, imageId?: string) => void;
}) {
  return (
    <div className="assessment-citations">
      <p className="assessment-citations-heading">
        {t.sourceEvidence} ({citations.length})
      </p>
      {citations.map((citation, index) => {
        if ('attachmentId' in citation) {
          const item = context.attachments?.find(
              (item) => item.attachment.id === citation.attachmentId,
            ),
            image =
              item && citation.imageId
                ? attachmentImages(item.attachment).find((image) => image.id === citation.imageId)
                : undefined;
          if (!item) return null;
          return (
            <div key={index}>
              {citation.quote && <blockquote>{citation.quote}</blockquote>}
              {image && (
                <img
                  className="assessment-evidence-thumbnail"
                  src={`/api/tutor-attachments/${item.attachment.id}/image?id=${image.id}`}
                  alt={image.capture?.label || t.captureImage}
                  loading="lazy"
                />
              )}
              <button
                type="button"
                className="assessment-citation-link"
                onClick={() => inspect(item.attachment.id, image?.id)}
              >
                {image?.capture?.label || item.attachment.name} · {t.assessmentSavedEvidence}
                {item.attachment.annotationRevision
                  ? ` · ${t.revision} ${item.attachment.annotationRevision}`
                  : ''}{' '}
                ↗
              </button>
            </div>
          );
        }
        const source = context.sources.find((s) => s.id === citation.sourceId),
          segment = source?.segments.find((s) => s.id === citation.segmentId);
        return source && segment ? (
          <div key={index}>
            <blockquote>{citation.quote}</blockquote>
            <button
              type="button"
              className="assessment-citation-link"
              onClick={() => navigate(source.id, segment)}
            >
              {source.name} ·{' '}
              {segment.page
                ? `${t.page} ${segment.page}`
                : segment.start != null
                  ? formatTime(segment.start)
                  : segment.id}{' '}
              · v{source.version} ↗
            </button>
          </div>
        ) : null;
      })}
    </div>
  );
}
export function AssessmentScope({
  context,
  t,
  inspect,
}: {
  context: AssessmentContext;
  t: T;
  inspect: (id: string, imageId?: string) => void;
}) {
  return (
    <details className="assessment-scope-details">
      <summary>
        {t.assessmentCapturedScope} · {context.sources.length}{' '}
        {context.sources.length === 1 ? t.reviewFile : t.files.toLowerCase()}
        {!!context.attachments?.length &&
          ` · ${t.assessmentSavedEvidence}: ${context.attachments.length}`}
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
      {!!context.attachments?.length && (
        <section aria-label={t.assessmentSavedEvidence}>
          <h4>{t.assessmentSavedEvidence}</h4>
          <p className="muted">{t.assessmentSavedEvidenceNotice}</p>
          {context.attachments.map(({ attachment }) => (
            <div key={attachment.id}>
              <Button onClick={() => inspect(attachment.id)}>
                {attachment.name}
                {attachment.annotationRevision
                  ? ` · ${t.revision} ${attachment.annotationRevision}`
                  : ''}{' '}
                · {t.attachmentSelectedImages}: {attachmentImages(attachment).length}
              </Button>
              <div className="assessment-evidence-images">
                {attachmentImages(attachment).map((image, index) => (
                  <Button
                    key={image.id}
                    variant="ghost"
                    onClick={() => inspect(attachment.id, image.id)}
                  >
                    {index + 1}. {image.capture?.label || t.captureImage}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
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
