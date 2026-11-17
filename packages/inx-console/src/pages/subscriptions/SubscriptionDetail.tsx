import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api, errorMessage, type SubscriptionDetail as Detail, subscriptionUrl } from '../../api';
import { Badge, ErrorText, Modal, SecondaryButton, timeAgo } from '../../ui';
import { NameForm, nodesQuery } from '../nodes/Nodes';
import { inboundLabel, NodeStatus } from '../nodes/NodeStatus';

type Dialog = 'rename' | 'rotate' | 'delete' | 'add' | 'qr' | null;

export function SubscriptionDetail() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);
  const detail = useQuery({ queryKey: ['subscription', id], queryFn: () => api<Detail>('/subscriptions/' + id), enabled: Number.isSafeInteger(id) });
  const allNodes = useQuery({ ...nodesQuery, enabled: dialog === 'add' });

  const saved = (data: Detail) => {
    queryClient.setQueryData(['subscription', id], data);
    void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });
  };
  const members = useMutation({ mutationFn: (nodeIds: number[]) => api<Detail>(`/subscriptions/${id}/nodes`, { method: 'PUT', body: { nodeIds } }), onSuccess: saved });
  const rename = useMutation({
    mutationFn: (name: string) => api<Detail>('/subscriptions/' + id, { method: 'PATCH', body: { name } }),
    onSuccess: data => {
      saved(data);
      setDialog(null);
    }
  });
  const rotate = useMutation({
    mutationFn: () => api<Detail>(`/subscriptions/${id}/rotate`, { method: 'POST' }),
    onSuccess: data => {
      saved(data);
      setDialog(null);
    }
  });
  const remove = useMutation({
    mutationFn: () => api('/subscriptions/' + id, { method: 'DELETE' }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['subscription', id] });
      await queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void navigate('/subscriptions', { replace: true });
    }
  });
  const close = () => {
    setDialog(null);
    rename.reset();
    rotate.reset();
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

  const { subscription, nodes } = detail.data;
  const url = subscriptionUrl(subscription.token);
  const ids = nodes.map(n => n.id);
  const move = (from: number, to: number) => {
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    members.mutate(next);
  };
  const copy = async () => {
    // The Clipboard API needs HTTPS (or localhost); fall back to selecting the field and copying.
    if (window.isSecureContext && navigator.clipboard) await navigator.clipboard.writeText(url);
    else {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="订阅链接"]');
      input?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const available = nodes.filter(n => n.status === 'ok').length;

  return (
    <section className="space-y-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold">{subscription.name}</h1>
          <p className="text-sm text-zinc-500">
            {nodes.length} 个节点{available < nodes.length && `，其中 ${nodes.length - available} 个当前不可用、不会出现在订阅中`} · 更新于{timeAgo(subscription.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton onClick={() => setDialog('rename')}>重命名</SecondaryButton>
          <SecondaryButton variant="danger" onClick={() => setDialog('delete')}>
            删除
          </SecondaryButton>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="text-sm font-medium">订阅链接</div>
        <div className="flex flex-wrap gap-2">
          <input readOnly value={url} onFocus={e => e.target.select()} className="h-9 min-w-0 flex-1 basis-64 rounded-lg border border-zinc-300 bg-zinc-50 px-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950" aria-label="订阅链接" />
          <SecondaryButton onClick={() => void copy()}>{copied ? '已复制' : '复制'}</SecondaryButton>
          <SecondaryButton onClick={() => setDialog('qr')}>二维码</SecondaryButton>
          <SecondaryButton onClick={() => setDialog('rotate')}>重置链接</SecondaryButton>
        </div>
        <p className="text-xs text-zinc-500">适用于 Shadowrocket 等支持标准分享链接的客户端。链接相当于密码，请只分享给自己的设备。</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold">节点 · 按订阅中的顺序</h2>
          <SecondaryButton onClick={() => setDialog('add')}>添加节点</SecondaryButton>
        </div>
        <ErrorText>{members.isError ? errorMessage(members.error) : null}</ErrorText>
        {nodes.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">还没有节点。点击「添加节点」从任意机器选择。</p>
        ) : (
          <ol className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {nodes.map((node, i) => (
              <li key={node.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-5 shrink-0 text-right text-sm text-zinc-400 tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{node.name}</span>
                    {node.status !== 'ok' && <NodeStatus node={node} />}
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {node.machineName} · {inboundLabel(node)} · {node.clientEmail}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <IconButton label="上移" disabled={i === 0 || members.isPending} onClick={() => move(i, i - 1)}>
                    ↑
                  </IconButton>
                  <IconButton label="下移" disabled={i === nodes.length - 1 || members.isPending} onClick={() => move(i, i + 1)}>
                    ↓
                  </IconButton>
                  <IconButton label="移出订阅" disabled={members.isPending} onClick={() => members.mutate(ids.filter(x => x !== node.id))}>
                    ✕
                  </IconButton>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <Modal open={dialog === 'add'} title="添加节点" onClose={close}>
        <AddNodes
          candidates={(allNodes.data ?? []).filter(n => !ids.includes(n.id))}
          loading={allNodes.isPending}
          onAdd={picked => {
            members.mutate([...ids, ...picked]);
            setDialog(null);
          }}
          onCancel={close}
        />
      </Modal>
      <Modal open={dialog === 'qr'} title="扫码导入" onClose={close}>
        <QrImage text={url} />
        <p className="text-center text-xs text-zinc-500">用手机上的客户端扫描，导入「{subscription.name}」。</p>
        <div className="flex justify-end">
          <SecondaryButton onClick={close}>关闭</SecondaryButton>
        </div>
      </Modal>
      <Modal open={dialog === 'rename'} title="重命名订阅" onClose={close}>
        <NameForm initial={subscription.name} hint="客户端刷新订阅后显示新标题。" pending={rename.isPending} error={rename.isError ? errorMessage(rename.error) : null} onSubmit={name => rename.mutate(name)} onCancel={close} />
      </Modal>
      <Modal open={dialog === 'rotate'} title="重置订阅链接？" onClose={close}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">旧链接会立即失效，已导入它的设备将无法再更新，需要重新导入新链接。适用于链接泄露的情况。</p>
        <ErrorText>{rotate.isError ? errorMessage(rotate.error) : null}</ErrorText>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={close}>取消</SecondaryButton>
          <SecondaryButton variant="danger" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
            重置
          </SecondaryButton>
        </div>
      </Modal>
      <Modal open={dialog === 'delete'} title={`删除「${subscription.name}」？`} onClose={close}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">订阅链接会立即失效。节点本身不会被删除。</p>
        <ErrorText>{remove.isError ? errorMessage(remove.error) : null}</ErrorText>
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={close}>取消</SecondaryButton>
          <SecondaryButton variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            删除
          </SecondaryButton>
        </div>
      </Modal>
    </section>
  );
}

function AddNodes({ candidates, loading, onAdd, onCancel }: { candidates: Detail['nodes']; loading: boolean; onAdd: (ids: number[]) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  if (loading) return null;
  const byMachine = Map.groupBy(candidates, n => n.machineName);
  return (
    <div className="space-y-4">
      {candidates.length === 0 ? (
        <p className="text-sm text-zinc-500">
          没有可添加的节点。先在
          <Link to="/nodes" className="underline">
            「节点」页
          </Link>
          导入。
        </p>
      ) : (
        <div className="max-h-[50vh] space-y-4 overflow-y-auto">
          {[...byMachine].map(([machine, list]) => (
            <fieldset key={machine} className="space-y-1">
              <legend className="mb-1 text-xs font-medium text-zinc-500">{machine}</legend>
              {list.map(n => (
                <label key={n.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <input type="checkbox" className="size-4" checked={picked.includes(n.id)} onChange={e => setPicked(e.target.checked ? [...picked, n.id] : picked.filter(x => x !== n.id))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{n.name}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {inboundLabel(n)} · {n.clientEmail}
                    </span>
                  </span>
                  {n.status !== 'ok' && <NodeStatus node={n} />}
                  {n.subscriptionCount > 0 && <Badge tone="zinc">{n.subscriptionCount} 个订阅</Badge>}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
        <SecondaryButton disabled={picked.length === 0} onClick={() => onAdd(picked)}>
          添加 {picked.length > 0 && picked.length}
        </SecondaryButton>
      </div>
    </div>
  );
}

function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [text]);
  return <div className="flex justify-center">{src && <img src={src} alt="订阅链接二维码" width={280} height={280} className="rounded-lg bg-white p-2" />}</div>;
}

function IconButton({ label, children, ...props }: { label: string; children: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="size-8 rounded-md text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      {...props}>
      {children}
    </button>
  );
}

function BackLink() {
  return (
    <Link to="/subscriptions" className="inline-block text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
      ← 全部订阅
    </Link>
  );
}
