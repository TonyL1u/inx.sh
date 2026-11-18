import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, type ClientRef, errorMessage, type SubscriptionDetail } from '../../api';
import { Button, ErrorText, Field } from '../../ui';
import { ClientPicker } from './ClientPicker';

// Name it, tick clients from any machines, done: the subscription link is ready on the next page.
export function NewSubscription() {
  const [name, setName] = useState('');
  const [clients, setClients] = useState<ClientRef[]>([]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api<SubscriptionDetail>('/subscriptions', { body: { name: name.trim(), clients } }),
    onSuccess: data => {
      queryClient.setQueryData(['subscription', data.subscription.id], data);
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      void navigate('/subscriptions/' + data.subscription.id, { replace: true });
    }
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && clients.length > 0) create.mutate();
  };

  return (
    <form className="space-y-6 pb-24" onSubmit={submit}>
      <Link to="/subscriptions" className="inline-block text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        ← 全部订阅
      </Link>
      <h1 className="text-2xl font-semibold">新建订阅</h1>
      <div className="max-w-md">
        <Field label="订阅名称" required autoFocus maxLength={64} placeholder="例如：我的 iPhone" value={name} onChange={e => setName(e.target.value)} hint="会作为订阅标题显示在客户端里。" />
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium">选择客户端 · 可以跨机器</h2>
        <ClientPicker value={clients} onChange={setClients} />
      </div>
      <div className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-sm text-zinc-500">已选 {clients.length} 个客户端</span>
          <div className="flex items-center gap-3">
            <ErrorText>{create.isError ? errorMessage(create.error) : null}</ErrorText>
            <Button type="submit" className="h-9" disabled={create.isPending || !name.trim() || clients.length === 0}>
              {create.isPending ? '正在创建…' : '创建订阅链接'}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
