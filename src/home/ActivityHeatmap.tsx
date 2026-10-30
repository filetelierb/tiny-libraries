import { useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import {
  activityKinds,
  activityLevel,
  activityWeights,
  activityStreaks,
  heatmapStart,
  localDay,
  type ActivityDay,
} from '../../shared/projects';
import type { Locale } from '../../shared/domain';
import type { T } from '../i18n';
import { Modal } from '../design/components';

/** One square per day for the last year, across every project, like a contribution graph. */
export function ActivityHeatmap({
  activity,
  projectNames,
  locale,
  t,
}: {
  activity: ActivityDay[];
  projectNames: Map<string, string>;
  locale: Locale;
  t: T;
}) {
  const [hovered, setHovered] = useState<{ day: string; x: number; y: number } | null>(null),
    [selected, setSelected] = useState(() => localDay()),
    [scoring, setScoring] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const weekStart = locale === 'es' ? 1 : 0;
  const { days, counts, max, total, months, weekdays } = useMemo(() => {
    const today = new Date(),
      start = heatmapStart(today, weekStart),
      days: Date[] = [];
    for (const date = new Date(start); date <= today; date.setDate(date.getDate() + 1))
      days.push(new Date(date));
    const counts = new Map(activity.map((day) => [day.day, day.total]));
    const shown = days.map((date) => counts.get(localDay(date)) || 0);
    const monthName = new Intl.DateTimeFormat(locale, { month: 'short' });
    const months: Array<{ column: number; label: string }> = [];
    for (let column = 0; column * 7 < days.length; column++) {
      const first = days[column * 7];
      if (column === 0 || first.getMonth() !== days[(column - 1) * 7].getMonth())
        months.push({ column, label: monthName.format(first) });
    }
    // A label squeezed into the first column before the next month starts is dropped.
    if (months.length > 1 && months[1].column - months[0].column < 3) months.shift();
    const weekdayName = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    return {
      days,
      counts,
      max: Math.max(0, ...shown),
      total: shown.reduce((sum, count) => sum + count, 0),
      months,
      // Like a contribution graph, only Monday, Wednesday and Friday are labelled.
      weekdays: days
        .slice(0, 7)
        .map((date) => ([1, 3, 5].includes(date.getDay()) ? weekdayName.format(date) : '')),
    };
  }, [activity, locale, weekStart]);
  const keys = days.map((date) => localDay(date)),
    streaks = activityStreaks(keys, counts),
    activeDays = keys.filter((day) => counts.get(day)).length;
  const dateName = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const describe = (day: string) => {
    const count = counts.get(day) || 0,
      date = dateName.format(new Date(`${day}T12:00:00`));
    return (count === 0 ? t.activityNone : count === 1 ? t.activityOne : t.activityDay)
      .replace('{n}', String(count))
      .replace('{date}', date);
  };
  const unit = (n: number) => `${n} ${n === 1 ? t.activityDayUnit : t.activityDaysUnit}`;
  const points = (n: number) => `${n} ${n === 1 ? t.activityPointUnit : t.activityPointsUnit}`;
  const log = activity.find((day) => day.day === selected);
  /** Arrow keys move the chosen day: a row is a weekday and a column a week. */
  function move(day: string, key: string) {
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[key];
    if (!step) return false;
    const next = keys[Math.min(keys.length - 1, Math.max(0, keys.indexOf(day) + step))];
    setSelected(next);
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
    return true;
  }
  return (
    <div className="activity">
      <dl className="activity-stats">
        <div>
          <dt>{t.activityYear}</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>{t.activityActiveDays}</dt>
          <dd>{activeDays}</dd>
        </div>
        <div>
          <dt>{t.activityStreak}</dt>
          <dd>{unit(streaks.current)}</dd>
        </div>
        <div>
          <dt>{t.activityLongest}</dt>
          <dd>{unit(streaks.longest)}</dd>
        </div>
      </dl>
      <div className="activity-scroll">
        <div className="activity-chart" onMouseLeave={() => setHovered(null)}>
          <div className="activity-months" aria-hidden="true">
            {months.map((month) => (
              <span key={month.column} style={{ gridColumn: `${month.column + 1} / span 4` }}>
                {month.label}
              </span>
            ))}
          </div>
          <div className="activity-weekdays" aria-hidden="true">
            {weekdays.map((name, row) => (
              <span key={row}>{name}</span>
            ))}
          </div>
          <div
            ref={grid}
            className="activity-grid"
            role="group"
            aria-label={t.activityTotal.replace('{n}', String(total))}
          >
            {keys.map((day) => (
              <button
                key={day}
                type="button"
                data-day={day}
                data-level={activityLevel(counts.get(day) || 0, max)}
                data-today={day === keys[keys.length - 1] || undefined}
                aria-label={describe(day)}
                aria-pressed={selected === day}
                tabIndex={selected === day ? 0 : -1}
                onClick={() => setSelected(day)}
                onKeyDown={(event) => {
                  if (move(day, event.key)) event.preventDefault();
                }}
                onMouseEnter={(event) => {
                  const cell = event.currentTarget.getBoundingClientRect(),
                    chart = event.currentTarget.closest('.activity-chart')!.getBoundingClientRect();
                  setHovered({
                    day,
                    x: cell.left - chart.left + cell.width / 2,
                    y: cell.top - chart.top,
                  });
                }}
              />
            ))}
          </div>
          {hovered && (
            <div
              className="activity-tooltip"
              role="tooltip"
              style={{ left: hovered.x, top: hovered.y }}
            >
              {describe(hovered.day)}
            </div>
          )}
        </div>
      </div>
      <div className="activity-footer">
        <button type="button" className="activity-scoring-open" onClick={() => setScoring(true)}>
          <Info size={14} aria-hidden="true" />
          {t.activityScoring}
        </button>
        <div className="activity-legend" aria-hidden="true">
          <span>{t.activityLess}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i key={level} data-level={level} />
          ))}
          <span>{t.activityMore}</span>
        </div>
      </div>
      <section className="activity-log" aria-live="polite" aria-labelledby="activity-log-title">
        <header>
          <h3 id="activity-log-title">
            {selected === localDay()
              ? t.activityToday
              : dateName.format(new Date(`${selected}T12:00:00`))}
          </h3>
          <strong>{points(log?.total || 0)}</strong>
        </header>
        {log?.total ? (
          <>
            <ul className="activity-log-kinds">
              {activityKinds
                .filter((kind) => log.kinds?.[kind])
                .map((kind) => (
                  <li key={kind}>
                    <span>{t[`activityKind_${kind}`]}</span>
                    <small>× {log.kinds![kind]}</small>
                    <strong>+{log.kinds![kind]! * activityWeights[kind]}</strong>
                  </li>
                ))}
            </ul>
            <p className="activity-log-projects">
              {Object.entries(log.projects)
                .sort((a, b) => b[1] - a[1])
                .map(([id, value]) => (
                  <span key={id}>
                    {projectNames.get(id) || '—'} · {points(value)}
                  </span>
                ))}
            </p>
          </>
        ) : (
          <p className="muted">{t.activityLogEmpty}</p>
        )}
      </section>
      {scoring && (
        <Modal
          title={t.activityScoring}
          close={() => setScoring(false)}
          closeLabel={t.close}
          className="activity-scoring-modal"
        >
          <p className="muted">{t.activityScoringIntro}</p>
          <ul className="activity-scoring">
            {activityKinds.map((kind) => (
              <li key={kind}>
                <span>
                  {t[`activityKind_${kind}`]}
                  <small>{t[`activityRule_${kind}`]}</small>
                </span>
                <strong>+{points(activityWeights[kind])}</strong>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
