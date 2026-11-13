// engine.capabilities (UI redesign spec 3.0). Placeholder: the selector
// arrives with the feature commit.

export interface Capabilities {
  readonly methods?: readonly string[];
  readonly features?: Readonly<Record<string, unknown>>;
  readonly commands?: readonly string[];
  readonly [field: string]: unknown;
}

export interface CapabilitySelector {
  has(method: string): boolean;
  feature(name: string): boolean;
}

export function capabilitySelector(_capabilities: Capabilities | null): CapabilitySelector {
  throw new Error('not implemented');
}
