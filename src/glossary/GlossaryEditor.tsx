import { useState } from 'react';
import { ArrowLeft, FolderOpen, Link as LinkIcon, LoaderCircle, Plus, Save, X } from 'lucide-react';
import type { Catalog, ConceptSource, PublicLearning, Source } from '../../shared/domain';
import { normalizeConcept, type GlossaryEntry, type GlossarySense } from '../../shared/glossary';
import { api } from '../api';
import { locationSchema } from '../../shared/annotations';
import { Button, IconButton, Modal, LoadingRow } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import type { T } from '../i18n';

export function GlossaryEditor({
  initial,
  catalog,
  actions,
  t,
  save,
  cancel,
}: {
  initial: GlossaryEntry;
  catalog: Catalog;
  actions: TreeActions;
  t: T;
  save: (entry: GlossaryEntry) => Promise<void>;
  cancel: () => void;
}) {
  const [value, setValue] = useState(() => structuredClone(initial));
  const [aliases, setAliases] = useState(initial.aliases.join('\n'));
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [picker, setPicker] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    file: Source;
    learning: PublicLearning | null;
  } | null>(null);
  const [segmentId, setSegmentId] = useState(''),
    [page, setPage] = useState(''),
    [seconds, setSeconds] = useState(''),
    [quote, setQuote] = useState('');
  const [loadingSource, setLoadingSource] = useState(false);
  const patchSense = (id: string, patch: Partial<GlossarySense>) =>
    setValue((v) => ({
      ...v,
      senses: v.senses.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  const candidates = catalog.concepts
    .filter((c) => c.id !== value.id && !c.archived && !c.mergedInto)
    .sort((a, b) => a.term.localeCompare(b.term));
  const selectFile = async (file: Source) => {
    setLoadingSource(true);
    setError('');
    try {
      const learning = await api<PublicLearning | null>(`/learning/${file.id}`);
      setSelected({ file, learning });
      setSegmentId('');
      setPage('');
      setSeconds('');
      setQuote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setLoadingSource(false);
    }
  };
  const addSource = () => {
    if (!selected || !picker) return;
    const segment = selected.learning?.segments.find((s) => s.id === segmentId);
    const location = segment
      ? {
          ...(segment.page ? { page: segment.page } : {}),
          ...(segment.start != null ? { seconds: segment.start } : {}),
          quote: segment.text.slice(0, 8000),
        }
      : {
          ...(page ? { page: Number(page) } : {}),
          ...(seconds ? { seconds: Number(seconds) } : {}),
          ...(quote.trim() ? { quote: quote.trim() } : {}),
        };
    if (!locationSchema.safeParse(location).success) {
      setError(t.invalidSourceLocation);
      return;
    }
    const source: ConceptSource = {
      sourceId: selected.file.id,
      sourceVersion: selected.file.version,
      segmentIds: segment ? [segment.id] : [],
      location,
    };
    const sense = value.senses.find((s) => s.id === picker)!;
    patchSense(picker, { sources: [...sense.sources, source] });
    setPicker(null);
    setSelected(null);
  };
  return (
    <form
      className="glossary-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        setPending(true);
        setError('');
        void save(
          normalizeConcept({
            ...value,
            aliases: aliases
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }),
        )
          .catch((e) => setError(e instanceof Error ? e.message : t.error))
          .finally(() => setPending(false));
      }}
    >
      <header>
        <IconButton label={t.cancel} disabled={pending} onClick={cancel}>
          <ArrowLeft />
        </IconButton>
        <h3>{initial.version ? t.editConcept : t.newConcept}</h3>
      </header>
      <fieldset disabled={pending}>
        <label>
          {t.conceptTitle}
          <input
            required
            maxLength={200}
            value={value.term}
            onChange={(e) => setValue((v) => ({ ...v, term: e.target.value }))}
            autoFocus
          />
        </label>
        <label>
          {t.conceptAliases}
          <textarea
            rows={2}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={t.oneAliasPerLine}
          />
        </label>
        {value.senses.map((sense, index) => (
          <section className="glossary-edit-sense" key={sense.id}>
            <header>
              <h4>
                {t.meaning} {index + 1}
              </h4>
              {value.senses.length > 1 && (
                <IconButton
                  label={`${t.removeMeaning} ${index + 1}`}
                  onClick={() =>
                    setValue((v) => ({ ...v, senses: v.senses.filter((s) => s.id !== sense.id) }))
                  }
                >
                  <X />
                </IconButton>
              )}
            </header>
            <label>
              {t.meaningLabel}
              <input
                maxLength={160}
                value={sense.label}
                onChange={(e) => patchSense(sense.id, { label: e.target.value })}
              />
            </label>
            <label>
              {t.definitionMarkdown}
              <textarea
                required
                maxLength={12000}
                rows={7}
                value={sense.definition}
                onChange={(e) => patchSense(sense.id, { definition: e.target.value })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sense.reviewed}
                onChange={(e) => patchSense(sense.id, { reviewed: e.target.checked })}
              />
              {t.reviewed}
            </label>
            <h5>{t.linkedSynonyms}</h5>
            {!!sense.synonyms.length && (
              <div className="glossary-chips">
                {sense.synonyms.map((id) => {
                  const term = catalog.concepts.find((c) => c.id === id)?.term;
                  return (
                    <span className="glossary-chip" key={id}>
                      <LinkIcon />
                      {term || t.sourceUnavailable}
                      <button
                        type="button"
                        aria-label={`${t.remove} ${term || ''}`}
                        onClick={() =>
                          patchSense(sense.id, {
                            synonyms: sense.synonyms.filter((s) => s !== id),
                          })
                        }
                      >
                        <X />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <label>
              {t.addSynonym}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    patchSense(sense.id, { synonyms: [...sense.synonyms, e.target.value] });
                }}
                disabled={sense.synonyms.length >= 30}
              >
                <option value="">{t.chooseConcept}</option>
                {candidates
                  .filter((c) => !sense.synonyms.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.term}
                    </option>
                  ))}
              </select>
            </label>
            <h5>{t.semanticRelations}</h5>
            {sense.relations.map((relation, i) => (
              <div className="glossary-edit-relation" key={relation.entryId}>
                <div className="glossary-edit-link">
                  <span>
                    {catalog.concepts.find((c) => c.id === relation.entryId)?.term ||
                      t.sourceUnavailable}
                  </span>
                  <IconButton
                    label={`${t.remove} ${catalog.concepts.find((c) => c.id === relation.entryId)?.term || ''}`}
                    onClick={() =>
                      patchSense(sense.id, { relations: sense.relations.filter((_, k) => k !== i) })
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
                <label>
                  {t.relationshipDescription}
                  <textarea
                    required
                    maxLength={2000}
                    rows={2}
                    value={relation.description}
                    onChange={(e) =>
                      patchSense(sense.id, {
                        relations: sense.relations.map((r, k) =>
                          k === i ? { ...r, description: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <label>
              {t.addRelation}
              <select
                value=""
                disabled={sense.relations.length >= 30}
                onChange={(e) => {
                  if (e.target.value)
                    patchSense(sense.id, {
                      relations: [...sense.relations, { entryId: e.target.value, description: '' }],
                    });
                }}
              >
                <option value="">{t.chooseConcept}</option>
                {candidates
                  .filter((c) => !sense.relations.some((r) => r.entryId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.term}
                    </option>
                  ))}
              </select>
            </label>
            <h5>{t.sourceReferences}</h5>
            {sense.sources.map((source, i) => (
              <div className="glossary-edit-link" key={`${source.sourceId}-${i}`}>
                <span>
                  {catalog.files.find((f) => f.id === source.sourceId)?.name || t.sourceUnavailable}
                  {source.location?.page ? ` · ${t.page} ${source.location.page}` : ''}
                  {source.location?.seconds != null ? ` · ${source.location.seconds}s` : ''}
                </span>
                <IconButton
                  label={`${t.remove} ${t.sourceReferences} ${i + 1}`}
                  onClick={() =>
                    patchSense(sense.id, { sources: sense.sources.filter((_, k) => k !== i) })
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
            ))}
            <Button
              disabled={sense.sources.length >= 30}
              onClick={() => {
                setPicker(sense.id);
                setSelected(null);
              }}
            >
              <FolderOpen size={14} />
              {t.addSourceReference}
            </Button>
          </section>
        ))}
        <Button
          disabled={value.senses.length >= 20}
          onClick={() =>
            setValue((v) => ({
              ...v,
              senses: [
                ...v.senses,
                {
                  id: crypto.randomUUID(),
                  label: '',
                  definition: '',
                  reviewed: false,
                  sources: [],
                  synonyms: [],
                  relations: [],
                },
              ],
            }))
          }
        >
          <Plus size={14} />
          {t.addMeaning}
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <footer>
        <Button variant="ghost" disabled={pending} onClick={cancel}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <LoaderCircle className="spin" /> : <Save />}
          {pending ? t.saving : t.saveConcept}
        </Button>
      </footer>
      {picker && (
        <Modal
          title={t.addSourceReference}
          close={() => {
            if (!loadingSource) {
              setPicker(null);
              setSelected(null);
            }
          }}
          closeLabel={t.close}
        >
          {!selected ? (
            <>
              <DirectoryTree
                directories={catalog.directories}
                files={catalog.files}
                t={t}
                mode="file"
                actions={actions}
                storageKey="tl:glossary-source-picker"
                chooseFile={(file) => {
                  if (!loadingSource) void selectFile(file);
                }}
              />
              {loadingSource && <LoadingRow>{t.loading}</LoadingRow>}
            </>
          ) : (
            <div className="glossary-source-form">
              <strong>{selected.file.name}</strong>
              {error && <p role="alert">{error}</p>}
              {!!selected.learning?.segments.length && (
                <label>
                  {t.sourcePassage}
                  <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                    <option value="">{t.manualLocation}</option>
                    {selected.learning.segments.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.page ? `${t.page} ${s.page}: ` : s.start != null ? `${s.start}s: ` : ''}
                        {s.text.slice(0, 180)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!segmentId && (
                <>
                  <div className="glossary-location-fields">
                    {selected.file.kind === 'pdf' && (
                      <label>
                        {t.page}
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={page}
                          onChange={(e) => setPage(e.target.value)}
                        />
                      </label>
                    )}
                    {['audio', 'video'].includes(selected.file.kind) && (
                      <label>
                        {t.positionSeconds}
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={seconds}
                          onChange={(e) => setSeconds(e.target.value)}
                        />
                      </label>
                    )}
                  </div>
                  <label>
                    {t.sourceExcerpt}
                    <textarea
                      maxLength={8000}
                      rows={3}
                      value={quote}
                      onChange={(e) => setQuote(e.target.value)}
                    />
                  </label>
                </>
              )}
              <div className="glossary-actions">
                <Button onClick={() => setSelected(null)}>{t.chooseFile}</Button>
                <Button variant="primary" onClick={addSource}>
                  {t.addSourceReference}
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </form>
  );
}
