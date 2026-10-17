import React, { useEffect, useRef, useState } from 'react';
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

export default function RegisterPage() {
  const navigate = useNavigate();
  const { refresh } = useAuthUser();
  const captchaRef = useRef(null);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [mailReady, setMailReady] = useState(true);

  useEffect(() => {
    authRequest('/auth/config').then((cfg) => {
      setMailReady(Boolean(cfg.systemMailReady));
    }).catch(() => setMailReady(false));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function refreshCaptcha() {
    captchaRef.current?.refresh();
  }

  async function onSendCode() {
    if (!email.trim()) {
      toast.error('请先填写注册邮箱');
      return;
    }
    if (!captchaId || !captcha.trim()) {
      toast.error('请先填写图形验证码');
      return;
    }
    setSendingCode(true);
    try {
      const result = await authRequest('/auth/register/send-code', 'POST', {
        email, captchaId, captchaText: captcha,
      });
      toast.success(result.message || '验证码已发送');
      if (result.debugCode) {
        setEmailCode(result.debugCode);
        toast.message(`本地演示验证码：${result.debugCode}`);
      }
      setCooldown(60);
      refreshCaptcha();
    } catch (error) {
      toast.error(error.message);
      refreshCaptcha();
    } finally {
      setSendingCode(false);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authRequest('/auth/register', 'POST', {
        email, username, password, captchaId, captchaText: captcha, emailCode,
      });
      setAuthToken(result.token);
      await refresh();
      try {
        localStorage.setItem('daylight.pending-onboarding', '1');
        localStorage.setItem('daylight.pending-mailbox-setup', '1');
        localStorage.removeItem('daylight.onboarding.v1');
        localStorage.removeItem('daylight.onboarding.v2');
      } catch { /* ignore */ }
      toast.success(`注册成功。下一步请为 ${result.user?.email || email} 填写邮箱授权码`);
      navigate('/app/settings?tab=mailbox&focus=auth');
    } catch (error) {
      toast.error(error.message);
      refreshCaptcha();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="创建账号"
      subtitle="创建账号后可使用智能招聘、发票助手，并添加保研、申博、求职和科研工作台。"
      footer={(
        <>
          已有账号？{' '}
          <Link className="font-medium text-foreground underline-offset-4 hover:underline" to="/login">去登录</Link>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {!mailReady && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200 break-keep">
            系统发信邮箱尚未就绪，暂时无法发送注册验证码。请联系管理员在后台配置 SMTP。
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className="h-11" placeholder="name@example.com" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" className="h-11" placeholder="2–24 位字母、数字或中文" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">密码</Label>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" className="h-11" placeholder="至少 8 位" />
        </div>
        <CaptchaField ref={captchaRef} value={captcha} onChange={setCaptcha} onCaptchaId={setCaptchaId} />
        <div className="space-y-2">
          <Label htmlFor="emailCode">邮箱验证码</Label>
          <div className="flex gap-2">
            <Input
              id="emailCode"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              className="h-11"
              placeholder="6 位验证码"
            />
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0 px-3"
              disabled={sendingCode || cooldown > 0 || !mailReady}
              onClick={onSendCode}
            >
              {sendingCode ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {cooldown > 0 ? `${cooldown}s` : '发送验证码'}
            </Button>
          </div>
        </div>
        <Button className="h-11 w-full" disabled={busy || !mailReady}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          注册并进入
        </Button>
      </form>
    </AuthShell>
  );
}
