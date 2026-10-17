import React, { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { CaptchaField } from '@/components/captcha-field';
import { AuthShell } from '@/pages/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authRequest } from '@/lib/auth-api';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const captchaRef = useRef(null);
  const [email, setEmail] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authRequest('/auth/forgot-password', 'POST', {
        email, captchaId, captchaText: captcha,
      });
      toast.success(result.message || '已提交');
      if (result.resetToken) {
        navigate(`/reset-password?token=${encodeURIComponent(result.resetToken)}`);
      }
    } catch (error) {
      toast.error(error.message);
      captchaRef.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="找回密码"
      subtitle="验证注册邮箱与图形验证码后，即可设置新密码。"
      footer={<Link className="font-medium text-foreground underline-offset-4 hover:underline" to="/login">返回登录</Link>}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">注册邮箱</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11" placeholder="name@example.com" />
        </div>
        <CaptchaField ref={captchaRef} value={captcha} onChange={setCaptcha} onCaptchaId={setCaptchaId} />
        <Button className="h-11 w-full" disabled={busy}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          发送重置指引
        </Button>
      </form>
    </AuthShell>
  );
}
