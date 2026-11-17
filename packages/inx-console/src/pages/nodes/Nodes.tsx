import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, errorMessage, type Node } from '../../api';
import { Button, ErrorText, Field, Modal, SecondaryButton } from '../../ui';
import { machinesQuery } from '../machines/Machines';
import { ImportNodes } from './ImportNodes';
import { inboundLabel, NodeStatus } from './NodeStatus';

export const nodesQuery = { queryKey: ['nodes'], queryFn: () => api<{ nodes: Node[] }>('/nodes').then(r => r.nodes) };

export function Nodes() {
  const nodes = useQuery(nodesQuery);
  const machines = useQuery(machinesQuery);
  const [machineFilter, setMachineFilter] = useState<number | 'all'>('all');
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<Node | null>(null);
  const [deleting, setDeleting] = useState<Node | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    void queryClient.invalidateQueries({ queryKey: ['machine'] });
  };
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api('/nodes/' + id, { method: 'PATCH', body: { name } }),
    onSuccess: () => {
      refresh();
      setRenaming(null);
    }
  });
  const remove = useMutation({
    mutationFn: (id: number) => api('/nodes/' + id, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      setDeleting(null);
    }
  });

  const shown = nodes.data?.filter(n => machineFilter === 'all' || n.machineId === machineFilter) ?? [];

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">节点</h1>
        <div className="flex items-center gap-2">
          {(machines.data?.length ?? 0) > 1 && (
            <select
              aria-label="按机器筛选"
              className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              value={machineFilter}
              onChange={e => setMachineFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">全部机器</option>
              {machines.data!.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <Button className="h-9" onClick={() => setImporting(true)}>
            导入节点
          </Button>
        </div>
      </div>

      {nodes.isPending ? null : nodes.isError ? (
        <ErrorText>{errorMessage(nodes.error)}</ErrorText>
      ) : shown.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
          <p className="font-medium">还没有节点</p>
          <p className="mx-auto max-w-md text-sm text-zinc-500">节点是某台机器上某个入站的一个客户端。点击「导入节点」，从已添加的机器里选择要分发的客户端。</p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {shown.map(node => (
            <li key={node.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{node.name}</span>
                  <NodeStatus node={node} />
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  {node.machineName}
                  {node.machineStatus === 'error' && ' (最近检查失败，使用上次同步的数据)'} · {inboundLabel(node)} · {node.clientEmail}
                </div>
              </div>
              <span className="shrink-0 text-sm text-zinc-500">{node.subscriptionCount} 个订阅</span>
              <div className="flex shrink-0 gap-2">
                <SecondaryButton className="h-8" onClick={() => setRenaming(node)}>
                  重命名
                </SecondaryButton>
                <SecondaryButton className="h-8" variant="danger" onClick={() => setDeleting(node)}>
                  删除
                </SecondaryButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={importing} title="导入节点" onClose={() => setImporting(false)}>
        <ImportNodes initialMachineId={machineFilter === 'all' ? undefined : machineFilter} onDone={() => setImporting(false)} />
      </Modal>
      <Modal
        open={renaming !== null}
        title="重命名节点"
        onClose={() => {
          setRenaming(null);
          rename.reset();
        }}>
        {renaming && (
          <NameForm
            initial={renaming.name}
            hint="订阅中显示的节点名称。修改后，设备刷新订阅即可看到新名称。"
            pending={rename.isPending}
            error={rename.isError ? errorMessage(rename.error) : null}
            onSubmit={name => rename.mutate({ id: renaming.id, name })}
            onCancel={() => setRenaming(null)}
          />
        )}
      </Modal>
      <Modal
        open={deleting !== null}
        title={`删除节点「${deleting?.name ?? ''}」？`}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{deleting?.subscriptionCount ? `它会从 ${deleting.subscriptionCount} 个订阅中移除。` : '它没有被任何订阅使用。'}3x-ui 中的入站和客户端不受影响，之后可以重新导入。</p>
        <ErrorText>{remove.isError ? errorMessage(remove.error) : null}</ErrorText>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={() => setDeleting(null)} disabled={remove.isPending}>
            取消
          </SecondaryButton>
          <SecondaryButton variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
            删除
          </SecondaryButton>
        </div>
      </Modal>
    </section>
  );
}

export function NameForm({
  initial,
  hint,
  pending,
  error,
  submitLabel = '保存',
  onSubmit,
  onCancel
}: {
  initial: string;
  hint?: string;
  pending: boolean;
  error: string | null;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field label="名称" required autoFocus maxLength={64} value={name} onChange={e => setName(e.target.value)} hint={hint} />
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={pending}>
          取消
        </SecondaryButton>
        <Button type="submit" className="h-9" disabled={pending || !name.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
