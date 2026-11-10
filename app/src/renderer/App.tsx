// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces arrive as imperative canvas classes
// (ADR-0019 point 3).

import type { SessionClient } from './model/session-client';
import { StatusPanel } from './StatusPanel';

export function App({ client }: { client: SessionClient }) {
  return (
    <>
      <h1>SIANN</h1>
      <StatusPanel client={client} />
    </>
  );
}
