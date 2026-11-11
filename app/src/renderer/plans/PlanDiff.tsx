// The diff of a plan against the current revision (m5-plan-review): one row
// per entity of the engine's plan.preview answer, before and after side by
// side, the changed fields named, and the entities plan.status reports stale
// marked. The rows are computed by plans/diff.ts; nothing here runs commands.

import type { StaleRef } from '../model/plan-store';
import { diffRows, formatValue, type PlanPreview } from './diff';

export interface PlanDiffProps {
  readonly preview: PlanPreview;
  readonly stale: readonly StaleRef[];
}

function entityText(entity: Record<string, unknown> | null): string {
  return entity === null ? '—' : JSON.stringify(entity);
}

export function PlanDiff({ preview, stale }: PlanDiffProps) {
  const rows = diffRows(preview, stale);
  return (
    <table className="plan-diff" data-testid="plan-diff" data-revision={preview.revision}>
      <thead>
        <tr>
          <th>Entity</th>
          <th>Change</th>
          <th>Fields</th>
          <th>Before</th>
          <th>After</th>
          <th>Stale</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.ref} data-testid={`diff-${row.ref}`} data-kind={row.kind} data-stale={row.stale ? 'true' : 'false'}>
            <td>{row.ref}</td>
            <td>{row.kind}</td>
            <td data-testid="diff-fields">
              {row.changes.map((c) => `${c.field}: ${formatValue(c.before)} → ${formatValue(c.after)}`).join('; ')}
            </td>
            <td data-testid="diff-before">
              <code>{entityText(row.before)}</code>
            </td>
            <td data-testid="diff-after">
              <code>{entityText(row.after)}</code>
            </td>
            <td data-testid="diff-stale">{row.stale ? `stale (${row.staleChange ?? 'modified'})` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
