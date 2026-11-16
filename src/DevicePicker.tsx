import { CaretDown } from '@phosphor-icons/react';

export default function DevicePicker({ kind, devices, value, disabled, onChange }: {
  kind: 'mic' | 'camera';
  devices: MediaDeviceInfo[];
  value: string;
  disabled: boolean;
  onChange: (deviceId: string) => void;
}) {
  const label = kind === 'mic' ? 'Microphone' : 'Camera';
  const inputs = devices.filter(device => device.kind === (kind === 'mic' ? 'audioinput' : 'videoinput') && device.deviceId);
  const selected = inputs.some(device => device.deviceId === value) ? value : '';
  return <label className={`device-picker${disabled || !inputs.length ? ' unavailable' : ''}`} title={`Select ${label.toLowerCase()} source`}>
    <CaretDown size={14} aria-hidden="true" />
    <select aria-label={`${label} source`} value={selected} disabled={disabled || !inputs.length} onChange={event => onChange(event.target.value)}>
      <option value="" disabled>{inputs.length ? `Select ${label.toLowerCase()}` : `No ${label.toLowerCase()} available`}</option>
      {inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}
    </select>
  </label>;
}
