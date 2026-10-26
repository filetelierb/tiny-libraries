import { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Minus,
  Plus,
  Maximize2,
  Minimize2,
  Headphones,
  Bookmark,
} from 'lucide-react';
import type { Source, PublicLearning, Bookmark as SavedBookmark } from '../shared/domain';
import {
  boundedTime,
  chapterRanges,
  chapterLanes,
  formatTime,
  playbackSpeeds,
} from '../shared/media-controls';
import { IconButton } from './design/components';
import type { T } from './i18n';

type Preferences = { speed: number; volume: number; muted: boolean; track: string };
function readPreferences(key: string): Preferences {
  let stored: Partial<Preferences> = {};
  try {
    stored = JSON.parse(localStorage.getItem(key) || '{}');
  } catch {}
  return {
    speed: playbackSpeeds.includes(stored?.speed || 0) ? stored.speed! : 1,
    volume: typeof stored?.volume === 'number' ? Math.min(1, Math.max(0, stored.volume)) : 1,
    muted: stored?.muted === true,
    track: ['off', 'original', 'translated'].includes(stored?.track || '')
      ? stored.track!
      : 'original',
  };
}

export function MediaPlayer({
  source,
  learning,
  bookmarks,
  position,
  onPosition,
  seek,
  t,
}: {
  source: Source;
  learning: PublicLearning | null;
  bookmarks: SavedBookmark[];
  position: number;
  onPosition: (value: number) => void;
  seek: { value: number; nonce: number } | null;
  t: T;
}) {
  const root = useRef<HTMLDivElement>(null),
    media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const storageKey = `tl:media:${source.id}:v${source.version}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey)),
    [time, setTime] = useState(position),
    [duration, setDuration] = useState(0),
    [playing, setPlaying] = useState(false),
    [visible, setVisible] = useState(true),
    [fullscreen, setFullscreen] = useState(false),
    [error, setError] = useState(''),
    [caption, setCaption] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    dragging = useRef(false),
    keyboard = useRef(false),
    revealTouch = useRef(false),
    lastReported = useRef(0),
    positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const wake = () => {
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (
        source.kind === 'video' &&
        media.current &&
        !media.current.paused &&
        !dragging.current &&
        !(keyboard.current && root.current?.contains(document.activeElement))
      )
        setVisible(false);
    }, 3000);
  };
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {}
    if (media.current) {
      media.current.playbackRate = preferences.speed;
      media.current.volume = preferences.volume;
      media.current.muted = preferences.muted;
    }
  }, [storageKey, preferences]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === root.current);
    const player = media.current;
    const release = () => {
      if (dragging.current) wake();
      dragging.current = false;
    };
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (timer.current) clearTimeout(timer.current);
      if (player && player.readyState > 0) {
        player.pause();
        positionCallback.current(player.currentTime);
      }
    };
  }, []);
  useEffect(() => {
    if (!playing) {
      setVisible(true);
      if (timer.current) clearTimeout(timer.current);
    } else wake();
  }, [playing]);
  const changeTime = (value: number) => {
    const player = media.current;
    if (!player || !Number.isFinite(player.duration)) return;
    const next = boundedTime(value, player.duration);
    player.currentTime = next;
    setTime(next);
    positionCallback.current(next);
    wake();
  };
  useEffect(() => {
    if (seek) changeTime(seek.value);
  }, [seek?.nonce]);
  const configureTracks = () => {
    const tracks = media.current?.textTracks;
    if (!tracks) return;
    setCaption('');
    for (let index = 0; index < tracks.length; index++) {
      const track = tracks[index];
      track.mode =
        track.id === preferences.track
          ? source.kind === 'audio'
            ? 'hidden'
            : 'showing'
          : 'disabled';
      track.oncuechange = () => {
        if (source.kind !== 'audio' || track.id !== preferences.track) return;
        setCaption(
          track.activeCues
            ? Array.from(track.activeCues)
                .map((cue) => (cue as VTTCue).text)
                .join('\n')
            : '',
        );
      };
    }
  };
  useEffect(configureTracks, [preferences.track, source.id]);
  const toggle = async () => {
    if (!media.current) return;
    try {
      if (media.current.paused) await media.current.play();
      else media.current.pause();
      setError('');
    } catch {
      setError(t.playbackError);
    }
    wake();
  };
  const changeSpeed = (value: number) =>
    setPreferences((current) => ({ ...current, speed: Math.min(4, Math.max(0.25, value)) }));
  const chapters = chapterLanes(chapterRanges(learning, duration));
  const laneCount = Math.max(0, ...chapters.map((chapter) => chapter.lane + 1));
  const currentChapter = chapters.find((chapter) => chapter.start <= time && chapter.end > time);
  const Tag = source.kind === 'video' ? 'video' : 'audio';
  const keySeek = (event: React.KeyboardEvent) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    )
      return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      changeTime(time + (event.key === 'ArrowRight' ? 5 : -5));
    } else if (
      (event.key === ' ' || event.key.toLowerCase() === 'k') &&
      event.target === root.current
    ) {
      event.preventDefault();
      void toggle();
    }
  };
  return (
    <div
      ref={root}
      className={`media-stage custom-player ${source.kind} ${visible ? '' : 'controls-hidden'}`}
      role="region"
      aria-label={source.name}
      tabIndex={0}
      onPointerMove={wake}
      onFocusCapture={wake}
      onKeyDownCapture={() => {
        keyboard.current = true;
        wake();
      }}
      onKeyDown={keySeek}
      onPointerDownCapture={(event) => {
        keyboard.current = false;
        dragging.current =
          event.target instanceof HTMLInputElement && event.target.type === 'range';
        revealTouch.current = event.pointerType === 'touch' && !visible;
        if (revealTouch.current) {
          event.preventDefault();
          event.stopPropagation();
          revealTouch.current = true;
        }
        wake();
      }}
      onClickCapture={(event) => {
        if (revealTouch.current) {
          event.preventDefault();
          event.stopPropagation();
          revealTouch.current = false;
        }
      }}
    >
      <Tag
        ref={media}
        src={`/api/files/${source.id}/content`}
        preload="metadata"
        playsInline
        aria-label={source.name}
        onLoadedMetadata={() => {
          const player = media.current!;
          setDuration(player.duration);
          const initial = boundedTime(seek?.value ?? position, player.duration);
          player.currentTime = initial;
          setTime(initial);
          player.playbackRate = preferences.speed;
          player.volume = preferences.volume;
          player.muted = preferences.muted;
          configureTracks();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          if (media.current) positionCallback.current(media.current.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          if (media.current) positionCallback.current(media.current.currentTime);
        }}
        onSeeked={() => {
          if (media.current) {
            setTime(media.current.currentTime);
            positionCallback.current(media.current.currentTime);
          }
        }}
        onTimeUpdate={() => {
          if (media.current) {
            setTime(media.current.currentTime);
            if (Date.now() - lastReported.current > 5000) {
              positionCallback.current(media.current.currentTime);
              lastReported.current = Date.now();
            }
          }
        }}
        onError={() => setError(t.playbackError)}
      >
        {['original', 'translated'].map((track) => (
          <track
            key={track}
            id={track}
            kind="subtitles"
            label={track === 'original' ? t.original : t.translated}
            src={`/api/captions/${source.id}/${track}.vtt`}
            onLoad={configureTracks}
          />
        ))}
      </Tag>
      <div className="media-surface">
        {source.kind === 'audio' && (
          <div className="audio-artwork">
            <Headphones size={44} />
            <span>{source.name}</span>
            {caption && <p className="audio-caption">{caption}</p>}
          </div>
        )}
        <IconButton
          label={playing ? t.pause : t.play}
          onClick={() => void toggle()}
          disabled={!duration}
        >
          {playing ? <Pause size={30} /> : <Play size={30} />}
        </IconButton>
      </div>
      {error && (
        <p className="player-error" role="alert">
          {error}
        </p>
      )}
      <div className="player-controls" inert={!visible}>
        {currentChapter && <div className="player-chapter">{currentChapter.title}</div>}
        <div className="media-timeline" style={{ paddingTop: Math.max(24, 8 + laneCount * 14) }}>
          {chapters.length > 0 && (
            <div className="chapter-markers" aria-label={t.chapterMarkers}>
              {chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  type="button"
                  aria-label={`${t.chapters}: ${chapter.title} · ${formatTime(chapter.start)}–${formatTime(chapter.end)}`}
                  title={`${chapter.title} · ${formatTime(chapter.start)}–${formatTime(chapter.end)}`}
                  aria-current={chapter.id === currentChapter?.id ? 'true' : undefined}
                  style={{
                    left: `${(chapter.start / duration) * 100}%`,
                    top: `${chapter.lane * 14}px`,
                    width: `${((chapter.end - chapter.start) / duration) * 100}%`,
                  }}
                  onClick={() => changeTime(chapter.start)}
                >
                  <span />
                </button>
              ))}
            </div>
          )}
          <input
            type="range"
            aria-label={t.seekRecording}
            aria-valuetext={`${formatTime(time)} / ${formatTime(duration)}`}
            min={0}
            max={duration || 0}
            step={0.1}
            disabled={!duration}
            value={boundedTime(time, duration)}
            onChange={(event) => changeTime(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                event.stopPropagation();
                changeTime(time + (event.key === 'ArrowRight' ? 5 : -5));
              }
            }}
          />
          <div className="bookmark-markers" aria-label={t.bookmarkMarkers}>
            {bookmarks
              .filter(
                (bookmark) =>
                  bookmark.seconds != null &&
                  Number.isFinite(bookmark.seconds) &&
                  bookmark.seconds >= 0 &&
                  bookmark.seconds <= duration &&
                  duration > 0,
              )
              .map((bookmark) => (
                <button
                  key={bookmark.id}
                  type="button"
                  style={{ left: `${(bookmark.seconds! / duration) * 100}%` }}
                  aria-label={`${t.addBookmark}: ${formatTime(bookmark.seconds!)} · ${bookmark.label}`}
                  title={`${formatTime(bookmark.seconds!)} · ${bookmark.label}`}
                  onClick={() => changeTime(bookmark.seconds!)}
                >
                  <Bookmark size={12} />
                </button>
              ))}
          </div>
        </div>
        <div className="player-buttons">
          <IconButton
            label={playing ? t.pause : t.play}
            disabled={!duration}
            onClick={() => void toggle()}
          >
            {playing ? <Pause /> : <Play />}
          </IconButton>
          <IconButton
            label={t.skipBackward}
            disabled={!duration}
            onClick={() => changeTime(time - 5)}
          >
            <RotateCcw />
            <span>5</span>
          </IconButton>
          <IconButton
            label={t.skipForward}
            disabled={!duration}
            onClick={() => changeTime(time + 5)}
          >
            <RotateCw />
            <span>5</span>
          </IconButton>
          <span className="player-time" aria-live="off">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <IconButton
            label={preferences.muted || preferences.volume === 0 ? t.unmute : t.mute}
            aria-pressed={preferences.muted}
            onClick={() =>
              setPreferences((current) => ({
                ...current,
                muted: current.volume === 0 ? false : !current.muted,
                volume: current.volume === 0 ? 1 : current.volume,
              }))
            }
          >
            {preferences.muted || preferences.volume === 0 ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <input
            className="player-volume"
            aria-label={t.volume}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={preferences.muted ? 0 : preferences.volume}
            onChange={(event) =>
              setPreferences((current) => ({
                ...current,
                volume: Number(event.target.value),
                muted: false,
              }))
            }
          />
          <div className="player-speed">
            <IconButton
              label={t.slower}
              disabled={preferences.speed <= 0.25}
              onClick={() => changeSpeed(preferences.speed - 0.25)}
            >
              <Minus />
            </IconButton>
            <select
              aria-label={t.playbackSpeed}
              value={preferences.speed}
              onChange={(event) => changeSpeed(Number(event.target.value))}
            >
              {playbackSpeeds.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
            <IconButton
              label={t.faster}
              disabled={preferences.speed >= 4}
              onClick={() => changeSpeed(preferences.speed + 0.25)}
            >
              <Plus />
            </IconButton>
          </div>
          <select
            aria-label={t.subtitle}
            value={preferences.track}
            onChange={(event) =>
              setPreferences((current) => ({ ...current, track: event.target.value }))
            }
          >
            <option value="off">{t.captionsOff}</option>
            <option value="original">{t.original}</option>
            <option value="translated">{t.translated}</option>
          </select>
          <IconButton
            label={fullscreen ? t.exitFullscreen : t.fullscreen}
            onClick={() => {
              if (!root.current?.requestFullscreen) {
                setError(t.fullscreenError);
                return;
              }
              const operation =
                document.fullscreenElement === root.current
                  ? document.exitFullscreen()
                  : root.current?.requestFullscreen();
              void operation?.catch(() => setError(t.fullscreenError));
            }}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
