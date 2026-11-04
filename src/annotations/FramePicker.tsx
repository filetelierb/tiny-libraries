import { useEffect, useRef, useState } from 'react';
import type { Source } from '../../shared/domain';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';
import { captureCanvasImage } from './capture';

function shortTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds)),
    h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function FramePicker({
  source,
  position,
  t,
  close,
  pick,
}: {
  source: Source;
  position: number;
  t: T;
  close: () => void;
  pick: (payload: { blob: Blob; seconds: number }) => Promise<void> | void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const initial = useRef(position);
  const [duration, setDuration] = useState(0),
    [time, setTime] = useState(position),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(
    () => () => {
      const video = ref.current;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    },
    [],
  );
  const seek = (value: number) => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    setReady(false);
    setTime(value);
    video.currentTime = value;
    if (!video.seeking && video.readyState >= 2) setReady(true);
  };
  return (
    <Modal title={t.captureFramePicker} close={close} closeLabel={t.close} className="frame-picker">
      <p className="muted">{t.captureFramePickerNotice}</p>
      <video
        ref={ref}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-label={t.capturePreview}
        className="frame-picker-video"
        src={`/api/files/${source.id}/content`}
        onPlay={(event) => event.currentTarget.pause()}
        onLoadedData={(event) => {
          const video = event.currentTarget;
          video.pause();
          if (!duration) {
            const max = Math.max(0, video.duration - 0.01);
            setDuration(max);
            seek(Math.min(initial.current, max));
          }
        }}
        onSeeked={(event) => {
          event.currentTarget.pause();
          setTime(event.currentTarget.currentTime);
          setReady(true);
        }}
        onError={() => setError(t.error)}
      />
      <div className="frame-picker-scrub">
        <input
          aria-label={t.captureFramePosition}
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={time}
          disabled={!duration}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <output>{shortTime(time)}</output>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="ghost" disabled={busy} onClick={close}>
          {t.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={!ready || busy || !!error}
          onClick={async () => {
            const video = ref.current;
            if (!video) return;
            setBusy(true);
            setError('');
            try {
              const blob = await captureCanvasImage(video, video.videoWidth, video.videoHeight);
              await pick({ blob, seconds: Math.floor(time) });
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : t.error);
              setBusy(false);
            }
          }}
        >
          {t.captureUseFrame}
        </Button>
      </div>
    </Modal>
  );
}
