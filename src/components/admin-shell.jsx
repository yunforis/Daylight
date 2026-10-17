import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, ChevronDown, HardDrive, LogOut, Search, Server, Sparkles, Users, Workflow,
} from 'lucide-react';
import { AdminCommandPalette } from '@/components/admin-command-palette';
import { AdminLittleD } from '@/components/admin-little-d';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { PublicThemeControls } from '@/components/public-theme-controls';
import { useAuthUser } from '@/lib/auth-session';
import { cn } from '@/lib/utils';

const NAV_GROUPS = [
  {
    id: 'ops',
    label: '运营监控',
    icon: Activity,
    items: [
      { to: '/admin', end: true, label: '总览' },
      { to: '/admin/monitor/jobs', label: '同步与队列' },
      { to: '/admin/monitor/traces', label: '处理日志' },
    ],
  },
  {
    id: 'accounts',
    label: '账号与权限',
    icon: Users,
    items: [
      { to: '/admin/users', label: '用户管理' },
      { to: '/admin/auth', label: '认证门禁' },
    ],
  },
  {
    id: 'workspace',
    label: '工作区数据',
    icon: Workflow,
    items: [
      { to: '/admin/mailboxes', label: '邮箱管理' },
      { to: '/admin/workspace', label: '模型与工作区' },
      { to: '/admin/onboarding', label: '新手引导' },
    ],
  },
  {
    id: 'system',
    label: '系统服务',
    icon: Server,
    items: [
      { to: '/admin/storage', label: '本地存储' },
      { to: '/admin/storage/oss', label: '对象存储' },
      { to: '/admin/mail', label: '系统发信' },
    ],
  },
];

function groupOpenByPath(pathname) {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)))) {
      return group.id;
    }
  }
  return 'ops';
}

function pageTitle(pathname) {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)) {
        return item.label;
      }
    }
  }
  if (pathname.startsWith('/admin/users/')) return '用户详情';
  return '控制台';
}

/** 独立管理端布局：跟随全局明暗主题，与用户端侧栏结构分离。 */
export function AdminShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthUser();
  const activeGroup = groupOpenByPath(location.pathname);
  const [openMap, setOpenMap] = useState(() => Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.id === activeGroup])));
  const [commandOpen, setCommandOpen] = useState(false);
  const [littleDOpen, setLittleDOpen] = useState(false);
  const title = useMemo(() => pageTitle(location.pathname), [location.pathname]);

  useEffect(() => {
    function onKey(event) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setLittleDOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="admin-shell flex min-h-svh bg-background text-foreground">
      <aside className="flex w-[248px] shrink-0 flex-col border-r bg-muted/40">
        <div className="border-b px-4 py-4">
          <div className="flex items-center gap-2.5">
            <BrandMark className="size-9 rounded-lg" />
            <div className="min-w-0">
              <div className="truncate font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight">Daylight Admin</div>
              <div className="text-[11px] text-muted-foreground">系统控制台</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
          {NAV_GROUPS.map((group) => {
            const open = openMap[group.id] ?? group.id === activeGroup;
            return (
              <Collapsible
                key={group.id}
                open={open}
                onOpenChange={(next) => setOpenMap((prev) => ({ ...prev, [group.id]: next }))}
              >
                <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
                  <group.icon className="size-4 shrink-0 opacity-80" />
                  <span className="flex-1">{group.label}</span>
                  <ChevronDown className={cn('size-3.5 opacity-50 transition-transform', open && 'rotate-180')} />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-0.5 space-y-0.5 pb-1 pl-2">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => cn(
                        'block rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                        isActive && 'bg-primary/10 font-medium text-primary',
                      )}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </nav>

        <div className="space-y-2 border-t p-3">
          <div className="truncate px-1 text-sm font-medium">{user?.username || '管理员'}</div>
          <div className="truncate px-1 text-[11px] text-muted-foreground">{user?.email}</div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" onClick={() => navigate('/app')}>
              <HardDrive className="size-3.5" />
              用户端
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => { logout(); navigate('/admin/login'); }}>
              <LogOut className="size-3.5" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between gap-3 border-b px-5">
          <h1 className="min-w-0 truncate font-[family-name:var(--font-display)] text-sm font-medium tracking-tight">{title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setCommandOpen(true)}
            >
              <Search className="size-3.5" />
              搜索
              <kbd className="hidden rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:inline">⌘K</kbd>
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setLittleDOpen(true)}
            >
              <Sparkles className="size-3.5" />
              小 D
            </Button>
            <PublicThemeControls />
          </div>
        </header>
        <main className="flex-1 overflow-auto bg-muted/20">
          <div className="mx-auto max-w-6xl px-5 py-5">
            <Outlet />
          </div>
        </main>
      </div>

      <AdminCommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onOpenLittleD={() => setLittleDOpen(true)}
      />
      <AdminLittleD open={littleDOpen} onOpenChange={setLittleDOpen} />

      {!littleDOpen && (
        <button
          type="button"
          className="fixed bottom-5 right-5 z-40 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg transition hover:opacity-90"
          aria-label="打开管理端小 D"
          onClick={() => setLittleDOpen(true)}
        >
          <Sparkles className="size-5" />
        </button>
      )}
    </div>
  );
}
