import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { api, clientKey, type ClientRef, errorMessage, type PickerClient, type PickerMachine } from '../../api';
import { Badge, ErrorText } from '../../ui';

export const clientsQuery = { queryKey: ['clients'], queryFn: () => api<{ machines: PickerMachine[] }>('/clients').then(r => r.machines) };

// A client can go into a subscription when the controller can produce a link for it.
const pickable = (c: PickerClient) => !c.unsupported && c.linkCount > 0;

/** Every machine's clients with checkboxes. `value` keeps the pick order; new picks are appended. */
export function ClientPicker({ value, onChange }: { value: ClientRef[]; onChange: (next: ClientRef[]) => void }) {
  const machines = useQuery(clientsQuery);
  const picked = new Set(value.map(clientKey));
  const toggle = (ref: ClientRef, on: boolean) => onChange(on ? [...value, ref] : value.filter(v => clientKey(v) !== clientKey(ref)));

  if (machines.isPending) return <p className="text-sm text-zinc-500">正在加载…</p>;
  if (machines.isError) return <ErrorText>{errorMessage(machines.error)}</ErrorText>;
  if (machines.data.length === 0)
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
        还没有机器。先到
        <Link to="/machines" className="mx-1 underline">
          「机器」
        </Link>
        粘贴配对码添加 VPS。
      </p>
    );

  return (
    <div className="space-y-4">
      {machines.data.map(machine => {
        const refs = machine.inbounds.flatMap(ib => ib.clients.filter(pickable).map(c => ({ machineId: machine.id, inboundId: ib.id, email: c.email })));
        const all = refs.length > 0 && refs.every(r => picked.has(clientKey(r)));
        return (
          <section key={machine.id} className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <header className="flex items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4"
                  disabled={refs.length === 0}
                  checked={all}
                  onChange={e => onChange(e.target.checked ? [...value, ...refs.filter(r => !picked.has(clientKey(r)))] : value.filter(v => v.machineId !== machine.id))}
                  aria-label={`选择 ${machine.name} 的全部客户端`}
                />
                <span className="truncate font-medium">{machine.name}</span>
              </label>
              {machine.status === 'error' && <Badge tone="zinc">离线 · 使用上次同步</Badge>}
            </header>
            {!machine.clientsListed ? (
              <p className="px-4 py-3 text-sm text-amber-700 dark:text-amber-300">这台机器的 gateway 版本过旧，无法列出客户端。请在 VPS 上重新运行安装脚本升级，然后在机器页点「立即同步」。</p>
            ) : machine.inbounds.every(ib => ib.clients.length === 0) ? (
              <p className="px-4 py-3 text-sm text-zinc-500">这台机器的 3x-ui 还没有客户端。可以用 sudo x-ui 打开面板添加入站。</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {machine.inbounds.flatMap(ib =>
                  ib.clients.map(c => {
                    const ref = { machineId: machine.id, inboundId: ib.id, email: c.email };
                    const ok = pickable(c);
                    return (
                      <li key={clientKey(ref)}>
                        <label className={'flex items-center gap-3 px-4 py-2.5 ' + (ok ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40' : 'opacity-60')}>
                          <input type="checkbox" className="size-4" disabled={!ok} checked={picked.has(clientKey(ref))} onChange={e => toggle(ref, e.target.checked)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{c.nodeName ?? c.email}</span>
                            <span className="block truncate text-xs text-zinc-500">
                              {ib.remark || '#' + ib.id} · {ib.protocol.toUpperCase()} {ib.port}
                              {c.nodeName && ` · ${c.email}`}
                            </span>
                          </span>
                          {c.unsupported ? <Badge tone="amber">暂不支持</Badge> : !ib.enabled || !c.enabled ? <Badge tone="zinc">已停用</Badge> : null}
                        </label>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
