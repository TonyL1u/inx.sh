import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, errorMessage, type Machine, type MachineDetail } from '../../api';
import { Button, ErrorText, fullTime, Modal, timeAgo } from '../../ui';
import { MachineStatus } from './MachineStatus';
import { PairForm } from './PairForm';

export const machinesQuery = { queryKey: ['machines'], queryFn: () => api<{ machines: Machine[] }>('/machines').then(r => r.machines), refetchInterval: 60_000 };

export function Machines() {
  const machines = useQuery(machinesQuery);
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const add = useMutation({
    mutationFn: ({ pairCode, name }: { pairCode: string; name: string }) => api<MachineDetail & { repaired: boolean }>('/machines', { body: { pairCode, ...(name ? { name } : {}) } }),
    onSuccess: async result => {
      queryClient.setQueryData(['machine', result.machine.id], { machine: result.machine, inbounds: result.inbounds });
      await queryClient.invalidateQueries({ queryKey: ['machines'] });
      setAdding(false);
      void navigate('/machines/' + result.machine.id);
    }
  });
  const close = () => {
    setAdding(false);
    add.reset();
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">机器</h1>
        <Button className="h-9" onClick={() => setAdding(true)}>
          添加 VPS
        </Button>
      </div>

      {machines.isPending ? null : machines.isError ? (
        <ErrorText>{errorMessage(machines.error)}</ErrorText>
      ) : machines.data.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
          <p className="font-medium">还没有机器</p>
          <p className="mx-auto max-w-md text-sm text-zinc-500">
            在 VPS 上运行 <code className="font-mono">curl -fsSL https://inx.sh/bootstrap | sudo bash</code>，复制输出的配对码，然后点击「添加 VPS」。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {machines.data.map(m => (
            <li key={m.id}>
              <Link to={'/machines/' + m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.name}</span>
                    <MachineStatus machine={m} />
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">{m.endpoint.replace('https://', '')}</div>
                </div>
                <div className="flex shrink-0 gap-6 text-sm text-zinc-500">
                  <span>{m.inboundCount} 个入站</span>
                  <span className="w-20 text-right" title={'最近同步：' + fullTime(m.syncedAt)}>
                    {timeAgo(m.syncedAt)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Modal open={adding} title="添加 VPS" onClose={close}>
        <PairForm withName submitLabel="验证并添加" pending={add.isPending} error={add.isError ? errorMessage(add.error) : null} onSubmit={(pairCode, name) => add.mutate({ pairCode, name })} onCancel={close} />
      </Modal>
    </section>
  );
}
