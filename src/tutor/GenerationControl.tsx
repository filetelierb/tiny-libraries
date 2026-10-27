import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, RotateCcw, Zap } from 'lucide-react';
import { IconButton } from '../design/components';
import type { T } from '../i18n';
import {
  defaultTutorPreference,
  reasoningEffortSchema,
  resolveTutorGeneration,
  tutorModelName,
  tutorModelSchema,
  type TutorGeneration,
  type TutorPreference,
} from '../../shared/tutor-generation';

export function GenerationLabel({
  value,
  t,
  compact = false,
}: {
  value: TutorGeneration;
  t: T;
  compact?: boolean;
}) {
  return (
    <>
      {compact ? tutorModelName(value.model).replace(/^Muse /, '') : tutorModelName(value.model)} ·{' '}
      {compact && value.reasoningEffort === 'auto'
        ? t.effortCompactAuto
        : t[`effort_${value.reasoningEffort}`]}
    </>
  );
}

export function GenerationControl({
  value,
  defaultModel,
  change,
  t,
}: {
  value: TutorPreference;
  defaultModel: string;
  change: (value: TutorPreference) => void;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const effective = resolveTutorGeneration(value, defaultModel);
  const close = (restore = true) => {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        ref={trigger}
        className="button button-ghost generation-trigger"
        type="button"
        aria-label={t.tutorGeneration}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-dialog` : undefined}
        title={`${t.tutorGeneration}: ${tutorModelName(effective.model)} · ${t[`effort_${effective.reasoningEffort}`]}`}
        onClick={() => setOpen(!open)}
      >
        <Zap size={15} />
        <span>
          <GenerationLabel value={effective} t={t} compact />
        </span>
        <ChevronDown size={13} />
      </button>
      {open && trigger.current && (
        <GenerationPopover
          id={`${id}-dialog`}
          value={value}
          defaultModel={defaultModel}
          change={change}
          t={t}
          anchor={trigger.current}
          close={close}
        />
      )}
    </>
  );
}

function GenerationPopover({
  id,
  value,
  defaultModel,
  change,
  t,
  anchor,
  close,
}: {
  id: string;
  value: TutorPreference;
  defaultModel: string;
  change: (value: TutorPreference) => void;
  t: T;
  anchor: HTMLButtonElement;
  close: (restore?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [point, setPoint] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const rect = popup.getBoundingClientRect(),
      target = anchor.getBoundingClientRect();
    setPoint({
      left: Math.max(8, Math.min(target.right - rect.width, window.innerWidth - rect.width - 8)),
      top: Math.max(
        8,
        Math.min(target.top - rect.height - 6, window.innerHeight - rect.height - 8),
      ),
    });
    popup.querySelector<HTMLInputElement>('input[type=range]')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node))
        close(false);
    };
    const resize = () => close();
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchor, close]);
  return createPortal(
    <div
      ref={ref}
      id={id}
      className="generation-popover"
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-notice`}
      style={point}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') {
          const controls = ref.current?.querySelectorAll('button, select, input');
          if (
            controls &&
            ((event.shiftKey && event.target === controls[0]) ||
              (!event.shiftKey && event.target === controls[controls.length - 1]))
          )
            close();
        }
      }}
    >
      <div className="generation-popover-title">
        <Zap aria-hidden="true" />
        <div>
          <strong id={`${id}-title`}>{t[`effort_${value.reasoningEffort}`]}</strong>
          <small>{tutorModelName(resolveTutorGeneration(value, defaultModel).model)}</small>
        </div>
        <IconButton label={t.resetGeneration} onClick={() => change(defaultTutorPreference)}>
          <RotateCcw />
        </IconButton>
      </div>
      <input
        type="range"
        min={0}
        max={reasoningEffortSchema.options.length - 1}
        step={1}
        value={reasoningEffortSchema.options.indexOf(value.reasoningEffort)}
        aria-label={t.reasoningEffort}
        aria-valuetext={t[`effort_${value.reasoningEffort}`]}
        onChange={(event) =>
          change({
            ...value,
            reasoningEffort: reasoningEffortSchema.options[Number(event.target.value)],
          })
        }
      />
      <div className="generation-presets">
        {reasoningEffortSchema.options.map((effort) => (
          <button
            type="button"
            key={effort}
            aria-pressed={value.reasoningEffort === effort}
            onClick={() => change({ ...value, reasoningEffort: effort })}
          >
            {t[`effort_${effort}`]}
          </button>
        ))}
      </div>
      <label>
        {t.tutorModel}
        <select
          value={value.model}
          onChange={(event) =>
            change({ ...value, model: event.target.value as TutorPreference['model'] })
          }
        >
          <option value="default">
            {t.useSettingsModel} · {tutorModelName(defaultModel)}
          </option>
          {tutorModelSchema.options.map((model) => (
            <option value={model} key={model}>
              {tutorModelName(model)}
            </option>
          ))}
        </select>
      </label>
      <p id={`${id}-notice`}>
        {t.generationNotice} {t.reasoningCostNotice}
      </p>
    </div>,
    anchor.closest('dialog') || document.body,
  );
}
