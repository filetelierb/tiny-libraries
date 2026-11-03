import { useState, type FormEvent } from 'react';
import type { ProjectSummary } from '../../shared/projects';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';

/** Names a new project. The library makes a folder of its own for it under `projects/`. */
export function NewProjectModal({
  t,
  close,
  created,
}: {
  t: T;
  close: () => void;
  created: (project: ProjectSummary) => void;
}) {
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ready = !!name.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      created(await api<ProjectSummary>('/projects', 'POST', { name }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.newProject}
      close={() => !busy && close()}
      closeLabel={t.cancel}
      className="new-project-modal"
    >
      <form className="new-project" onSubmit={(e) => void submit(e)}>
        <label>
          <span>{t.projectName}</span>
          <input
            autoFocus
            value={name}
            maxLength={120}
            placeholder={t.projectNamePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="muted">{t.newProjectFolderHint}</p>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="home-delete-actions">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? t.creatingProject : t.createProject}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
