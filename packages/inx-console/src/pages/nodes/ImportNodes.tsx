import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, errorMessage, type MachineDetail, type Node } from '../../api';
import { Badge, ErrorText, SecondaryButton } from '../../ui';
import { machinesQuery } from '../machines/Machines';

// Pick a machine, then one client of one of its inbounds. Each imported client becomes a node.
export function ImportNodes({ initialMachineId, onDone }: { initialMachineId?: number; onDone: () => void }) {
  const machines = useQuery(machinesQuery);
  const [machineId, setMachineId] = useState<number | undefined>(initialMachineId);
  const selected = machineId ?? machines.data?.[0]?.id;
  const detail = useQuery({ queryKey: ['machine', selected], queryFn: () => api<MachineDetail>('/machines/' + selected), enabled: selected !== undefined });
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (body: { machineId: number; inboundId: number; clientEmail: string }) => api<{ node: Node }>('/nodes', { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['nodes'] });
      void queryClient.invalidateQueries({ queryKey: ['machine', selected] });
    }
  });

  if (machines.isPending) return null;
  if (!machines.data?.length) return <p className="text-sm text-zinc-500">还没有机器。请先在「机器」页添加 VPS。</p>;

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">机器</span>
        <select
          className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          value={selected}
          onChange={e => {
            setMachineId(Number(e.target.value));
            create.reset();
          }}>
          {machines.data.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <ErrorText>{create.isError ? errorMessage(create.error) : detail.isError ? errorMessage(detail.error) : null}</ErrorText>

      <div className="max-h-[50vh] space-y-3 overflow-y-auto">
        {detail.data?.inbounds.length === 0 && <p className="text-sm text-zinc-500">这台机器还没有入站。</p>}
        {detail.data?.inbounds.map(inbound => (
          <div key={inbound.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
              <span className="truncate font-medium">{inbound.remark || '#' + inbound.id}</span>
              <span className="shrink-0 font-mono text-xs text-zinc-500 uppercase">
                {inbound.protocol} {inbound.port}
                {!inbound.enabled && ' · 已停用'}
              </span>
            </div>
            {inbound.clients === null ? (
              <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300">gateway 版本过旧，无法列出客户端。请升级 gateway 后同步。</p>
            ) : inbound.clients.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-500">没有客户端。</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {inbound.clients.map(client => (
                  <li key={client.email} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{client.email}</span>
                    {!client.enabled && <Badge tone="zinc">已停用</Badge>}
                    {client.unsupported && <Badge tone="amber">不支持</Badge>}
                    {client.nodeId !== null ? (
                      <Badge tone="green">已导入</Badge>
                    ) : (
                      <SecondaryButton className="h-7 px-2 text-xs" disabled={create.isPending} onClick={() => create.mutate({ machineId: selected!, inboundId: inbound.id, clientEmail: client.email })}>
                        导入
                      </SecondaryButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <SecondaryButton onClick={onDone}>完成</SecondaryButton>
      </div>
    </div>
  );
}
