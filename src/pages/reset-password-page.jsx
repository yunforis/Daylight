import React, { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { CaptchaField } from '@/components/captcha-field';
import { AuthShell } from '@/pages/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authRequest, setAuthToken } from '@/lib/auth-api';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const captchaRef = useRef(null);
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') || '');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authRequest('/auth/reset-password', 'POST', {
        token, password, captchaId, captchaText: captcha,
      });
      setAuthToken(result.token);
      toast.success('密码已更新');
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
      title="设置新密码"
      subtitle="输入重置令牌与新密码，并完成图形验证码校验。"
      footer={<Link className="font-medium text-foreground underline-offset-4 hover:underline" to="/login">返回登录</Link>}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="token">重置令牌</Label>
          <Input id="token" value={token} onChange={(e) => setToken(e.target.value)} required className="h-11 font-mono text-xs" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">新密码</Label>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className="h-11" placeholder="至少 8 位" />
        </div>
        <CaptchaField ref={captchaRef} value={captcha} onChange={setCaptcha} onCaptchaId={setCaptchaId} />
        <Button className="h-11 w-full" disabled={busy}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          更新密码并登录
        </Button>
      </form>
    </AuthShell>
  );
}
