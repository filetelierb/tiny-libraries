import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';
import type { Catalog, Segment } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import {
  attachmentImages,
  type QuestionAttachment,
  type AttachmentSegment,
} from '../../shared/tutor-attachments';
import { stampLabel } from '../annotations/captureLabels';
import { formatCaptureTime } from '../../shared/capture-source';

export function AttachmentInspector({
  id,
  t,
  catalog,
  close,
  cite,
}: {
  id: string;
  t: T;
  catalog: Catalog;
  close: () => void;
  cite: (sourceId: string, segment: Segment) => void;
}) {
  const [attachment, setAttachment] = useState<QuestionAttachment | null>(null),
    [parts, setParts] = useState<AttachmentSegment[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<QuestionAttachment>(`/tutor-attachments/${id}`),
      api<{ items: AttachmentSegment[]; nextCursor: number | null }>(
        `/tutor-attachments/${id}/segments`,
      ),
    ])
      .then(([item, page]) => {
        if (active) {
          setAttachment(item);
          setParts(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const file = catalog.files.find((file) => file.id === attachment?.sourceId),
    available =
      file &&
      file.version === attachment?.sourceVersion &&
      sourceState(file, catalog.directories) !== 'trash';
  return (
    <Modal
      title={attachment?.name || t.questionAttachment}
      close={close}
      closeLabel={t.close}
      className="attachment-inspector"
    >
      {loading && <p role="status">{t.loading}</p>}
      {attachment && (
        <>
          <p className="muted">{t.attachmentSnapshotNotice}</p>
          <p>
            {t[`attachmentKind_${attachment.kind}`]} · {t.attachmentPassages}:{' '}
            {attachment.segmentCount}
            {attachmentImages(attachment).length
              ? ` · ${t.attachmentSelectedImages}: ${attachmentImages(attachment).length}`
              : ` · ${t.attachmentTextOnly}`}
          </p>
          {attachment.annotationRevision && (
            <p>
              {t.revision} {attachment.annotationRevision}
            </p>
          )}
          {attachment.location.page && (
            <p>
              {t.page} {attachment.location.page}
            </p>
          )}
          {attachment.location.seconds != null && (
            <p>
              {t.attachmentTime} {formatCaptureTime(attachment.location.seconds)}
            </p>
          )}
          {attachmentImages(attachment).map((image, index) => (
            <figure key={image.id} className="attachment-image-snapshot">
              <img
                className="attachment-preview-image"
                src={`/api/tutor-attachments/${id}/image?id=${image.id}`}
                alt={`${t.attachmentSavedImage} ${index + 1}`}
              />
              <figcaption>
                {index + 1}. {image.capture?.label || attachment.name}
              </figcaption>
              {image.capture?.stamp && <p>{stampLabel(image.capture.stamp, t)}</p>}
              {image.capture?.originSource && (
                <p>
                  {image.capture.originSource.name} · {t.sourceVersion}{' '}
                  {image.capture.originSource.version}
                </p>
              )}
              <a
                className="button"
                href={`/api/tutor-attachments/${id}/image?id=${image.id}`}
                download={`capture-${index + 1}.${image.mime === 'image/png' ? 'png' : 'jpg'}`}
              >
                {t.download}
              </a>
            </figure>
          ))}
          {!!attachment.sourceStamps?.length && (
            <section aria-label={t.captureLocations}>
              <strong>{t.captureLocations}</strong>
              {attachment.sourceStamps.map((stamp) => {
                const original = catalog.files.find((item) => item.id === stamp.sourceId),
                  valid =
                    original &&
                    original.version === stamp.sourceVersion &&
                    sourceState(original, catalog.directories) !== 'trash';
                return (
                  <p key={stamp.id}>
                    <Button
                      disabled={!valid}
                      onClick={() => {
                        close();
                        cite(stamp.sourceId, {
                          id: stamp.id,
                          text: stamp.location.quote || '',
                          ...(stamp.location.page !== undefined
                            ? { page: stamp.location.page }
                            : {}),
                          ...(stamp.location.seconds !== undefined
                            ? { start: stamp.location.seconds }
                            : {}),
                        });
                      }}
                    >
                      {stampLabel(stamp, t)}
                    </Button>
                  </p>
                );
              })}
            </section>
          )}
          <div className="attachment-snapshot-text">
            {parts.map((part) => (
              <section key={part.id}>
                <small>
                  {part.page
                    ? `${t.page} ${part.page}`
                    : part.start != null
                      ? formatCaptureTime(part.start)
                      : part.id.split('.').at(-1)}
                </small>
                <p>{part.text}</p>
              </section>
            ))}
          </div>
          {cursor !== null && (
            <Button
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void api<{ items: AttachmentSegment[]; nextCursor: number | null }>(
                  `/tutor-attachments/${id}/segments?after=${cursor}`,
                )
                  .then((page) => {
                    setParts((old) => [...old, ...page.items]);
                    setCursor(page.nextCursor);
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setLoading(false));
              }}
            >
              {t.loadMoreAttachments}
            </Button>
          )}
          {available ? (
            <Button
              onClick={() => {
                close();
                cite(file.id, {
                  id: 'attachment-source',
                  text: attachment.location.quote || '',
                  ...(attachment.location.page ? { page: attachment.location.page } : {}),
                  ...(attachment.location.seconds != null
                    ? { start: attachment.location.seconds }
                    : {}),
                });
              }}
            >
              {t.openAttachmentSource}
            </Button>
          ) : (
            attachment.sourceId && <p className="muted">{t.attachmentOriginalUnavailable}</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
