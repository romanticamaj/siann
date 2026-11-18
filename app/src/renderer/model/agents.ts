// The agents the engine knows (m5b-ui-plan-metadata; UI redesign 4.4; E-14,
// docs/schemas/protocol-engine-v0.md "engine.status" `agents`, and
// protocol-events-v1.md `agent.changed`): every MCP session is an agent, kept
// listed after it disconnects. Framework-free: React reads the store through
// useSyncExternalStore. attach() reads engine.status once per connection when
// engine.capabilities lists features.agents (and engine.status), then follows
// agent.changed, which upserts an agent by its id. Nothing is kept while the
// engine is away, and nothing is requested without the feature.
//
// shownAgent() is the one the agent row shows, and the "ask the agent" box
// (m5b-ui-composer) addresses: the connected agent with the newest
// lastActionAt; with none connected, the listed one with the newest
// lastActionAt (which reads "disconnected"); with none listed, none.

import type { T } from '../i18n/t';
import { en } from '../i18n/en';
import type { ClientState } from './session-client';

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly connected: boolean;
  // The name of the MCP tool last executed for it, null before its first call.
  readonly lastAction: string | null;
  // The server's ISO time of that call.
  readonly lastActionAt: string | null;
}

export interface AgentSnapshot {
  readonly agents: readonly Agent[];
}

const nullableText = (value: unknown): string | null | undefined => (value === null ? null : typeof value === 'string' ? value : undefined);

// One entry of engine.status agents or agent.changed's agent, or null.
export function parseAgent(value: unknown): Agent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.transport !== 'string' || typeof raw.connected !== 'boolean') return null;
  const lastAction = nullableText(raw.lastAction);
  const lastActionAt = nullableText(raw.lastActionAt);
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    transport: raw.transport,
    connected: raw.connected,
    lastAction: lastAction ?? null,
    lastActionAt: lastActionAt ?? null,
  });
}

// engine.status's agents, malformed entries dropped.
export function parseAgents(status: unknown): Agent[] {
  const list = (status as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list)) return [];
  return list.map(parseAgent).filter((a): a is Agent => a !== null);
}

// Newest lastActionAt first; an agent that never acted is the oldest, and a
// tie keeps the later listed (the newer session).
function newest(agents: readonly Agent[]): Agent | null {
  let best: Agent | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const agent of agents) {
    const parsed = agent.lastActionAt !== null ? Date.parse(agent.lastActionAt) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    if (best === null || at >= bestAt) {
      best = agent;
      bestAt = at;
    }
  }
  return best;
}

export function shownAgent(agents: readonly Agent[]): Agent | null {
  return newest(agents.filter((a) => a.connected)) ?? newest(agents);
}

// The last tool in user wording: a catalog entry per MCP tool, the generic
// one for a tool this build does not know.
export function toolWording(tool: string, t: T): string {
  if (!/^[a-z_]+$/.test(tool) || !Object.prototype.hasOwnProperty.call(en, `agent.tool.${tool}`)) return t('agent.tool.other');
  return t(`agent.tool.${tool}` as 'agent.tool.other');
}

export interface AgentRowText {
  readonly state: 'connected' | 'disconnected' | 'none';
  readonly name: string | null;
  readonly transport: string | null;
  // "connected · idle", "disconnected · submitted a plan", or "No agent connected".
  readonly text: string;
  // The time of the last action, for the tooltip.
  readonly title: string | null;
}

export function agentRow(agent: Agent | null, t: T): AgentRowText {
  if (agent === null) return { state: 'none', name: null, transport: null, text: t('agent.none'), title: null };
  const state = agent.connected ? 'connected' : 'disconnected';
  const action = agent.lastAction === null ? t('agent.idle') : toolWording(agent.lastAction, t);
  return {
    state,
    name: agent.name,
    transport: agent.transport === 'mcp' ? t('agent.transport.mcp') : agent.transport,
    text: `${t(state === 'connected' ? 'agent.connected' : 'agent.disconnected')} · ${action}`,
    title: agent.lastAction !== null && agent.lastActionAt !== null ? t('agent.lastActionAt', { time: agent.lastActionAt }) : null,
  };
}

// What attach() needs of the session client.
export interface AgentClient {
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  onEvent(type: string, listener: (event: Readonly<Record<string, unknown>>) => void): () => void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

const EMPTY: AgentSnapshot = Object.freeze({ agents: Object.freeze([]) });

function listed(state: ClientState): boolean {
  const capabilities = state.capabilities;
  const features = (capabilities?.features ?? {}) as Record<string, unknown>;
  const methods = Array.isArray(capabilities?.methods) ? capabilities.methods : [];
  const value = Object.prototype.hasOwnProperty.call(features, 'agents') ? features.agents : undefined;
  return state.status === 'connected' && value !== undefined && value !== null && value !== false && methods.includes('engine.status');
}

export class AgentStore {
  #snapshot: AgentSnapshot = EMPTY;
  readonly #listeners = new Set<() => void>();

  getSnapshot(): AgentSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // The agents of an engine.status answer, replacing every agent held.
  fromStatus(status: unknown): void {
    this.#set(Object.freeze({ agents: Object.freeze(parseAgents(status)) }));
  }

  // An agent.changed's agent: replaced by id, or added at the end.
  upsert(agent: Agent): void {
    const agents = [...this.#snapshot.agents];
    const at = agents.findIndex((a) => a.id === agent.id);
    if (at >= 0) agents[at] = agent;
    else agents.push(agent);
    this.#set(Object.freeze({ agents: Object.freeze(agents) }));
  }

  clear(): void {
    if (this.#snapshot.agents.length > 0) this.#set(EMPTY);
  }

  // Follows a session client until the returned function is called.
  attach(client: AgentClient): () => void {
    let detached = false;
    // The connection read (the client's connection count), or null.
    let reading: number | null = null;
    // Agents agent.changed reported while engine.status was in flight: they are newer than its answer.
    let during: Map<string, Agent> | null = null;
    const onState = () => {
      if (detached) return;
      const state = client.getState();
      if (!listed(state)) {
        reading = null;
        during = null;
        this.clear();
        return;
      }
      if (reading === state.connections) return;
      const connection = state.connections;
      reading = connection;
      during = new Map();
      client.request('engine.status', {}).then(
        (result) => {
          if (detached || reading !== connection) return;
          const newer = during ?? new Map<string, Agent>();
          during = null;
          this.fromStatus(result);
          for (const agent of newer.values()) this.upsert(agent);
        },
        () => {
          if (reading === connection) during = null;
        },
      );
    };
    const offs = [
      client.subscribe(onState),
      client.onEvent('agent.changed', (event) => {
        if (detached || !listed(client.getState())) return;
        const agent = parseAgent(event.agent);
        if (!agent) return;
        during?.set(agent.id, agent);
        this.upsert(agent);
      }),
    ];
    onState();
    return () => {
      detached = true;
      for (const off of offs) off();
    };
  }

  #set(next: AgentSnapshot): void {
    if (next === this.#snapshot) return;
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
