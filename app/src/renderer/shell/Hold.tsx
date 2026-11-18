// The box of a part that is absent (UI redesign spec 3.0; docs/harness/
// agent-rules.md, "UI fidelity"): nothing in it, no role, no focus, no
// data-part id, hidden from assistive technology. shell.css sizes it, by a
// --hold-<part> token while the part is pending, or by the size the shared
// rules give the part when it has landed but is absent at runtime.

export function Hold({ className }: { className: string }) {
  return <span className={className} aria-hidden="true" />;
}
