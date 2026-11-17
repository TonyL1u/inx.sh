import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, errorMessage, type Subscription, type SubscriptionDetail } from '../../api';
import { Button, ErrorText, Modal, timeAgo } from '../../ui';
import { NameForm } from '../nodes/Nodes';

export function Subscriptions() {
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: () => api<{ subscriptions: Subscription[] }>('/subscriptions').then(r => r.subscriptions) });
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (name: string) => api<SubscriptionDetail>('/subscriptions', { body: { name } }),
    onSuccess: data => {
      queryClient.setQueryData(['subscription', data.subscription.id], data);
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void navigate('/subscriptions/' + data.subscription.id);
    }
  });

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">订阅</h1>
        <Button className="h-9" onClick={() => setCreating(true)}>
          新建订阅
        </Button>
      </div>
      {subs.isPending ? null : subs.isError ? (
        <ErrorText>{errorMessage(subs.error)}</ErrorText>
      ) : subs.data.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
          <p className="font-medium">还没有订阅</p>
          <p className="mx-auto max-w-md text-sm text-zinc-500">订阅是一组可以跨机器组合的节点，例如「家庭网络」或「我的 iPhone」。设备导入订阅链接后，调整成员或名称只需刷新订阅。</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {subs.data.map(s => (
            <li key={s.id}>
              <Link to={'/subscriptions/' + s.id} className="block rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600">
                <div className="truncate font-medium">{s.name}</div>
                <div className="mt-1 text-sm text-zinc-500">
                  {s.nodeCount} 个节点 · 更新于{timeAgo(s.updatedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={creating}
        title="新建订阅"
        onClose={() => {
          setCreating(false);
          create.reset();
        }}>
        <NameForm
          initial=""
          hint="会作为订阅标题显示在客户端里，例如「家庭网络」。"
          submitLabel="创建"
          pending={create.isPending}
          error={create.isError ? errorMessage(create.error) : null}
          onSubmit={name => create.mutate(name)}
          onCancel={() => setCreating(false)}
        />
      </Modal>
    </section>
  );
}
