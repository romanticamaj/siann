// What the engine can do (UI redesign spec 3.0): engine.capabilities lists
// its methods, commands and features. The rule: a control whose method or
// feature is not listed is not rendered at all; while the capabilities are
// unknown (no answer yet on any connection) nothing that needs one is drawn.
// The session client keeps the last answer across reconnects.

export interface Capabilities {
  readonly methods?: readonly string[];
  readonly features?: Readonly<Record<string, unknown>>;
  readonly commands?: readonly string[];
  readonly [field: string]: unknown;
}

export interface CapabilitySelector {
  // The method is in engine.capabilities' methods.
  has(method: string): boolean;
  // The feature is present and not false (true, or an object such as plugins').
  feature(name: string): boolean;
}

export function capabilitySelector(capabilities: Capabilities | null): CapabilitySelector {
  const methods = new Set(Array.isArray(capabilities?.methods) ? capabilities.methods : []);
  const features = capabilities?.features ?? {};
  return {
    has: (method) => methods.has(method),
    feature: (name) => {
      const value = Object.prototype.hasOwnProperty.call(features, name) ? features[name] : undefined;
      return value !== undefined && value !== null && value !== false;
    },
  };
}

export function isCapabilities(value: unknown): value is Capabilities {
  return value !== null && typeof value === 'object' && Array.isArray((value as Capabilities).methods);
}
