// Commit counting per subtree (UI redesign spec 5.6; m5-ui-transport). A
// <Counted id> is a <Profiler> whose commits index.tsx adds up in
// window.__siannCommitsBy[id] once it installed a sink (SIANN_SHELL_TEST=1).
// Only the profiling bundle calls onRender, so in production the wrapper
// counts nothing. The e2e tests count the transport bar and the timeline on
// their own: the status bar commits whenever engine.status answers
// differently (the xrun count), which the root count would include.

import { Profiler, type ReactNode } from 'react';

let sink: ((id: string) => void) | null = null;

export function setCommitSink(next: ((id: string) => void) | null): void {
  sink = next;
}

const onRender = (id: string) => {
  sink?.(id);
};

export function Counted({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
