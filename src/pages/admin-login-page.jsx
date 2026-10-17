import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoaderCircle, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { CaptchaField } from '@/components/captcha-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PublicThemeControls } from '@/components/public-theme-controls';
import { authRequest, getAuthToken, setAuthToken } from '@/lib/auth-api';
import { useAuthUser } from '@/lib/auth-session';

/** 管理端独立登录：跟随全局主题，必须管理员账号。 */
export default function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const denied = Boolean(location.state?.denied);
  const { user, loading, refresh, isAdmin, logout } = useAuthUser();
  const captchaRef = useRef(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && isAdmin && getAuthToken()) {
      navigate('/admin', { replace: true });
    }
  }, [loading, isAdmin, navigate]);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await authRequest('/auth/login', 'POST', {
        account, password, captchaId, captchaText: captcha,
      });
      setAuthToken(result.token);
      const nextUser = await refresh();
      const admin = Boolean(nextUser?.isAdmin || nextUser?.role === 'admin');
      if (!admin) {
        logout();
        toast.error('该账号不是管理员，无法进入管理端');
        return;
      }
      toast.success(`管理员 ${nextUser.username} 已登录`);
      navigate('/admin', { replace: true });
    } catch (error) {
      toast.error(error.message);
      captchaRef.current?.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isAdmin && getAuthToken()) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 px-4">
      <div className="absolute right-4 top-4">
        <PublicThemeControls />
      </div>
      <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Shield className="size-5" />
          </span>
          <div>
            <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">管理端登录</h1>
            <p className="text-sm text-muted-foreground">仅管理员可进入系统控制台</p>
          </div>
        </div>

        {denied || (user && !isAdmin) ? (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
            {user && !isAdmin
              ? `当前已登录普通账号 ${user.username}，请改用管理员账号登录管理端。`
              : '需要管理员账号才能进入控制台。'}
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="admin-account">管理员邮箱 / 用户名</Label>
            <Input
              id="admin-account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              required
              className="h-11"
              placeholder="admin@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-password">密码</Label>
            <Input
              id="admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-11"
            />
          </div>
          <CaptchaField ref={captchaRef} value={captcha} onChange={setCaptcha} onCaptchaId={setCaptchaId} />
          <Button className="h-11 w-full" disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            进入管理端
          </Button>
        </form>

        <div className="mt-5 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">返回官网</Link>
          <Link to="/login" className="hover:text-foreground">用户端登录</Link>
        </div>
      </div>
    </div>
  );
}
