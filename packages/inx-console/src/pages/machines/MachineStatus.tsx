import { errorLabel, type Machine } from '../../api';
import { Badge } from '../../ui';

export function MachineStatus({ machine }: { machine: Machine }) {
  if (machine.status === 'online')
    return (
      <Badge tone="green">
        <span className="size-1.5 rounded-full bg-current" />
        在线
      </Badge>
    );
  const label = errorLabel(machine.lastError ?? '');
  return (
    <Badge tone={label === '离线' ? 'zinc' : label === '面板异常' ? 'amber' : 'red'}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
