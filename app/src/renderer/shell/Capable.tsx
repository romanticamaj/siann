// Capable. Placeholder: arrives with the feature commit.

import { createContext, type ReactNode } from 'react';

import type { Capabilities } from '../model/capabilities';

export const CapabilitiesContext = createContext<Capabilities | null>(null);

export function Capable({ children }: { method: string; children: ReactNode }) {
  return <>{children}</>;
}
