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
  Settings,
  ChevronLeft,
  ChevronRight,
  Check,
} from 'lucide-react';
import type { Source, PublicLearning, Bookmark as SavedBookmark } from '../shared/domain';
import { captionCues } from '../shared/caption-cues';
import {
  boundedTime,
  chapterRanges,
  chapterLanes,
  formatTime,
  playbackSpeeds,
} from '../shared/media-controls';
import { IconButton } from './design/components';
import type { T } from './i18n';
import type { ReadingProgress } from '../shared/chapters';

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
  onReadingProgress,
  onPlaying,
  suspended = false,
  resumeSignal = 0,
}: {
  source: Source;
  learning: PublicLearning | null;
  bookmarks: SavedBookmark[];
  position: number;
  onPosition: (value: number) => void;
  seek: { value: number; nonce: number } | null;
  t: T;
  onReadingProgress?: (event: ReadingProgress) => void;
  onPlaying?: (value: boolean) => void;
  suspended?: boolean;
  resumeSignal?: number;
}) {
  const root = useRef<HTMLDivElement>(null),
    media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const storageKey = `tl:media:${source.id}:v${source.version}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey)),
    [time, setTime] = useState(position),
    [duration, setDuration] = useState(0),
    [playing, setPlaying] = useState(false),
    [visible, setVisible] = useState(true),
    [menu, setMenu] = useState<null | 'root' | 'speed' | 'subtitle'>(null),
    [fullscreen, setFullscreen] = useState(false),
    [error, setError] = useState(''),
    [caption, setCaption] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    dragging = useRef(false),
    keyboard = useRef(false),
    revealTouch = useRef(false),
    lastReported = useRef(0),
    pendingSeek = useRef(false),
    restoring = useRef(false),
    positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const readingCallback = useRef(onReadingProgress),
    playingCallback = useRef(onPlaying);
  readingCallback.current = onReadingProgress;
  playingCallback.current = onPlaying;
  const ignoredTime = useRef(false);
  useEffect(() => {
    if (suspended) media.current?.pause();
  }, [suspended]);
  const consumedResume = useRef(resumeSignal);
  useEffect(() => {
    if (consumedResume.current === resumeSignal) return;
    consumedResume.current = resumeSignal;
    if (resumeSignal && media.current && !suspended)
      void media.current.play().catch(() => setError(t.playbackError));
  }, [resumeSignal]);
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
    }, 2200);
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
      playingCallback.current?.(false);
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
  // A settings menu stays open while the controls are visible and closes with them.
  useEffect(() => {
    if (!visible && menu) setMenu(null);
  }, [visible, menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  const changeTime = (value: number) => {
    const player = media.current;
    if (!player || !Number.isFinite(player.duration)) return;
    const next = boundedTime(value, player.duration);
    player.currentTime = next;
    ignoredTime.current = true;
    readingCallback.current?.({ value: next, cause: 'seek' });
    setTime(next);
    // A seek while paused is only checkpointed once playback resumes from there.
    if (player.paused) pendingSeek.current = true;
    else positionCallback.current(next);
    wake();
  };
  useEffect(() => {
    if (seek) changeTime(seek.value);
  }, [seek?.nonce]);
  // Captions prepared before cues were split hold whole transcribed turns; split them on load.
  const splitLongCues = (track: TextTrack) => {
    for (const cue of Array.from(track.cues || []) as VTTCue[]) {
      const parts = captionCues(cue.text, cue.startTime, cue.endTime);
      if (parts.length < 2) {
        liftCue(cue);
        continue;
      }
      track.removeCue(cue);
      for (const part of parts) {
        const next = new VTTCue(part.start, part.end, part.text);
        liftCue(next);
        track.addCue(next);
      }
    }
  };
  /** Keeps subtitles clear of the bottom edge so the controls bar never covers them. */
  const liftCue = (cue: VTTCue) => {
    cue.snapToLines = true;
    cue.line = -3;
  };
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
      if (track.mode !== 'disabled') {
        splitLongCues(track);
        for (const cue of Array.from(track.cues || []) as VTTCue[]) liftCue(cue);
      }
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
  useEffect(() => {
    configureTracks();
    // React does not report a track's load, and cues only exist once it has loaded.
    const elements = Array.from(media.current?.querySelectorAll('track') || []);
    for (const element of elements) element.addEventListener('load', configureTracks);
    return () => {
      for (const element of elements) element.removeEventListener('load', configureTracks);
    };
  }, [preferences.track, source.id]);
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
    } else if (event.key.toLowerCase() === 'm' && event.target === root.current) {
      event.preventDefault();
      setPreferences((current) => ({ ...current, muted: !current.muted }));
    } else if (event.key.toLowerCase() === 'f' && event.target === root.current) {
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen();
      else void root.current?.requestFullscreen?.();
    } else if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      event.target === root.current
    ) {
      event.preventDefault();
      setPreferences((current) => ({
        ...current,
        volume: Math.max(0, Math.min(1, current.volume + (event.key === 'ArrowUp' ? 0.1 : -0.1))),
        muted: false,
      }));
    }
  };
  const markedBookmarks = bookmarks.filter(
    (bookmark) =>
      bookmark.seconds != null &&
      Number.isFinite(bookmark.seconds) &&
      bookmark.seconds >= 0 &&
      bookmark.seconds <= duration &&
      duration > 0,
  );
  const tipSide = (percent: number) => (percent < 15 ? 'start' : percent > 85 ? 'end' : '');
  const timeline = (
    <div
      className="media-timeline"
      style={{ paddingTop: chapters.length ? 20 + laneCount * 16 : 16 }}
    >
      {chapters.length > 0 && (
        <div className="chapter-markers" aria-label={t.chapterMarkers}>
          {chapters.map((chapter, index) => {
            const left = (chapter.start / duration) * 100;
            const description = `${chapter.title} · ${formatTime(chapter.start)}–${formatTime(chapter.end)}`;
            return (
              <button
                key={chapter.id}
                type="button"
                className={index % 2 ? 'alternate' : ''}
                aria-label={`${t.chapters}: ${description}`}
                aria-current={chapter.id === currentChapter?.id ? 'true' : undefined}
                style={{
                  left: `${left}%`,
                  top: `${chapter.lane * 16}px`,
                  width: `${((chapter.end - chapter.start) / duration) * 100}%`,
                }}
                onClick={() => changeTime(chapter.start)}
              >
                <span className="marker-bar" />
                <span className={`marker-tip ${tipSide(left)}`}>{description}</span>
              </button>
            );
          })}
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
      {markedBookmarks.length > 0 && (
        <div className="bookmark-markers" aria-label={t.bookmarkMarkers}>
          {markedBookmarks.map((bookmark) => {
            const left = (bookmark.seconds! / duration) * 100;
            const description = `${formatTime(bookmark.seconds!)} · ${bookmark.label}`;
            return (
              <button
                key={bookmark.id}
                type="button"
                style={{ left: `${left}%` }}
                aria-label={`${t.addBookmark}: ${description}`}
                onClick={() => changeTime(bookmark.seconds!)}
              >
                <Bookmark size={16} fill="currentColor" />
                <span className={`marker-tip ${tipSide(left)}`}>{description}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
  const clock = (
    <span className="player-time" aria-live="off">
      {formatTime(time)} / {formatTime(duration)}
    </span>
  );
  const speedGroup = (
    <div className="player-speed" role="group" aria-label={t.playbackSpeed}>
      <button
        type="button"
        aria-label={t.slower}
        title={t.slower}
        disabled={preferences.speed <= 0.25}
        onClick={() => changeSpeed(preferences.speed - 0.25)}
      >
        <Minus size={14} />
      </button>
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
      <button
        type="button"
        aria-label={t.faster}
        title={t.faster}
        disabled={preferences.speed >= 4}
        onClick={() => changeSpeed(preferences.speed + 0.25)}
      >
        <Plus size={14} />
      </button>
    </div>
  );
  const captionSelect = (
    <select
      className="player-captions"
      aria-label={t.subtitle}
      value={preferences.track}
      onChange={(event) => setPreferences((current) => ({ ...current, track: event.target.value }))}
    >
      <option value="off">{t.captionsOff}</option>
      <option value="original">{t.original}</option>
      <option value="translated">{t.translated}</option>
    </select>
  );
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
        onClick={source.kind === 'video' ? () => void toggle() : undefined}
        onDoubleClick={
          source.kind === 'video'
            ? (event) => {
                event.preventDefault();
                if (document.fullscreenElement) void document.exitFullscreen();
                else void root.current?.requestFullscreen?.();
              }
            : undefined
        }
        onLoadedMetadata={() => {
          const player = media.current!;
          setDuration(player.duration);
          const initial = boundedTime(seek?.value ?? position, player.duration);
          restoring.current = initial !== player.currentTime;
          player.currentTime = initial;
          readingCallback.current?.({ value: initial, cause: 'restore' });
          setTime(initial);
          player.playbackRate = preferences.speed;
          player.volume = preferences.volume;
          player.muted = preferences.muted;
          configureTracks();
        }}
        onPlay={() => {
          setPlaying(true);
          playingCallback.current?.(true);
          if (pendingSeek.current && media.current) {
            pendingSeek.current = false;
            positionCallback.current(media.current.currentTime);
          }
          lastReported.current = Date.now();
        }}
        onPause={() => {
          setPlaying(false);
          playingCallback.current?.(false);
          if (media.current) positionCallback.current(media.current.currentTime);
        }}
        onEnded={() => {
          if (media.current)
            readingCallback.current?.({
              value: media.current.currentTime,
              cause: 'read',
              playing: false,
            });
          setPlaying(false);
          playingCallback.current?.(false);
          if (media.current) positionCallback.current(media.current.currentTime);
        }}
        onSeeked={() => {
          if (media.current) {
            setTime(media.current.currentTime);
            // The restore seek on load is not a reader's seek.
            if (restoring.current) restoring.current = false;
            else if (media.current.paused) pendingSeek.current = true;
            else positionCallback.current(media.current.currentTime);
            readingCallback.current?.({ value: media.current.currentTime, cause: 'seek' });
          }
        }}
        onTimeUpdate={() => {
          if (media.current) {
            setTime(media.current.currentTime);
            readingCallback.current?.({
              value: media.current.currentTime,
              cause:
                media.current.seeking || ignoredTime.current
                  ? 'seek'
                  : media.current.paused
                    ? 'restore'
                    : 'read',
              playing: !media.current.paused,
            });
            ignoredTime.current = false;
            // Continuous playback checkpoints every 15 seconds.
            if (Date.now() - lastReported.current >= 15000) {
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
          />
        ))}
      </Tag>
      {source.kind === 'audio' ? (
        <div className="audio-card">
          <Headphones size={40} />
          <p className="audio-title">{source.name}</p>
          <p className="audio-subtitle">{t.audioRecording}</p>
          {caption && <p className="audio-caption">{caption}</p>}
          {timeline}
          <div className="audio-row">
            <button
              type="button"
              className="audio-play"
              aria-label={playing ? t.pause : t.play}
              disabled={!duration}
              onClick={() => void toggle()}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            {clock}
            <div className="player-end">
              {speedGroup}
              {captionSelect}
            </div>
          </div>
        </div>
      ) : null}
      {error && (
        <p className="player-error" role="alert">
          {error}
        </p>
      )}
      {source.kind === 'video' && (
        <div className="player-controls" inert={!visible}>
          {timeline}
          <div className="player-buttons">
            <IconButton
              label={t.skipBackward}
              disabled={!duration}
              onClick={() => changeTime(time - 5)}
            >
              <span className="skip-glyph" aria-hidden="true">
                <RotateCcw />
                <span>5</span>
              </span>
            </IconButton>
            <IconButton
              label={playing ? t.pause : t.play}
              disabled={!duration}
              onClick={() => void toggle()}
            >
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <IconButton
              label={t.skipForward}
              disabled={!duration}
              onClick={() => changeTime(time + 5)}
            >
              <span className="skip-glyph" aria-hidden="true">
                <RotateCw />
                <span>5</span>
              </span>
            </IconButton>
            {clock}
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
            <div className="player-end">
              <div className="player-inline-options">
                {speedGroup}
                {captionSelect}
              </div>
              <div className="player-menu">
                <IconButton
                  label={t.playerSettings}
                  aria-expanded={!!menu}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu((value) => (value ? null : 'root'));
                  }}
                >
                  <Settings />
                </IconButton>
                {menu && (
                  <div
                    role="menu"
                    className="player-menu-popover"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {menu === 'root' && (
                      <>
                        <button
                          type="button"
                          className="player-menu-row"
                          onClick={() => setMenu('speed')}
                        >
                          <span className="player-menu-row-label">{t.playbackSpeed}</span>
                          <span className="player-menu-row-value">
                            {preferences.speed === 1 ? t.speedNormal : `${preferences.speed}×`}
                          </span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="player-menu-row"
                          onClick={() => setMenu('subtitle')}
                        >
                          <span className="player-menu-row-label">{t.subtitle}</span>
                          <span className="player-menu-row-value">
                            {preferences.track === 'off'
                              ? t.captionsOff
                              : preferences.track === 'original'
                                ? t.original
                                : t.translated}
                          </span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      </>
                    )}
                    {menu === 'speed' && (
                      <>
                        <button
                          type="button"
                          className="player-menu-back"
                          onClick={() => setMenu('root')}
                        >
                          <ChevronLeft size={16} aria-hidden="true" />
                          {t.playbackSpeed}
                        </button>
                        {playbackSpeeds
                          .filter((speed) => [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(speed))
                          .map((speed) => (
                            <button
                              key={speed}
                              type="button"
                              className="player-menu-option"
                              aria-checked={preferences.speed === speed}
                              role="menuitemradio"
                              onClick={() => {
                                changeSpeed(speed);
                                setMenu('root');
                              }}
                            >
                              {preferences.speed === speed ? (
                                <Check size={14} aria-hidden="true" />
                              ) : (
                                <span className="player-menu-check" />
                              )}
                              <span>{speed === 1 ? t.speedNormal : `${speed}×`}</span>
                            </button>
                          ))}
                      </>
                    )}
                    {menu === 'subtitle' && (
                      <>
                        <button
                          type="button"
                          className="player-menu-back"
                          onClick={() => setMenu('root')}
                        >
                          <ChevronLeft size={16} aria-hidden="true" />
                          {t.subtitle}
                        </button>
                        {(['off', 'original', 'translated'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className="player-menu-option"
                            aria-checked={preferences.track === value}
                            role="menuitemradio"
                            onClick={() => {
                              setPreferences((current) => ({ ...current, track: value }));
                              setMenu('root');
                            }}
                          >
                            {preferences.track === value ? (
                              <Check size={14} aria-hidden="true" />
                            ) : (
                              <span className="player-menu-check" />
                            )}
                            <span>
                              {value === 'off'
                                ? t.captionsOff
                                : value === 'original'
                                  ? t.original
                                  : t.translated}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
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
      )}
    </div>
  );
}
