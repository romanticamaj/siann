// The capability rule of UI redesign spec 3.0 as a wrapper: <Capable
// method="plan.approve"> renders its children only when engine.capabilities
// lists the method (and, with `feature`, the feature; with `command`, the
// command under command.execute), and nothing at all
// otherwise, including while the capabilities are unknown. No placeholder,
// no reserved space. App provides the session client's last known value.

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { capabilitySelector, type Capabilities, type CapabilitySelector } from '../model/capabilities';

export const CapabilitiesContext = createContext<Capabilities | null>(null);

export function useCapabilities(): CapabilitySelector {
  const capabilities = useContext(CapabilitiesContext);
  return useMemo(() => capabilitySelector(capabilities), [capabilities]);
}

export interface CapableProps {
  readonly method?: string;
  readonly feature?: string;
  readonly command?: string;
  readonly children: ReactNode;
}

export function Capable({ method, feature, command, children }: CapableProps) {
  const can = useCapabilities();
  if (method === undefined && feature === undefined && command === undefined) return null;
  if (method !== undefined && !can.has(method)) return null;
  if (feature !== undefined && !can.feature(feature)) return null;
  if (command !== undefined && !can.command(command)) return null;
  return <>{children}</>;
}
