// Studio Setup (m5b-ui-project; UI redesign UR-4): the device dialog, opened
// from the Studio menu (studio.setup) or by a transport button disabled for
// want of a device. A modal <dialog> on the About panel's chrome (shell.css):
// the devices of engine.devices with their input and output channel counts,
// the output and input lists engine.select_device takes, and the running
// device's sample rate, buffer, input and output latency and whether
// device-side SRC is active, from engine.status (model/studio-setup.ts). Its
// own keydown handler keeps every key from the shell's dispatcher, as the
// About panel's and ConfirmDialog's do; Escape closes it. Absent on an engine
// that does not list engine.devices and engine.select_device (spec 3.0). The
// mockup has no Studio Setup: its markup is the app's, styled from existing
// tokens.

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import { useT } from '../i18n/t';
import type { EngineStatusSource } from '../model/engine-status';
import { initialOutput, setupFields, studioSetupAvailable, type StudioSetupController } from '../model/studio-setup';
import { useCapabilities } from './Capable';

export interface StudioSetupProps {
  readonly open: boolean;
  readonly controller: StudioSetupController;
  readonly engineStatus: EngineStatusSource;
  // The session's sample rate (root.sampleRate), for the SRC state.
  readonly sessionRate: number | null;
  readonly onClose: () => void;
}

export function StudioSetup(props: StudioSetupProps) {
  const can = useCapabilities();
  if (!studioSetupAvailable(can)) return null;
  return <StudioSetupDialog {...props} />;
}

function StudioSetupDialog({ open, controller, engineStatus, sessionRate, onClose }: StudioSetupProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement | null>(null);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const status = useSyncExternalStore(
    (listener) => engineStatus.subscribe(listener),
    () => engineStatus.getSnapshot(),
    () => engineStatus.getSnapshot(),
  );
  // What the output list shows before the user picks, and so what Apply takes.
  const current = initialOutput(view.devices);
  const currentInput = status?.device?.input?.id ?? '';
  // The lists' choices, until the user picks; then the engine's again after a selection.
  const [output, setOutput] = useState<string | null>(null);
  const [input, setInput] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setOutput(null);
      setInput(null);
      void controller.load();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, controller]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  const outputs = view.devices.filter((device) => device.outputChannels !== 0);
  const inputs = view.devices.filter((device) => device.inputChannels !== 0);
  const chosenOutput = output ?? current;
  const chosenInput = input ?? currentInput;
  const fields = setupFields(status, sessionRate, t);
  const channels = (value: number | null) => (value === null ? t('setup.unknown') : String(value));
  const apply = () => {
    if (!chosenOutput) return;
    void controller.select(chosenOutput, chosenInput === '' ? null : chosenInput).then(() => {
      setOutput(null);
      setInput(null);
    });
  };
  return (
    <dialog
      ref={ref}
      className="studio-setup"
      data-testid="studio-setup"
      aria-labelledby="studio-setup-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <h2 id="studio-setup-title">{t('setup.title')}</h2>
      <table className="setup-devices" aria-label={t('setup.devices')}>
        <thead>
          <tr>
            <th scope="col">{t('setup.device')}</th>
            <th scope="col">{t('setup.type')}</th>
            <th scope="col">{t('setup.inputs')}</th>
            <th scope="col">{t('setup.outputs')}</th>
          </tr>
        </thead>
        <tbody>
          {view.devices.map((device) => (
            <tr key={device.id} data-testid={`setup-device-${device.id}`} data-current={device.current ? 'true' : undefined}>
              <td title={device.id}>
                {device.name}
                {device.current ? <span className="setup-current">{t('setup.current')}</span> : null}
              </td>
              <td>{device.type}</td>
              <td className="num" data-testid="setup-inputs">
                {channels(device.inputChannels)}
              </td>
              <td className="num" data-testid="setup-outputs">
                {channels(device.outputChannels)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="setup-choice">
        <label>
          <span>{t('setup.output')}</span>
          <select data-testid="setup-output" value={chosenOutput} onChange={(event) => setOutput(event.target.value)}>
            {outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('setup.input')}</span>
          <select data-testid="setup-input" value={chosenInput} onChange={(event) => setInput(event.target.value)}>
            <option value="">{t('setup.noInput')}</option>
            {inputs.map((device) => (
              <option key={device.id} value={device.id}>
                {device.id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="setup-apply" disabled={view.busy || !chosenOutput} onClick={apply}>
          {t('setup.apply')}
        </button>
      </div>
      {view.error !== null ? (
        <p className="setup-error" data-testid="setup-error" role="alert">
          {view.error}
        </p>
      ) : null}
      <h3>{t('setup.status')}</h3>
      {fields ? (
        <dl className="about-diagnostics">
          <dt>{t('setup.sampleRate')}</dt>
          <dd data-testid="setup-rate">{fields.sampleRate}</dd>
          <dt>{t('setup.buffer')}</dt>
          <dd data-testid="setup-buffer">{fields.buffer}</dd>
          <dt>{t('setup.inputLatency')}</dt>
          <dd data-testid="setup-input-latency">{fields.inputLatency}</dd>
          <dt>{t('setup.outputLatency')}</dt>
          <dd data-testid="setup-output-latency">{fields.outputLatency}</dd>
          <dt>{t('setup.src')}</dt>
          <dd data-testid="setup-src">{fields.src === null ? t('setup.srcUnknown') : t(fields.src ? 'setup.srcActive' : 'setup.srcInactive')}</dd>
        </dl>
      ) : (
        <p className="setup-none" data-testid="setup-no-device">
          {status?.deviceError ? `${status.deviceError.code}: ${t('setup.noDevice')}` : t('setup.noDevice')}
        </p>
      )}
      <div className="confirm-dialog-buttons">
        <button type="button" data-testid="setup-close" onClick={onClose}>
          {t('setup.close')}
        </button>
      </div>
    </dialog>
  );
}
