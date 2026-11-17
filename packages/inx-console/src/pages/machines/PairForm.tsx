import { type FormEvent, useState } from 'react';

import { Button, ErrorText, Field, SecondaryButton, TextArea } from '../../ui';

// Shared by "add machine" and "re-pair": the pairing code, and optionally a display name.
export function PairForm({ withName, pending, error, submitLabel, onSubmit, onCancel }: { withName: boolean; pending: boolean; error: string | null; submitLabel: string; onSubmit: (pairCode: string, name: string) => void; onCancel: () => void }) {
  const [pairCode, setPairCode] = useState('');
  const [name, setName] = useState('');
  const code = pairCode.trim();
  const looksValid = code.startsWith('inx-pair-') && code.length > 60;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (looksValid) onSubmit(code, name.trim());
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <TextArea
        label="配对码"
        rows={4}
        required
        autoFocus
        placeholder="inx-pair-…"
        value={pairCode}
        onChange={e => setPairCode(e.target.value)}
        hint={
          <>
            在 VPS 上安装 gateway 后输出；也可以运行 <code className="font-mono">sudo inx-gateway pair</code> 再次查看。配对码包含管理凭据，请勿外传。
          </>
        }
      />
      {withName && <Field label="名称（可选）" maxLength={64} placeholder="默认使用 VPS 地址" value={name} onChange={e => setName(e.target.value)} />}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={pending}>
          取消
        </SecondaryButton>
        <Button type="submit" className="h-9" disabled={pending || !looksValid}>
          {pending ? '正在验证…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
