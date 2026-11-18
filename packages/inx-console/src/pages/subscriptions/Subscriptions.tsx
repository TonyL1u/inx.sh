import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { api, errorMessage, type Subscription } from '../../api';
import { ErrorText, timeAgo } from '../../ui';

const newButton = 'inline-flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300';

export function Subscriptions() {
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: () => api<{ subscriptions: Subscription[] }>('/subscriptions').then(r => r.subscriptions) });

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">订阅</h1>
        <Link to="/subscriptions/new" className={newButton}>
          新建订阅
        </Link>
      </div>
      {subs.isPending ? null : subs.isError ? (
        <ErrorText>{errorMessage(subs.error)}</ErrorText>
      ) : subs.data.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
          <p className="font-medium">还没有订阅</p>
          <p className="mx-auto max-w-md text-sm text-zinc-500">勾选任意机器上的客户端，就能生成一个订阅链接，例如「家庭网络」或「我的 iPhone」。之后调整成员或名称，设备刷新订阅即可。</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {subs.data.map(s => (
            <li key={s.id}>
              <Link to={'/subscriptions/' + s.id} className="block rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600">
                <div className="truncate font-medium">{s.name}</div>
                <div className="mt-1 text-sm text-zinc-500">
                  {s.nodeCount} 个客户端 · 更新于{timeAgo(s.updatedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
