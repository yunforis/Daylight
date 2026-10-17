import React, { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { CaptchaField } from '@/components/captcha-field';
import { AuthShell } from '@/pages/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authRequest, setAuthToken } from '@/lib/auth-api';
import { useAuthUser } from '@/lib/auth-session';

export default function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuthUser();
  const captchaRef = useRef(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authRequest('/auth/login', 'POST', {
        account, password, captchaId, captchaText: captcha,
      });
      setAuthToken(result.token);
      await refresh();
      // 仅新用户（从未完成指引）才在登录后提示；老用户刷新/重登不再闪弹窗
      try {
        const progress = JSON.parse(localStorage.getItem('daylight.onboarding.v2')
          || localStorage.getItem('daylight.onboarding.v1')
          || '{}');
        if (!(progress.tourDone && progress.syncPromptDone)) {
          localStorage.setItem('daylight.pending-onboarding', '1');
        }
      } catch { /* ignore */ }
      toast.success(`欢迎回来，${result.user.username}`);
      navigate('/app');
    } catch (error) {
      toast.error(error.message);
      captchaRef.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="欢迎回来"
      subtitle="使用邮箱或用户名登录，进入 Daylight 工作空间。"
      footer={(
        <>
          还没有账号？{' '}
          <Link className="font-medium text-foreground underline-offset-4 hover:underline" to="/register">免费注册</Link>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="account">邮箱 / 用户名</Label>
          <Input
            id="account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            required
            autoComplete="username"
            className="h-11"
            placeholder="name@example.com"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">忘记密码？</Link>
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="h-11"
          />
        </div>
        <CaptchaField ref={captchaRef} value={captcha} onChange={setCaptcha} onCaptchaId={setCaptchaId} />
        <Button className="h-11 w-full" disabled={busy}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          登录
        </Button>
      </form>
    </AuthShell>
  );
}

export { AuthShell } from '@/pages/auth-shell';
