import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import { api, ApiError, codeMessage, type DomainStatus, errorMessage, type Machine } from '../../api';
import { Badge, Button, ErrorText, Field, Modal, SecondaryButton } from '../../ui';

// A VPS domain is its 3x-ui panel certificate: binding runs x-ui's own SSL flow on the VPS, and a domain set with
// `sudo x-ui` shows up here as well. Share links use the domain instead of the IP.
export function DomainCard({ machine }: { machine: Machine }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [watching, setWatching] = useState(false);
  const supported = machine.capabilities.includes('domain');
  const host = machine.endpoint.replace(/^https:\/\/\[?|\]?:\d+$/g, '');

  // Polled only while a request runs on the VPS.
  const status = useQuery({
    queryKey: ['domain', machine.id],
    queryFn: () => api<DomainStatus>(`/machines/${machine.id}/domain`),
    enabled: supported && watching,
    refetchInterval: q => (q.state.data?.state === 'pending' ? 3000 : false)
  });
  const done = watching && status.data && status.data.state !== 'pending';
  const finishedDomain = done && status.data!.state !== 'failed' ? status.data!.domain : undefined;
  // The controller re-syncs the machine when the domain changes; reload it so the card and links follow.
  useEffect(() => {
    if (finishedDomain === undefined || finishedDomain === machine.domain) return;
    void queryClient.invalidateQueries({ queryKey: ['machine', machine.id] });
    void queryClient.invalidateQueries({ queryKey: ['machines'] });
  }, [finishedDomain, machine.domain, machine.id, queryClient]);

  const unbind = useMutation({
    mutationFn: () => api<DomainStatus>(`/machines/${machine.id}/domain`, { method: 'DELETE' }),
    onSuccess: data => {
      queryClient.setQueryData(['domain', machine.id], data);
      setWatching(true);
    }
  });

  const pending = watching && status.data?.state === 'pending';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-500">域名</div>
        <div className="mt-0.5 flex items-center gap-2 font-medium">
          {machine.domain ? <span className="truncate">{machine.domain}</span> : <span className="text-zinc-500">未绑定 · 分享链接使用 IP {host}</span>}
          {pending && <Badge tone="amber">正在 VPS 上申请证书…</Badge>}
          {watching && status.data?.state === 'failed' && <Badge tone="red">上次绑定失败</Badge>}
        </div>
        {watching && status.data?.state === 'failed' && status.data.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{codeMessage(status.data.error)}</p>}
      </div>
      {supported ? (
        <div className="flex shrink-0 gap-2">
          <SecondaryButton onClick={() => setOpen(true)} disabled={pending}>
            {machine.domain ? '更换域名' : '绑定域名'}
          </SecondaryButton>
          {machine.domain && (
            <SecondaryButton onClick={() => unbind.mutate()} disabled={pending || unbind.isPending}>
              解除绑定
            </SecondaryButton>
          )}
        </div>
      ) : (
        <span className="text-xs text-zinc-500">升级这台 VPS 的 gateway 后可绑定域名</span>
      )}
      <ErrorText>{unbind.isError ? errorMessage(unbind.error) : null}</ErrorText>
      <Modal open={open} title={machine.domain ? '更换域名' : '绑定域名'} onClose={() => setOpen(false)}>
        {open && (
          <BindForm
            machine={machine}
            host={host}
            onQueued={data => {
              queryClient.setQueryData(['domain', machine.id], data);
              setWatching(true);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </Modal>
    </div>
  );
}

function BindForm({ machine, host, onQueued, onCancel }: { machine: Machine; host: string; onQueued: (data: DomainStatus) => void; onCancel: () => void }) {
  const [domain, setDomain] = useState('');
  const bind = useMutation({ mutationFn: (force: boolean) => api<DomainStatus>(`/machines/${machine.id}/domain`, { body: { domain: domain.trim(), force } }), onSuccess: onQueued });
  const mismatch = bind.error instanceof ApiError && bind.error.code === 'DOMAIN_DNS_MISMATCH' ? (bind.error.data as { resolved?: string[] }) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (domain.trim()) bind.mutate(false);
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field label="域名" required autoFocus placeholder="hk.example.com" value={domain} onChange={e => setDomain(e.target.value)} />
      <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-500">
        <li>
          先添加 A 记录，把域名指向 <span className="font-mono">{host}</span>。
        </li>
        <li>VPS 的 TCP 80 端口需要在安全组和防火墙中放行，且没有被其他程序占用：证书通过 80 端口验证。</li>
        <li>与 x-ui「SSL Certificate Management」相同：证书保存在 /root/cert/域名/ 并自动续期，同时设置为 3x-ui 面板证书，可以在 sudo x-ui 中查看和修改。</li>
        <li>完成后，这台机器的分享链接使用域名；设备刷新订阅即可生效。</li>
      </ul>
      {mismatch ? (
        <div role="alert" className="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <p>
            域名当前解析到 {mismatch.resolved?.length ? <span className="font-mono">{mismatch.resolved.join(', ')}</span> : '（无记录）'}，不是这台 VPS（<span className="font-mono">{host}</span>）。DNS 刚修改时可能需要几分钟生效。
          </p>
          <SecondaryButton type="button" onClick={() => bind.mutate(true)} disabled={bind.isPending}>
            仍然继续
          </SecondaryButton>
        </div>
      ) : (
        <ErrorText>{bind.isError ? errorMessage(bind.error) : null}</ErrorText>
      )}
      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={bind.isPending}>
          取消
        </SecondaryButton>
        <Button type="submit" className="h-9" disabled={bind.isPending || !domain.trim()}>
          {bind.isPending ? '正在检查…' : '绑定'}
        </Button>
      </div>
    </form>
  );
}
