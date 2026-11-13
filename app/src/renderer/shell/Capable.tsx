// The capability rule of UI redesign spec 3.0 as a wrapper: <Capable
// method="plan.approve"> renders its children only when engine.capabilities
// lists the method (or, with `feature`, the feature), and nothing at all
// otherwise, including while the capabilities are unknown. No placeholder,
// no reserved space. App provides the session client's last known value.

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { capabilitySelector, type Capabilities, type CapabilitySelector } from '../model/capabilities';

export const CapabilitiesContext = createContext<Capabilities | null>(null);

export function useCapabilities(): CapabilitySelector {
  const capabilities = useContext(CapabilitiesContext);
  return useMemo(() => capabilitySelector(capabilities), [capabilities]);
}

export function Capable({ method, feature, children }: { method: string; feature?: string; children: ReactNode }) {
  const can = useCapabilities();
  if (!can.has(method) || (feature !== undefined && !can.feature(feature))) return null;
  return <>{children}</>;
}
