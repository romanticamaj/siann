// The agent row at the top of the Plans tab (m5b-ui-plan-metadata; UI
// redesign 4.4; mockup.html's .agent, styled by ui/right-zone.css):
//
//   .agent[agent-row]  .av (the spark icon), span (b the agent's name, " · MCP"),
//                      .live (i, the dot; "connected · idle" or the last tool)
//
// The agent shown is model/agents.ts's shownAgent(). A disconnected agent's
// .live carries the app-only modifier .off (shell.css: the dot without the
// play colour); with no agent listed the row reads "No agent connected" and
// has no name. The time of the last action is .live's tooltip. The name is
// the agent's own text, so it is bidi-isolated; the row is one line, and a
// long name ellipsises (shell.css).

import { useT } from '../i18n/t';
import { agentRow, type Agent } from '../model/agents';
import { Icon } from '../shell/icons';
import { ISOLATE } from './isolate';

export function AgentRow({ agent }: { agent: Agent | null }) {
  const t = useT();
  const row = agentRow(agent, t);
  return (
    <div className="agent" data-part="agent-row" data-testid="agent-row" data-state={row.state}>
      <span className="av">
        <Icon name="spark" small />
      </span>
      {row.state === 'none' ? (
        <span>{row.text}</span>
      ) : (
        <>
          <span>
            <b {...ISOLATE} title={row.name ?? undefined}>
              {row.name}
            </b>
            {` · ${row.transport}`}
          </span>
          <span className={row.state === 'disconnected' ? 'live off' : 'live'} title={row.title ?? undefined}>
            <i />
            {row.text}
          </span>
        </>
      )}
    </div>
  );
}
