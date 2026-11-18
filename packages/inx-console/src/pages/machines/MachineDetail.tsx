import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api, codeMessage, errorMessage, type MachineDetail as Detail } from '../../api';
import { Badge, Button, ErrorText, Field, fullTime, Modal, SecondaryButton, timeAgo } from '../../ui';
import { MachineStatus } from './MachineStatus';
import { PairForm } from './PairForm';

type Dialog = 'rename' | 'repair' | 'delete' | null;

export function MachineDetail() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const detail = useQuery({ queryKey: ['machine', id], queryFn: () => api<Detail>('/machines/' + id), enabled: Number.isSafeInteger(id) });

  const update = (data: Detail) => {
    queryClient.setQueryData(['machine', id], data);
    void queryClient.invalidateQueries({ queryKey: ['machines'] });
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
  };
  const sync = useMutation({ mutationFn: () => api<Detail>(`/machines/${id}/sync`, { method: 'POST' }), onSuccess: update });
  const patch = useMutation({
    mutationFn: (body: { name?: string; pairCode?: string }) => api<Detail>('/machines/' + id, { method: 'PATCH', body }),
    onSuccess: data => {
      update(data);
      close();
    }
  });
  const remove = useMutation({
    mutationFn: () => api('/machines/' + id, { method: 'DELETE' }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['machine', id] });
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      await queryClient.invalidateQueries({ queryKey: ['machines'] });
      void navigate('/machines', { replace: true });
    }
  });
  const close = () => {
    setDialog(null);
    patch.reset();
    remove.reset();
  };

  if (detail.isPending) return null;
  if (detail.isError)
    return (
      <section className="space-y-4">
        <BackLink />
        <ErrorText>{errorMessage(detail.error)}</ErrorText>
      </section>
    );

  const { machine, inbounds } = detail.data;
  const clientCount = inbounds.reduce((n, ib) => n + (ib.clients?.length ?? 0), 0);
  return (
    <section className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-semibold">{machine.name}</h1>
            <MachineStatus machine={machine} />
          </div>
          <p className="font-mono text-sm text-zinc-500">{machine.endpoint.replace('https://', '')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? '正在同步…' : '立即同步'}
          </SecondaryButton>
          <SecondaryButton onClick={() => setDialog('rename')}>重命名</SecondaryButton>
          <SecondaryButton onClick={() => setDialog('repair')}>重新配对</SecondaryButton>
          <SecondaryButton variant="danger" onClick={() => setDialog('delete')}>
            删除
          </SecondaryButton>
        </div>
      </div>

      {machine.lastError && (
        <div role="alert" className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">
            {timeAgo(machine.checkedAt)}检查失败：{codeMessage(machine.lastError)}
          </p>
          <p className="text-amber-800/80 dark:text-amber-200/70">下面显示的是 {fullTime(machine.syncedAt)} 最近一次成功同步的入站。</p>
        </div>
      )}
      <ErrorText>{sync.isError ? errorMessage(sync.error) : null}</ErrorText>

      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-zinc-200 bg-white p-4 text-sm sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-900">
        <Stat label="Gateway 版本" value={machine.gatewayVersion} />
        <Stat label="最近同步" value={timeAgo(machine.syncedAt)} title={fullTime(machine.syncedAt)} />
        <Stat label="最近检查" value={timeAgo(machine.checkedAt)} title={fullTime(machine.checkedAt)} />
        <Stat label="添加时间" value={new Date(machine.createdAt).toLocaleDateString('zh-CN')} />
      </dl>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold">客户端</h2>
          {clientCount > 0 && (
            <Link to="/subscriptions/new" className="text-sm font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100">
              用这些客户端创建订阅 →
            </Link>
          )}
        </div>
        {inbounds.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">这台机器的 3x-ui 还没有入站。在 VPS 上运行 sudo x-ui 打开面板添加入站后，点「立即同步」。</p>
        ) : (
          <div className="space-y-3">
            {inbounds.map(inbound => (
              <div key={inbound.id} className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
                  <span className="truncate font-medium">{inbound.remark || '#' + inbound.id}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500 uppercase">
                      {inbound.protocol} {inbound.port}
                    </span>
                    {!inbound.enabled && <Badge tone="zinc">停用</Badge>}
                  </span>
                </div>
                {inbound.clients === null ? (
                  <p className="px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300">gateway 版本过旧，无法列出客户端。请在 VPS 上重新运行安装脚本升级后同步。</p>
                ) : inbound.clients.length === 0 ? (
                  <p className="px-4 py-2.5 text-xs text-zinc-500">没有客户端。</p>
                ) : (
                  <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {inbound.clients.map(client => (
                      <li key={client.email} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                        <span className="min-w-0 flex-1 truncate">{client.email}</span>
                        {client.unsupported ? <Badge tone="amber">暂不支持订阅</Badge> : !client.enabled ? <Badge tone="zinc">已停用</Badge> : client.nodeId !== null ? <Badge tone="green">已在订阅中</Badge> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={dialog === 'rename'} title="重命名机器" onClose={close}>
        <RenameForm initial={machine.name} pending={patch.isPending} error={patch.isError ? errorMessage(patch.error) : null} onSubmit={name => patch.mutate({ name })} onCancel={close} />
      </Modal>
      <Modal open={dialog === 'repair'} title="重新配对" onClose={close}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">在这台 VPS 上运行 sudo inx-gateway pair，粘贴输出的配对码。只接受同一台 VPS 的配对码，机器名称和已有设置保持不变。</p>
        <PairForm withName={false} submitLabel="验证并更新" pending={patch.isPending} error={patch.isError ? errorMessage(patch.error) : null} onSubmit={pairCode => patch.mutate({ pairCode })} onCancel={close} />
      </Modal>
      <Modal open={dialog === 'delete'} title={`删除「${machine.name}」？`} onClose={close}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          主控会删除这台机器保存的凭据和入站记录
          {detail.data.usage.nodes > 0 && `，以及它的 ${detail.data.usage.nodes} 个客户端在订阅中的记录${detail.data.usage.subscriptions > 0 ? `（会从 ${detail.data.usage.subscriptions} 个订阅中移除）` : ''}`}
          。VPS 上的 gateway 和 3x-ui 不受影响；之后可以用配对码重新添加。
        </p>
        <ErrorText>{remove.isError ? errorMessage(remove.error) : null}</ErrorText>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={close} disabled={remove.isPending}>
            取消
          </SecondaryButton>
          <SecondaryButton variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? '正在删除…' : '删除'}
          </SecondaryButton>
        </div>
      </Modal>
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/machines" className="inline-block text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
      ← 全部机器
    </Link>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 truncate font-medium" title={title}>
        {value}
      </dd>
    </div>
  );
}

function RenameForm({ initial, pending, error, onSubmit, onCancel }: { initial: string; pending: boolean; error: string | null; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field label="名称" required autoFocus maxLength={64} value={name} onChange={e => setName(e.target.value)} />
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={pending}>
          取消
        </SecondaryButton>
        <Button type="submit" className="h-9" disabled={pending || !name.trim()}>
          保存
        </Button>
      </div>
    </form>
  );
}
