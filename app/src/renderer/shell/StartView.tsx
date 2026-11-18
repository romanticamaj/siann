// The start view (m5b-ui-project; UI redesign UR-4): over the zones when the
// shell has no bundle to start on (none recorded, or the last one gone) and
// launched the engine on its scratch bundle. New Project and Open (the
// shell's dialogs) and the recent list, each row the bundle's name over its
// path; it goes once New or Open succeeds. Everything here needs the shell,
// so without its port (a plain browser tab) the view is absent (spec 3.0),
// and each control needs its method too: New session.create, Open and the
// rows session.open. The mockup has no start view: its markup is the app's,
// styled in shell.css from existing tokens.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { ProjectController } from '../model/project';
import { useCapabilities } from './Capable';
import { ISOLATE } from '../plans/isolate';

export function StartView({ project }: { readonly project: ProjectController }) {
  const t = useT();
  const can = useCapabilities();
  const view = useSyncExternalStore(project.subscribe, project.getSnapshot, project.getSnapshot);
  if (!view.shell || !view.startView) return null;
  const canOpen = can.has('session.open');
  return (
    <div className="start-view" data-region="start-view" data-testid="start-view" role="region" aria-label={t('start.label')}>
      <div className="start-panel">
        <h2>{t('start.title')}</h2>
        <div className="start-actions">
          {can.has('session.create') ? (
            <button type="button" className="start-primary" data-testid="start-new" disabled={view.busy} onClick={() => void project.newProject()}>
              {t('menu.newProject')}
            </button>
          ) : null}
          {canOpen ? (
            <button type="button" data-testid="start-open" disabled={view.busy} onClick={() => void project.open()}>
              {t('menu.open')}
            </button>
          ) : null}
        </div>
        {canOpen ? (
          <>
            <h3>{t('start.recent')}</h3>
            {view.recent.length > 0 ? (
              <ul className="start-recent">
                {view.recent.map((entry, i) => (
                  <li key={entry.path}>
                    <button type="button" data-testid={`start-recent-${i + 1}`} title={entry.path} disabled={view.busy} onClick={() => void project.openPath(entry.path)}>
                      <b {...ISOLATE}>{entry.name}</b>
                      <span className="start-path" {...ISOLATE}>{entry.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="start-empty">{t('start.noRecent')}</p>
            )}
          </>
        ) : null}
        {view.error !== null ? (
          <p className="start-error" data-testid="start-error" role="alert">
            {view.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
