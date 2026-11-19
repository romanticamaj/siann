// The "ask the agent" box at the foot of the Plans tab (m5b-ui-composer; UI
// redesign 4.4, 3.0; mockup.html's .composer, styled by ui/right-zone.css):
//
//   div.composer[composer]  svg.i (the spark icon), span (the text: the app's
//                           textarea, the one element added to the mockup's
//                           markup), span.send > svg.i.s (the send control)
//
// It hands a request to the agent the agent row shows (model/agents.ts,
// shownAgent): agent.request with the text and the selected track and clip
// ids. Enter sends, Shift+Enter breaks the line, and an Enter that confirms an
// input-method composition does nothing (composer-keys.ts). With no agent
// connected the textarea is disabled and the wrapper's tooltip gives the
// reason (3.0). A refused text (agent_busy, agent_not_connected,
// invalid_request_text, or one over limits.agentRequestTextChars) stays in the
// box, its reason on a line above it.
//
// RequestRows are the app's own rows above the box (the mockup does not draw
// them; shell.css): every open request with its state and a cancel control,
// under them the most recently closed one with the agent's message and a
// dismiss control (model/request-store.ts), then the refusal line.
//
// ComposerView and RequestRows are pure (static-markup tests); useComposer
// holds the text and the refusal and sends.

import { useContext, useRef, useState, type KeyboardEvent } from 'react';

import { refusalLine } from '../i18n/errors';
import { useLocale, useT } from '../i18n/t';
import type { Agent } from '../model/agents';
import type { RequestStore } from '../model/request-store';
import { isOpen, requestStateKey } from '../model/request-store';
import type { AgentRequest, AgentRequestSelection, SessionClient } from '../model/session-client';
import { CapabilitiesContext } from '../shell/Capable';
import { Icon } from '../shell/icons';
import { checkText, composerKey } from './composer-keys';
import { ISOLATE } from './isolate';
import { refusalOf, type Refusal } from './RefusalLine';

// limits.agentRequestTextChars when the engine does not say (protocol-engine-v0.md).
export const DEFAULT_TEXT_CHARS = 4000;

export interface ComposerViewProps {
  // The agent the row shows; the box is enabled only while it is connected.
  readonly agent: Agent | null;
  readonly text: string;
  readonly refusal: Refusal | null;
  readonly onText: (text: string) => void;
  readonly onSend: () => void;
}

export function ComposerView({ agent, text, refusal, onText, onSend }: ComposerViewProps) {
  const t = useT();
  const enabled = agent !== null && agent.connected;
  const placeholder = agent !== null ? t('composer.placeholder', { agent: agent.name }) : t('composer.placeholderNone');
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const what = composerKey({ key: event.key, code: event.code, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode });
    if (what !== 'send') return;
    event.preventDefault();
    onSend();
  };
  const onSendKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (enabled) onSend();
  };
  return (
    <div className="composer" data-part="composer" data-testid="composer" title={enabled ? undefined : t('composer.noAgent')}>
      <Icon name="spark" />
      <span>
        <textarea
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={t('composer.label')}
          aria-invalid={refusal !== null ? true : undefined}
          disabled={!enabled}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </span>
      <span
        className="send"
        role="button"
        tabIndex={enabled ? 0 : -1}
        aria-label={t('composer.send')}
        title={t('composer.send')}
        aria-disabled={enabled ? undefined : true}
        data-testid="composer-send"
        onClick={() => {
          if (enabled) onSend();
        }}
        onKeyDown={onSendKey}
      >
        <Icon name="send" small />
      </span>
    </div>
  );
}

export interface RequestRowsProps {
  readonly open: readonly AgentRequest[];
  readonly closed: AgentRequest | null;
  readonly refusal: Refusal | null;
  readonly onCancel: (request: string) => void;
  readonly onDismiss: () => void;
}

export function RequestRows({ open, closed, refusal, onCancel, onDismiss }: RequestRowsProps) {
  const t = useT();
  const locale = useLocale();
  const shown = closed ? [...open, closed] : open;
  return (
    <>
      {shown.length > 0 ? (
        <div className="requests" role="list" aria-label={t('composer.requests')} data-testid="agent-requests">
          {shown.map((request) => {
            const live = isOpen(request.state);
            const message = !live && typeof request.message === 'string' && request.message !== '' ? request.message : null;
            return (
              <div key={request.id} className="request" role="listitem" data-testid={`request-${request.id}`} data-state={request.state}>
                <span className="request-text" {...ISOLATE} title={request.text}>
                  {request.text}
                </span>
                <span className="request-state">{t(requestStateKey(request.state))}</span>
                {live ? (
                  <button type="button" className="request-cancel" data-testid="request-cancel" aria-label={t('composer.cancel')} title={t('composer.cancel')} onClick={() => onCancel(request.id)}>
                    <Icon name="x" small />
                  </button>
                ) : (
                  <button type="button" className="request-dismiss" data-testid="request-dismiss" aria-label={t('composer.dismiss')} title={t('composer.dismiss')} onClick={onDismiss}>
                    <Icon name="x" small />
                  </button>
                )}
                {message !== null ? (
                  <span className="request-message" {...ISOLATE}>
                    {message}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {refusal ? (
        <div className="composer-refusal" role="status" data-testid="composer-refusal" data-code={refusal.code ?? undefined}>
          {refusalLine(refusal.code, refusal.code === null ? refusal.message : '', locale)}
        </div>
      ) : null}
    </>
  );
}

export interface ComposerState {
  readonly text: string;
  readonly refusal: Refusal | null;
  readonly setText: (text: string) => void;
  readonly send: () => void;
  readonly cancel: (request: string) => void;
  readonly dismiss: () => void;
}

const TOO_LONG: Refusal = { code: 'invalid_request_text', message: '', changedEntities: [] };

// The box's text and refusal, and its sends: agent.request to `agent` with
// `selection`; on success the text clears (unless it was edited meanwhile)
// and the request joins the store; a refusal keeps the text.
export function useComposer(client: SessionClient, store: RequestStore | undefined, agent: Agent | null, selection: AgentRequestSelection | undefined): ComposerState {
  const [text, setTextState] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const busy = useRef(false);
  const limits = useContext(CapabilitiesContext)?.limits;
  const limit = typeof limits?.agentRequestTextChars === 'number' ? limits.agentRequestTextChars : DEFAULT_TEXT_CHARS;
  const setText = (next: string) => {
    setTextState(next);
    setRefusal(null);
  };
  const send = () => {
    if (busy.current || agent === null || !agent.connected) return;
    const checked = checkText(text, limit);
    if (!checked.ok) {
      if (checked.reason === 'too_long') setRefusal(TOO_LONG);
      return;
    }
    const sent = checked.text;
    busy.current = true;
    void client.agentRequest(agent.id, sent, selection).then(
      (request) => {
        busy.current = false;
        setTextState((current) => (current === sent ? '' : current));
        setRefusal(null);
        store?.sent(request);
      },
      (error: unknown) => {
        busy.current = false;
        setRefusal(refusalOf(error));
      },
    );
  };
  const cancel = (request: string) => {
    void client.cancelAgentRequest(request).then(
      (answer) => store?.change(answer),
      (error: unknown) => setRefusal(refusalOf(error)),
    );
  };
  return { text, refusal, setText, send, cancel, dismiss: () => store?.dismiss() };
}
