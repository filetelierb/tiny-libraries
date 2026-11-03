import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Typing-pause coordination between a text composer and nearby media players.
 *
 * The composer calls {@link TypingPauseController.pulse} on every keystroke; the
 * controller keeps `typing` true until a short quiet window (RESUME_DELAY_MS) has
 * passed with no further pulses. {@link TypingPauseController.release} forces
 * the flag off immediately (used on blur / submit / cancel).
 *
 * Any {@link MediaPlayer} subscribed through this context pauses when the flag
 * flips on and remembers that *it* was the one pausing, so it only resumes when
 * the flag flips back off AND the player itself is still the owner of the
 * pause: a user-initiated play or pause during the composer session clears
 * ownership.
 */
export type TypingPauseController = {
  typing: boolean;
  pulse: () => void;
  release: () => void;
};

export const RESUME_DELAY_MS = 2000;

const noopController: TypingPauseController = {
  typing: false,
  pulse: () => {},
  release: () => {},
};

export const TypingPauseContext = createContext<TypingPauseController>(noopController);

export function useTypingPauseController() {
  return useContext(TypingPauseContext);
}

/**
 * Returns a stable controller that tracks typing activity with a debounced
 * release. Mount this once near the top of the subtree that shares a composer
 * and the players it should pause.
 */
export function useProvideTypingPause(): TypingPauseController {
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRef = useRef(false);
  typingRef.current = typing;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const pulse = useCallback(() => {
    if (!typingRef.current) setTyping(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setTyping(false);
    }, RESUME_DELAY_MS);
  }, []);
  const release = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (typingRef.current) setTyping(false);
  }, []);
  return useMemo(() => ({ typing, pulse, release }), [typing, pulse, release]);
}
