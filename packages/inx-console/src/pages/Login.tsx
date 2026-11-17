import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';

import { api, errorMessage } from '../api';
import { AuthCard, Button, ErrorText, Field } from '../ui';

export function Login() {
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: () => api('/auth/login', { body: { password } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['status'] });
      void navigate('/', { replace: true });
    }
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <AuthCard
      title="登录"
      description={
        <>
          忘记密码时，在主控主机上运行 <code className="font-mono">sudo inx-connect setup-code --reset</code> 重新设置。
        </>
      }>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="管理员密码" type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} />
        <ErrorText>{login.isError ? errorMessage(login.error) : null}</ErrorText>
        <Button type="submit" className="w-full" disabled={login.isPending || !password}>
          {login.isPending ? '正在登录…' : '登录'}
        </Button>
      </form>
    </AuthCard>
  );
}
