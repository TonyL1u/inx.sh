import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api, type ClientRef, errorMessage, type Node, type SubscriptionDetail as Detail, subscriptionUrl } from '../../api';
import { Button, ErrorText, Modal, NameForm, SecondaryButton, timeAgo } from '../../ui';
import { ClientPicker } from './ClientPicker';
import { inboundLabel, NodeStatus } from './NodeStatus';

type Dialog = 'rename' | 'rotate' | 'delete' | 'pick' | 'qr' | null;

export function SubscriptionDetail() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [copied, setCopied] = useState(false);
  const detail = useQuery({ queryKey: ['subscription', id], queryFn: () => api<Detail>('/subscriptions/' + id), enabled: Number.isSafeInteger(id) });
  const [renamingNode, setRenamingNode] = useState<Node | null>(null);

  const saved = (data: Detail) => {
    queryClient.setQueryData(['subscription', id], data);
    void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });
  };
  const members = useMutation({ mutationFn: (nodeIds: number[]) => api<Detail>(`/subscriptions/${id}/nodes`, { method: 'PUT', body: { nodeIds } }), onSuccess: saved });
  const pick = useMutation({
    mutationFn: (clients: ClientRef[]) => api<Detail>(`/subscriptions/${id}/clients`, { method: 'PUT', body: { clients } }),
    onSuccess: data => {
      saved(data);
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      setDialog(null);
    }
  });
  // A node's name is shared by every subscription that contains the client.
  const renameNode = useMutation({
    mutationFn: ({ nodeId, name }: { nodeId: number; name: string }) => api(`/nodes/${nodeId}`, { method: 'PATCH', body: { name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      setRenamingNode(null);
    }
  });
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
            {nodes.length} 个客户端{available < nodes.length && `，其中 ${nodes.length - available} 个当前不可用、不会出现在订阅中`} · 更新于{timeAgo(subscription.updatedAt)}
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
          <h2 className="font-semibold">客户端 · 按订阅中的顺序</h2>
          <SecondaryButton onClick={() => setDialog('pick')}>选择客户端</SecondaryButton>
        </div>
        <ErrorText>{members.isError ? errorMessage(members.error) : null}</ErrorText>
        {nodes.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">还没有客户端。点击「选择客户端」从任意机器勾选。</p>
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
                  <IconButton label="重命名" onClick={() => setRenamingNode(node)}>
                    ✎
                  </IconButton>
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

      <Modal open={dialog === 'pick'} title="选择客户端" onClose={close} wide>
        {dialog === 'pick' && (
          <PickClients
            initial={nodes.map(n => ({ machineId: n.machineId, inboundId: n.inboundId, email: n.clientEmail }))}
            pending={pick.isPending}
            error={pick.isError ? errorMessage(pick.error) : null}
            onSave={refs => pick.mutate(refs)}
            onCancel={close}
          />
        )}
      </Modal>
      <Modal open={renamingNode !== null} title="重命名" onClose={() => setRenamingNode(null)}>
        {renamingNode && (
          <NameForm
            initial={renamingNode.name}
            hint={renamingNode.subscriptionCount > 1 ? `这个客户端在 ${renamingNode.subscriptionCount} 个订阅中，名称会同时更新。` : '设备刷新订阅后显示新名称。'}
            pending={renameNode.isPending}
            error={renameNode.isError ? errorMessage(renameNode.error) : null}
            onSubmit={name => renameNode.mutate({ nodeId: renamingNode.id, name })}
            onCancel={() => setRenamingNode(null)}
          />
        )}
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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">订阅链接会立即失效。机器和 3x-ui 中的客户端不受影响。</p>
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

// Current members stay in their order; newly ticked clients are appended.
function PickClients({ initial, pending, error, onSave, onCancel }: { initial: ClientRef[]; pending: boolean; error: string | null; onSave: (refs: ClientRef[]) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="space-y-4">
      <div className="max-h-[60vh] overflow-y-auto">
        <ClientPicker value={value} onChange={setValue} />
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-zinc-500">已选 {value.length} 个</span>
        <div className="flex gap-2">
          <SecondaryButton onClick={onCancel} disabled={pending}>
            取消
          </SecondaryButton>
          <Button className="h-9" disabled={pending} onClick={() => onSave(value)}>
            保存
          </Button>
        </div>
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
