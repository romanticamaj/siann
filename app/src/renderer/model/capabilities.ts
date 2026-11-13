// What the engine can do (UI redesign spec 3.0): engine.capabilities lists
// its methods, commands and features. The rule: a control whose method or
// feature is not listed is not rendered at all, and a control that sends a
// command through command.execute needs that command in `commands` too; while the capabilities are
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
  // command.execute is listed and the command is in engine.capabilities' commands.
  command(name: string): boolean;
}

export function capabilitySelector(capabilities: Capabilities | null): CapabilitySelector {
  const methods = new Set(Array.isArray(capabilities?.methods) ? capabilities.methods : []);
  const features = capabilities?.features ?? {};
  const commands = new Set(Array.isArray(capabilities?.commands) ? capabilities.commands : []);
  return {
    has: (method) => methods.has(method),
    feature: (name) => {
      const value = Object.prototype.hasOwnProperty.call(features, name) ? features[name] : undefined;
      return value !== undefined && value !== null && value !== false;
    },
    command: (name) => methods.has('command.execute') && commands.has(name),
  };
}

export function isCapabilities(value: unknown): value is Capabilities {
  return value !== null && typeof value === 'object' && Array.isArray((value as Capabilities).methods);
}
