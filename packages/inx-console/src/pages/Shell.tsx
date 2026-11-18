import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { api, type Status } from '../api';

const dismissKey = 'inx-no-tls-dismissed';
const readDismissed = () => {
  try {
    return localStorage.getItem(dismissKey) === '1';
  } catch {
    return false;
  }
};

const links = [
  { to: '/machines', label: '机器' },
  { to: '/subscriptions', label: '订阅' }
];

export function Shell() {
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['status'] })
  });
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/status') });
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissKey, '1');
    } catch {
      // Private mode: the banner simply comes back next time.
    }
  };
  return (
    <div className="min-h-dvh">
      {status.data && !status.data.tls && !dismissed && (
        <div className="border-b border-amber-300 bg-amber-50 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
          <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2">
            <p className="min-w-0 flex-1">
              未配置域名：登录密码和订阅链接以明文传输。在主控主机上运行 <code className="font-mono">sudo inx-connect domain</code> 绑定域名并启用 HTTPS。
            </p>
            <button className="shrink-0 text-amber-700 hover:text-amber-950 dark:text-amber-300 dark:hover:text-amber-100" onClick={dismiss} aria-label="关闭提示">
              ✕
            </button>
          </div>
        </div>
      )}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <span className="shrink-0 font-semibold">INX Connect</span>
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {links.map(link => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) => 'rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition ' + (isActive ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100')}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <button className="shrink-0 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" disabled={logout.isPending} onClick={() => logout.mutate()}>
            退出
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
