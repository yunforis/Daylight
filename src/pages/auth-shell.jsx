import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Shield } from 'lucide-react';
import { PublicThemeControls } from '@/components/public-theme-controls';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';

const highlights = [
  '图形验证码保护注册与找回',
  '本地优先，云存储可随时启用',
  '邮件、日程、待办同一工作流',
];

export function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="auth-shell grid min-h-svh bg-background text-foreground lg:grid-cols-[1.05fr_0.95fr]">
      <aside className="auth-brand relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(700px_420px_at_20%_10%,rgba(95,140,110,0.28),transparent_60%),radial-gradient(500px_360px_at_90%_80%,rgba(244,246,241,0.08),transparent_55%)]" />
        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <Link to="/" className="inline-flex items-center gap-3 text-[#f4f6f1]">
              <BrandMark className="size-10 rounded-xl" />
              <span className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Daylight</span>
            </Link>
          </div>
          <h2 className="mt-16 max-w-md font-[family-name:var(--font-display)] text-4xl font-semibold leading-tight tracking-tight text-[#f4f6f1] xl:text-5xl">
            把散落在收件箱里的安排，收成清晰的一天。
          </h2>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-[#f4f6f1]/75">
            登录后即可配置邮箱与模型，同步邀请、改期与待办，并在证据链中回放每一次提取。
          </p>
        </div>
        <ul className="relative z-10 space-y-3">
          {highlights.map((item) => (
            <li key={item} className="flex items-center gap-3 text-sm text-[#f4f6f1]/85">
              <CheckCircle2 className="size-4 shrink-0 text-[#8fbf9a]" />
              {item}
            </li>
          ))}
          <li className="mt-6 flex items-center gap-2 text-xs text-[#f4f6f1]/50">
            <Shield className="size-3.5" />
            授权码与 API Key 仅保存在你的配置环境中
          </li>
        </ul>
      </aside>

      <div className="relative flex items-center justify-center bg-background px-4 py-10 sm:px-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_320px_at_70%_0%,color-mix(in_oklab,var(--foreground)_5%,transparent),transparent_55%)]" />
        <div className="relative z-10 w-full max-w-[420px]">
          <div className="mb-6 flex items-center justify-between gap-3">
            <Link to="/" className="inline-flex items-center gap-2 lg:hidden">
              <BrandMark className="size-9 rounded-lg" />
              <span className="font-[family-name:var(--font-display)] text-lg font-semibold">Daylight</span>
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <PublicThemeControls />
              <Button variant="outline" size="sm" asChild>
                <Link to="/">
                  <ArrowLeft className="size-4" />
                  返回官网
                </Link>
              </Button>
            </div>
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          <div className="mt-8 rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-7">
            {children}
          </div>
          {footer ? <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
