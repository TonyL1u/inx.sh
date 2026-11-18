import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';

import { api } from '../api';

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
  return (
    <div className="min-h-dvh">
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
