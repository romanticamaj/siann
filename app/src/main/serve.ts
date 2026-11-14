// Which file a siann://app request is served from (UI redesign spec 5.6): the
// profiling bundle, renderer.profiling.js (react-dom/profiling, whose
// <Profiler onRender> fires), stands in for renderer.js only under
// SIANN_SHELL_TEST=1 with SIANN_SHELL_PROFILING=1, for the e2e that counts
// React commits; without both flags it is not served at all. Every other
// path is served as asked.

export const RENDERER_BUNDLE = '/renderer.js';
export const PROFILING_BUNDLE = '/renderer.profiling.js';

// The path to read for a request path, or null when it must not be served.
export function rendererRequestPath(pathname: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const profiling = env.SIANN_SHELL_TEST === '1' && env.SIANN_SHELL_PROFILING === '1';
  if (pathname === PROFILING_BUNDLE) return profiling ? PROFILING_BUNDLE : null;
  if (pathname === RENDERER_BUNDLE && profiling) return PROFILING_BUNDLE;
  return pathname;
}
