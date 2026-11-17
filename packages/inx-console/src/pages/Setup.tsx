import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { api, errorMessage } from '../api';
import { AuthCard, Button, ErrorText, Field } from '../ui';

export function Setup() {
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useMutation({
    mutationFn: () => api('/setup', { body: { code, password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['status'] });
      void navigate('/', { replace: true });
    }
  });

  if (!code)
    return (
      <AuthCard title="初始化控制台" description="需要一次性初始化链接才能设置管理员密码。">
        <div className="space-y-3 text-sm">
          <p>在主控主机上运行以下命令，然后打开输出的链接：</p>
          <pre className="overflow-x-auto rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">sudo inx-connect setup-code</pre>
        </div>
      </AuthCard>
    );

  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) setup.mutate();
  };
  return (
    <AuthCard title="设置管理员密码" description="此密码用于登录控制台。设置后初始化链接立即失效。">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="密码" type="password" autoComplete="new-password" minLength={10} maxLength={256} required value={password} onChange={e => setPassword(e.target.value)} hint="至少 10 个字符" />
        <Field label="确认密码" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
        <ErrorText>{mismatch ? '两次输入的密码不一致。' : setup.isError ? errorMessage(setup.error) : null}</ErrorText>
        <Button type="submit" className="w-full" disabled={setup.isPending || mismatch || password.length < 10}>
          {setup.isPending ? '正在保存…' : '完成设置'}
        </Button>
      </form>
    </AuthCard>
  );
}
