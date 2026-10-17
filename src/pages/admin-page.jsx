import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  LoaderCircle, LogOut, Plus, RefreshCw, Save, Search, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { authRequest } from '@/lib/auth-api';
import { useAuthUser } from '@/lib/auth-session';
import { cn } from '@/lib/utils';

const emptyUserForm = { email: '', username: '', password: '', role: 'user' };

function sectionFromPath(pathname) {
  if (pathname.startsWith('/admin/users/')) return 'user-detail';
  if (pathname.startsWith('/admin/users')) return 'users';
  if (pathname.startsWith('/admin/monitor/jobs')) return 'jobs';
  if (pathname.startsWith('/admin/monitor/traces')) return 'traces';
  if (pathname.startsWith('/admin/mailboxes')) return 'mailboxes';
  if (pathname.startsWith('/admin/storage/oss')) return 'oss';
  if (pathname.startsWith('/admin/storage')) return 'storage';
  if (pathname.startsWith('/admin/mail')) return 'mail';
  if (pathname.startsWith('/admin/workspace')) return 'workspace';
  if (pathname.startsWith('/admin/onboarding')) return 'onboarding';
  if (pathname.startsWith('/admin/auth')) return 'auth';
  return 'monitor';
}

function fmtTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(value);
  }
}

function Panel({ title, description, actions, children, className }) {
  return (
    <Card className={cn('shadow-none', className)}>
      {(title || actions) ? (
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div>
            {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
            {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        </CardHeader>
      ) : null}
      <CardContent className={title || actions ? undefined : 'pt-6'}>{children}</CardContent>
    </Card>
  );
}

function StatGrid({ items }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border bg-card px-4 py-3">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">{value ?? '—'}</div>
        </div>
      ))}
    </div>
  );
}

export default function AdminPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const section = sectionFromPath(location.pathname);
  const { user: me } = useAuthUser();

  const [overview, setOverview] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [users, setUsers] = useState([]);
  const [userDetail, setUserDetail] = useState(null);
  const [mailboxes, setMailboxes] = useState([]);
  const [infraForm, setInfraForm] = useState(null);
  const [settingsForm, setSettingsForm] = useState(null);
  const [userForm, setUserForm] = useState(emptyUserForm);
  const [userQuery, setUserQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [ossProviders, setOssProviders] = useState([]);
  const [mailTemplates, setMailTemplates] = useState(null);
  const [mailTemplateMeta, setMailTemplateMeta] = useState([]);
  const [activeTemplateId, setActiveTemplateId] = useState('register');
  const [onboardingSteps, setOnboardingSteps] = useState([]);
  const [activeOnboardingId, setActiveOnboardingId] = useState('');

  async function reloadCore() {
    const [overviewData, monitorData, usersData, infraData, settingsData, mailboxData, templateData, onboardingData] = await Promise.all([
      authRequest('/admin/overview'),
      authRequest('/admin/monitor'),
      authRequest('/admin/users'),
      authRequest('/admin/infra'),
      authRequest('/admin/settings'),
      authRequest('/admin/mailboxes'),
      authRequest('/admin/mail-templates'),
      authRequest('/admin/onboarding-guide').catch(() => ({ steps: [] })),
    ]);
    setOverview(overviewData);
    setMonitor(monitorData);
    setUsers(usersData.users || []);
    setInfraForm(infraData.config);
    setOssProviders(infraData.ossProviders || []);
    setSettingsForm(settingsData.settings);
    setMailboxes(mailboxData.mailboxes || []);
    setMailTemplates(templateData.templates || null);
    setMailTemplateMeta(templateData.meta || []);
    const steps = onboardingData?.steps || [];
    setOnboardingSteps(steps);
    setActiveOnboardingId((current) => current || steps[0]?.id || '');
  }

  async function reloadUserDetail(id) {
    if (!id) {
      setUserDetail(null);
      return;
    }
    const detail = await authRequest(`/admin/users/${id}`);
    setUserDetail(detail);
  }

  useEffect(() => {
    reloadCore().catch((error) => toast.error(error.message));
  }, []);

  useEffect(() => {
    if (section === 'user-detail' && params.id) {
      reloadUserDetail(params.id).catch((error) => toast.error(error.message));
    } else {
      setUserDetail(null);
    }
  }, [section, params.id]);

  useEffect(() => {
    if (!['monitor', 'jobs', 'traces'].includes(section)) return undefined;
    const timer = setInterval(() => {
      authRequest('/admin/monitor').then(setMonitor).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [section]);

  async function saveInfra() {
    setBusy(true);
    try {
      const adminEmails = String(infraForm.auth.adminEmailsText ?? (infraForm.auth.adminEmails || []).join('\n'))
        .split(/\n+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
      const payload = {
        ...infraForm,
        auth: { ...infraForm.auth, adminEmails },
      };
      delete payload.auth.adminEmailsText;
      const result = await authRequest('/admin/infra', 'PUT', payload);
      setInfraForm(result.config);
      setOverview((prev) => prev ? { ...prev, status: result.status, infra: result.config } : prev);
      toast.success('已保存并热更新');
      await reloadCore();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function testOss() {
    setBusy(true);
    try {
      const result = await authRequest('/admin/infra/test-oss', 'POST', infraForm.oss || {});
      if (result.ok) toast.success(result.message || '对象存储连通成功');
      else toast.error(result.message || '连通失败');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function testMq() {
    setBusy(true);
    try {
      const result = await authRequest('/admin/infra/test-mq', 'POST', infraForm.mq || {});
      if (result.ok) toast.success(result.message || '消息队列连通成功');
      else toast.error(result.message || '连通失败');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveMailTemplates() {
    setBusy(true);
    try {
      const result = await authRequest('/admin/mail-templates', 'PUT', { templates: mailTemplates });
      setMailTemplates(result.templates);
      toast.success('邮件模板已保存');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetTemplates() {
    if (!window.confirm('恢复全部模板为默认内容？')) return;
    setBusy(true);
    try {
      const result = await authRequest('/admin/mail-templates/reset', 'POST');
      setMailTemplates(result.templates);
      toast.success('已恢复默认模板');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveOnboardingGuide() {
    setBusy(true);
    try {
      const result = await authRequest('/admin/onboarding-guide', 'PUT', { steps: onboardingSteps });
      setOnboardingSteps(result.steps || []);
      toast.success('新手引导已保存，用户下次打开指引会读到新内容');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetOnboardingGuide() {
    if (!window.confirm('恢复默认新手引导步骤？当前自定义内容会被覆盖。')) return;
    setBusy(true);
    try {
      const result = await authRequest('/admin/onboarding-guide/reset', 'POST');
      setOnboardingSteps(result.steps || []);
      setActiveOnboardingId(result.steps?.[0]?.id || '');
      toast.success('已恢复默认引导');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  function patchOnboardingStep(id, patch) {
    setOnboardingSteps((current) => current.map((step) => (
      step.id === id ? { ...step, ...patch } : step
    )));
  }

  async function previewTemplate() {
    setBusy(true);
    try {
      const result = await authRequest('/admin/mail-templates/preview', 'POST', { id: activeTemplateId });
      const preview = result.preview || {};
      window.alert(`主题：${preview.subject}\n\n${preview.text || ''}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTestTemplate() {
    setBusy(true);
    try {
      await authRequest('/admin/mail-templates/send-test', 'POST', {
        id: activeTemplateId,
        to: me?.email || '',
      });
      toast.success(`测试邮件已发往 ${me?.email || ''}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setBusy(true);
    try {
      await authRequest('/admin/settings', 'PUT', settingsForm);
      toast.success('工作区配置已保存');
      await reloadCore();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function createUser() {
    setBusy(true);
    try {
      await authRequest('/admin/users', 'POST', userForm);
      setUserForm(emptyUserForm);
      toast.success('用户已创建');
      await reloadCore();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function patchUser(id, patch) {
    setBusy(true);
    try {
      await authRequest(`/admin/users/${id}`, 'PUT', patch);
      toast.success('已更新');
      await reloadCore();
      if (params.id === id) await reloadUserDetail(id);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(id) {
    if (!window.confirm('确认删除该用户？此操作不可恢复。')) return;
    setBusy(true);
    try {
      await authRequest(`/admin/users/${id}`, 'DELETE');
      toast.success('已删除');
      if (params.id === id) navigate('/admin/users');
      await reloadCore();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function forceLogout(id) {
    setBusy(true);
    try {
      const result = await authRequest(`/admin/users/${id}/force-logout`, 'POST');
      toast.success(result.self ? '已强制下线（含当前会话）' : `已强制下线，撤销 ${result.revoked || 0} 个会话`);
      await reloadCore();
      if (params.id === id) await reloadUserDetail(id);
      if (result.self) {
        navigate('/admin/login');
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeSession(userId, jti) {
    setBusy(true);
    try {
      await authRequest(`/admin/users/${userId}/sessions/${jti}`, 'DELETE');
      toast.success('会话已撤销');
      await reloadUserDetail(userId);
      await reloadCore();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((item) => (
      item.username?.toLowerCase().includes(q)
      || item.email?.toLowerCase().includes(q)
      || item.role?.toLowerCase().includes(q)
    ));
  }, [users, userQuery]);

  const status = monitor?.status || overview?.status || {};
  const sync = monitor?.sync || overview?.sync || {};
  const fieldClass = '';
  const labelClass = '';

  if (!overview && !infraForm) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Badge variant="secondary">
          {overview?.systemMailReady ? '发信就绪' : '发信未配置'}
        </Badge>
        <Badge variant="outline">
          同步 {sync.running ? sync.stage || '进行中' : (sync.status || 'idle')}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => reloadCore().catch((e) => toast.error(e.message))}
        >
          <RefreshCw className="size-3.5" />刷新
        </Button>
      </div>

      {(section === 'monitor' || section === 'jobs' || section === 'traces') && (
        <StatGrid items={[
          ['用户', overview?.users],
          ['邮箱', overview?.mailboxes],
          ['日程', overview?.events],
          ['邮件', overview?.emails],
          ['待办', overview?.tasks],
          ['日志', overview?.traces],
        ]} />
      )}

      {section === 'monitor' && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="运行状态" description="默认本地文件 / 内存；启用本机服务后显示对应 mode">
              <div className="flex flex-wrap gap-2">
                {Object.entries(status).map(([key, value]) => (
                  <Badge key={key} variant="outline" className="border text-muted-foreground">
                    {key}: {value?.mode || (value?.ok ? 'ok' : (value?.error ? 'error' : '—'))}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="font-medium">当前同步</div>
                <p className="mt-1 text-muted-foreground">
                  {sync.status || 'idle'} · {sync.stage || '—'} · {sync.processed || 0}/{sync.total || 0}
                  {sync.error ? ` · ${sync.error}` : ''}
                </p>
              </div>
              <div className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm">
                <div className="font-medium">IDLE</div>
                <p className="mt-1 text-muted-foreground">
                  {(monitor?.idle?.active || monitor?.idle?.watching)
                    ? `监听中 · ${monitor.idle.mailboxId || ''}`
                    : '未启用或空闲'}
                </p>
              </div>
            </Panel>
            <Panel title="各邮箱数据" actions={(
              <Button size="sm" variant="outline" className="hover:bg-accent" onClick={() => navigate('/admin/mailboxes')}>
                管理
              </Button>
            )}>
              <div className="space-y-2">
                {(monitor?.mailboxStats || overview?.mailboxStats || []).map((item) => (
                  <div key={item.id} className="rounded-lg border px-3 py-2 text-sm">
                    <div className="font-medium">[{item.tagLabel}] {item.email || item.id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      日程 {item.events} · 邮件 {item.emails} · 待办 {item.tasks} · 日志 {item.traces}
                    </div>
                  </div>
                ))}
                {!(monitor?.mailboxStats || overview?.mailboxStats || []).length && (
                  <p className="text-sm text-muted-foreground">暂无邮箱</p>
                )}
              </div>
            </Panel>
          </div>
          <Panel title="最近任务" actions={(
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-white" onClick={() => navigate('/admin/monitor/jobs')}>全部</Button>
          )}>
            <div className="space-y-2">
              {(monitor?.jobs || []).slice(0, 8).map((job) => (
                <div key={job.id || `${job.topic}-${job.createdAt}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span>{job.topic || 'job'}</span>
                  <span className="text-muted-foreground">{job.status || '—'} · {fmtTime(job.createdAt || job.updatedAt)}</span>
                </div>
              ))}
              {!(monitor?.jobs || []).length && <p className="text-sm text-muted-foreground">暂无队列任务</p>}
            </div>
          </Panel>
        </div>
      )}

      {section === 'jobs' && (
        <Panel title="同步与队列">
          <div className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            状态 {sync.status || 'idle'} · 阶段 {sync.stage || '—'} · 进度 {sync.processed || 0}/{sync.total || 0}
          </div>
          <div className="space-y-2">
            {(monitor?.jobs || []).map((job) => (
              <div key={job.id || `${job.topic}-${job.createdAt}`} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{job.topic || 'job'}</span>
                  <Badge variant="outline" className="border">{job.status || '—'}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{fmtTime(job.createdAt || job.updatedAt)}{job.error ? ` · ${job.error}` : ''}</div>
              </div>
            ))}
            {!(monitor?.jobs || []).length && <p className="text-sm text-muted-foreground">暂无队列任务</p>}
          </div>
        </Panel>
      )}

      {section === 'traces' && (
        <Panel title="处理日志" description="跨邮箱证据链摘要（已脱敏）">
          <div className="space-y-2">
            {(monitor?.recentTraces || []).map((trace) => (
              <div key={`${trace.mailboxId}-${trace.trace_id}`} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border">{trace.status || '—'}</Badge>
                  <span className="font-medium">{trace.subject || trace.trace_id}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {trace.mailboxEmail || trace.mailboxId} · {fmtTime(trace.created_at)}
                  {trace.latency_ms != null ? ` · ${trace.latency_ms}ms` : ''}
                </div>
                {trace.error ? <p className="mt-1 text-xs text-red-300">{trace.error}</p> : null}
              </div>
            ))}
            {!(monitor?.recentTraces || []).length && <p className="text-sm text-muted-foreground">暂无日志</p>}
          </div>
        </Panel>
      )}

      {section === 'users' && (
        <div className="space-y-4">
          <Panel title="新建用户">
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="邮箱" value={userForm.email} onChange={(e) => setUserForm((c) => ({ ...c, email: e.target.value }))} />
              <Input placeholder="用户名" value={userForm.username} onChange={(e) => setUserForm((c) => ({ ...c, username: e.target.value }))} />
              <Input type="password" placeholder="密码（至少 8 位）" value={userForm.password} onChange={(e) => setUserForm((c) => ({ ...c, password: e.target.value }))} />
              <Select value={userForm.role} onValueChange={(value) => setUserForm((c) => ({ ...c, role: value }))}>
                <SelectTrigger ><SelectValue placeholder="角色" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">普通用户</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                </SelectContent>
              </Select>
              <Button className="md:col-span-2" disabled={busy} onClick={createUser}>
                <Plus className="size-4" />创建用户
              </Button>
            </div>
          </Panel>

          <Panel
            title="用户列表"
            description="可查看登录时间、在线会话、强制下线与关联邮箱"
            actions={(
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input className='h-8 w-48 pl-8' placeholder="搜索用户" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} />
              </div>
            )}
          >
            <Table>
              <TableHeader>
                <TableRow className="border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">用户</TableHead>
                  <TableHead className="text-muted-foreground">角色</TableHead>
                  <TableHead className="text-muted-foreground">最近登录</TableHead>
                  <TableHead className="text-muted-foreground">会话</TableHead>
                  <TableHead className="text-right text-muted-foreground">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((item) => (
                  <TableRow key={item.id} className="border hover:bg-muted/40">
                    <TableCell>
                      <div className="font-medium">{item.username}</div>
                      <div className="text-xs text-muted-foreground">{item.email}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="border">{item.role}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtTime(item.lastLoginAt)}</TableCell>
                    <TableCell>
                      <span className={item.online ? 'text-primary' : 'text-muted-foreground'}>
                        {item.online ? `在线 · ${item.activeSessions}` : '离线'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground hover:text-white" onClick={() => navigate(`/admin/users/${item.id}`)}>详情</Button>
                        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground hover:text-white" disabled={busy} onClick={() => forceLogout(item.id)}>
                          <LogOut className="size-3.5" />下线
                        </Button>
                        <Select value={item.role} onValueChange={(value) => patchUser(item.id, { role: value })}>
                          <SelectTrigger className="h-8 w-24 border bg-transparent text-xs text-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">user</SelectItem>
                            <SelectItem value="admin">admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={busy || item.id === me?.id} onClick={() => removeUser(item.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!filteredUsers.length && <p className="py-6 text-center text-sm text-muted-foreground">没有匹配用户</p>}
          </Panel>
        </div>
      )}

      {section === 'user-detail' && userDetail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="hover:bg-accent" onClick={() => navigate('/admin/users')}>返回列表</Button>
            <Button size="sm" variant="outline" className="hover:bg-accent" disabled={busy} onClick={() => forceLogout(userDetail.user.id)}>
              <LogOut className="size-3.5" />强制下线全部会话
            </Button>
            <Button size="sm" variant="outline" className="border-red-500/30 bg-transparent text-red-300 hover:bg-red-500/10" disabled={busy || userDetail.user.id === me?.id} onClick={() => removeUser(userDetail.user.id)}>
              删除用户
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="账号信息" className="lg:col-span-1">
              <div className="space-y-3 text-sm">
                <div><div className="text-muted-foreground">用户名</div><div className="mt-0.5 font-medium">{userDetail.user.username}</div></div>
                <div><div className="text-muted-foreground">邮箱</div><div className="mt-0.5">{userDetail.user.email}</div></div>
                <div><div className="text-muted-foreground">角色</div>
                  <Select value={userDetail.user.role} onValueChange={(value) => patchUser(userDetail.user.id, { role: value })}>
                    <SelectTrigger className='mt-1'><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">普通用户</SelectItem>
                      <SelectItem value="admin">管理员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><div className="text-muted-foreground">最近登录</div><div className="mt-0.5">{fmtTime(userDetail.user.lastLoginAt)}</div></div>
                <div><div className="text-muted-foreground">创建 / 更新</div><div className="mt-0.5 text-muted-foreground">{fmtTime(userDetail.user.createdAt)} · {fmtTime(userDetail.user.updatedAt)}</div></div>
                <div>
                  <Label className={labelClass}>重置密码</Label>
                  <div className="mt-1 flex gap-2">
                    <Input id="reset-pass" type="password" placeholder="新密码至少 8 位" />
                    <Button
                      variant="outline"
                      className="hover:bg-accent"
                      disabled={busy}
                      onClick={() => {
                        const el = document.getElementById('reset-pass');
                        const password = el?.value || '';
                        if (password.length < 8) {
                          toast.error('密码至少 8 位');
                          return;
                        }
                        patchUser(userDetail.user.id, { password }).then(() => { if (el) el.value = ''; });
                      }}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="活跃会话" description="强制下线会提升 session_version 并清空会话" className="lg:col-span-2">
              <div className="space-y-2">
                {(userDetail.sessions || []).map((session) => (
                  <div key={session.jti} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium">{session.jti.slice(0, 8)}…</div>
                      <div className="text-xs text-muted-foreground">
                        创建 {fmtTime(session.createdAt)} · 最近 {fmtTime(session.lastSeenAt)}
                        {session.ip ? ` · ${session.ip}` : ''}
                      </div>
                      {session.userAgent ? <div className="mt-1 max-w-xl truncate text-[11px] text-muted-foreground">{session.userAgent}</div> : null}
                    </div>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => revokeSession(userDetail.user.id, session.jti)}>撤销</Button>
                  </div>
                ))}
                {!(userDetail.sessions || []).length && <p className="text-sm text-muted-foreground">当前无活跃会话</p>}
              </div>
            </Panel>
          </div>

          <Panel
            title="关联邮箱"
            description={userDetail.workspaceShared
              ? '当前工作区邮箱多为共享配置；按邮箱地址与用户邮箱匹配展示。'
              : '按 ownerUserId 或邮箱地址关联。'}
          >
            <div className="space-y-2">
              {(userDetail.mailboxes || []).map((mailbox) => (
                <div key={mailbox.id} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">[{mailbox.tagLabel}] {mailbox.email || mailbox.id}</span>
                    <Badge variant="outline" className="border">{mailbox.linkedBy === 'owner' ? '归属' : '邮箱匹配'}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    日程 {mailbox.events ?? 0} · 邮件 {mailbox.emails ?? 0} · 待办 {mailbox.tasks ?? 0} · 日志 {mailbox.traces ?? 0}
                  </div>
                </div>
              ))}
              {!(userDetail.mailboxes || []).length && <p className="text-sm text-muted-foreground">该用户暂无关联邮箱</p>}
            </div>
          </Panel>
        </div>
      )}

      {section === 'mailboxes' && (
        <Panel title="邮箱管理" description="工作区邮箱与数据量；可在「模型与工作区」中增删改配置">
          <Table>
            <TableHeader>
              <TableRow className="border hover:bg-transparent">
                <TableHead className="text-muted-foreground">邮箱</TableHead>
                <TableHead className="text-muted-foreground">标签</TableHead>
                <TableHead className="text-muted-foreground">归属用户</TableHead>
                <TableHead className="text-muted-foreground">数据</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mailboxes.map((item) => (
                <TableRow key={item.id} className="border hover:bg-muted/40">
                  <TableCell>
                    <div className="font-medium">{item.email || item.id}</div>
                    <div className="text-xs text-muted-foreground">{item.provider} · {item.id}</div>
                  </TableCell>
                  <TableCell>{item.tagLabel}</TableCell>
                  <TableCell>
                    {item.ownerUsername ? (
                      <Link className="text-primary hover:underline" to={`/admin/users/${item.ownerUserId}`}>{item.ownerUsername}</Link>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    日程 {item.events} · 邮件 {item.emails} · 待办 {item.tasks} · 日志 {item.traces}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!mailboxes.length && <p className="py-6 text-center text-sm text-muted-foreground">暂无邮箱</p>}
          <div className="mt-4">
            <Button variant="outline" className="hover:bg-accent" onClick={() => navigate('/admin/workspace')}>
              编辑工作区邮箱配置
            </Button>
          </div>
        </Panel>
      )}

      {section === 'storage' && infraForm && (
        <Panel
          title="本地存储（推荐）"
          description="默认本机：users.json / 内存 Redis / 进程队列。可接本机 PostgreSQL、Redis；不必上云。大厂线上多用托管库，但本 demo 本地更合适。"
        >
          <div className="mb-4 flex flex-wrap gap-2">
            {Object.entries(status).map(([key, value]) => (
              <Badge key={key} variant="outline" className="border text-muted-foreground">
                {key}: {value?.mode || (value?.ok ? 'ok' : 'error')}
              </Badge>
            ))}
          </div>

          <section className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">PostgreSQL（本机）</h3>
                <p className="text-xs text-muted-foreground">未启用时用户落在 data/users.json</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={Boolean(infraForm.postgres.enabled)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, enabled: Boolean(checked) } }))} />
                启用
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="connectionString（可选）" value={infraForm.postgres.connectionString || ''} onChange={(e) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, connectionString: e.target.value } }))} />
              <Input placeholder="host 默认 127.0.0.1" value={infraForm.postgres.host || ''} onChange={(e) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, host: e.target.value } }))} />
              <Input placeholder="database" value={infraForm.postgres.database || ''} onChange={(e) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, database: e.target.value } }))} />
              <Input placeholder="user" value={infraForm.postgres.user || ''} onChange={(e) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, user: e.target.value } }))} />
              <Input type="password" placeholder="password" value={infraForm.postgres.password || ''} onChange={(e) => setInfraForm((c) => ({ ...c, postgres: { ...c.postgres, password: e.target.value } }))} />
            </div>
          </section>

          <section className="mt-4 space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Redis（本机）</h3>
                <p className="text-xs text-muted-foreground">未启用时用进程内存存验证码与会话</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={Boolean(infraForm.redis.enabled)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, redis: { ...c.redis, enabled: Boolean(checked) } }))} />
                启用
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="url（可选）" value={infraForm.redis.url || ''} onChange={(e) => setInfraForm((c) => ({ ...c, redis: { ...c.redis, url: e.target.value } }))} />
              <Input placeholder="host 默认 127.0.0.1" value={infraForm.redis.host || ''} onChange={(e) => setInfraForm((c) => ({ ...c, redis: { ...c.redis, host: e.target.value } }))} />
              <Input type="password" placeholder="password" value={infraForm.redis.password || ''} onChange={(e) => setInfraForm((c) => ({ ...c, redis: { ...c.redis, password: e.target.value } }))} />
            </div>
          </section>

          <section className="mt-4 space-y-3 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">消息队列</h3>
                <p className="text-xs text-muted-foreground">当前推荐 RabbitMQ（Docker：5672 / 管理台 15672）</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={Boolean(infraForm.mq.enabled)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, enabled: Boolean(checked) } }))} />
                启用
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Select value={infraForm.mq.provider || 'rabbitmq'} onValueChange={(value) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, provider: value } }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rabbitmq">RabbitMQ（推荐）</SelectItem>
                  <SelectItem value="local">本地进程队列</SelectItem>
                  <SelectItem value="urocketmq">URocketMQ（预留）</SelectItem>
                  <SelectItem value="ukafka">UKafka（预留）</SelectItem>
                </SelectContent>
              </Select>
              <Input placeholder="amqp url（可选，优先）" value={infraForm.mq.url || ''} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, url: e.target.value } }))} />
              <Input placeholder="host" value={infraForm.mq.host || ''} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, host: e.target.value } }))} />
              <Input type="number" placeholder="port" value={infraForm.mq.port || 5672} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, port: Number(e.target.value) || 5672 } }))} />
              <Input placeholder="user" value={infraForm.mq.user || ''} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, user: e.target.value } }))} />
              <Input type="password" placeholder="password（已配置可留空）" value={infraForm.mq.password || ''} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, password: e.target.value } }))} />
              <Input placeholder="vhost" value={infraForm.mq.vhost || '/'} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, vhost: e.target.value } }))} />
              <Input placeholder="topicPrefix" value={infraForm.mq.topicPrefix || 'daylight'} onChange={(e) => setInfraForm((c) => ({ ...c, mq: { ...c.mq, topicPrefix: e.target.value } }))} />
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={testMq}>连通性测试</Button>
          </section>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={saveInfra}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存存储配置
            </Button>
          </div>
        </Panel>
      )}

      {section === 'oss' && infraForm && (
        <Panel
          title="对象存储"
          description="路径：users/{用户名}/mailboxes/{邮箱ID}/{日期}/{uuid}-文件名。支持阿里云 / 七牛 / 又拍云 / US3 / 本地。"
        >
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <h3 className="font-medium">启用对象存储</h3>
              <p className="text-xs text-muted-foreground">邮件同步时附件自动上传；详情页可预览 / 下载</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={Boolean(infraForm.oss.enabled)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, enabled: Boolean(checked) } }))} />
              启用
            </label>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Select
              value={infraForm.oss.provider || 'aliyun'}
              onValueChange={(value) => setInfraForm((c) => {
                const presets = {
                  aliyun: {
                    endpoint: 'https://oss-cn-beijing.aliyuncs.com',
                    region: 'oss-cn-beijing',
                    publicBaseUrl: c.oss.bucket ? `https://${c.oss.bucket}.oss-cn-beijing.aliyuncs.com` : c.oss.publicBaseUrl,
                  },
                  qiniu: { endpoint: 'https://upload.qiniup.com', region: 'z0' },
                  upyun: { endpoint: 'https://v0.api.upyun.com', region: '' },
                  us3: { region: c.oss.region || 'cn-bj' },
                  s3: { endpoint: c.oss.endpoint || 'https://s3.amazonaws.com', region: 'us-east-1' },
                  tencent: { endpoint: 'https://cos.ap-beijing.myqcloud.com', region: 'ap-beijing' },
                  huawei: { endpoint: 'https://obs.cn-north-4.myhuaweicloud.com', region: 'cn-north-4' },
                  baidu: { endpoint: 'https://bj.bcebos.com', region: 'bj' },
                  volcengine: { endpoint: 'https://tos-cn-beijing.volces.com', region: 'cn-beijing' },
                  minio: { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1' },
                  cloudflare: { endpoint: 'https://<accountid>.r2.cloudflarestorage.com', region: 'auto' },
                  local: {},
                };
                return { ...c, oss: { ...c.oss, provider: value, ...(presets[value] || {}) } };
              })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(ossProviders.length ? ossProviders : [
                  { id: 'aliyun', label: '阿里云 OSS', ready: true },
                  { id: 'qiniu', label: '七牛云 Kodo', ready: true },
                  { id: 'upyun', label: '又拍云 USS', ready: true },
                  { id: 'us3', label: 'UCloud US3', ready: true },
                  { id: 's3', label: 'AWS S3 / 兼容', ready: true },
                  { id: 'tencent', label: '腾讯云 COS', ready: false },
                  { id: 'huawei', label: '华为云 OBS', ready: false },
                  { id: 'baidu', label: '百度云 BOS', ready: false },
                  { id: 'volcengine', label: '火山引擎 TOS', ready: false },
                  { id: 'minio', label: 'MinIO', ready: false },
                  { id: 'cloudflare', label: 'Cloudflare R2', ready: false },
                  { id: 'local', label: '本地 attachments', ready: true },
                ]).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}{item.ready === false ? '（即将支持）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="endpoint / 上传域名" value={infraForm.oss.endpoint || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, endpoint: e.target.value } }))} />
            <Input placeholder="bucket / 服务名" value={infraForm.oss.bucket || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, bucket: e.target.value } }))} />
            <Input placeholder="region" value={infraForm.oss.region || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, region: e.target.value } }))} />
            <Input placeholder="publicBaseUrl（下载/CDN 域名）" value={infraForm.oss.publicBaseUrl || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, publicBaseUrl: e.target.value } }))} />
            <Input placeholder="AccessKey / Operator" value={infraForm.oss.accessKey || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, accessKey: e.target.value } }))} />
            <Input type="password" placeholder="Secret / Password（已配置可留空）" value={infraForm.oss.secretKey || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, secretKey: e.target.value } }))} />
            <Input placeholder="localDir 回退目录" value={infraForm.oss.localDir || ''} onChange={(e) => setInfraForm((c) => ({ ...c, oss: { ...c.oss, localDir: e.target.value } }))} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={saveInfra}>
              <Save className="size-4" />保存对象存储
            </Button>
            <Button variant="outline" disabled={busy} onClick={testOss}>连通性测试</Button>
          </div>
        </Panel>
      )}

      {section === 'mail' && infraForm && (
        <div className="space-y-4">
          <Panel title="系统发信 SMTP" description="注册 / 找回密码 / 通知等邮件均经此 SMTP 发出">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <Switch checked={Boolean(infraForm.systemMail.enabled)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, enabled: checked } }))} />
                启用系统发信
              </label>
              <div className="space-y-2">
                <Label>SMTP Host</Label>
                <Input value={infraForm.systemMail.host || ''} onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, host: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <Label>端口</Label>
                <Input type="number" value={infraForm.systemMail.port || 465} onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, port: Number(e.target.value) || 465 } }))} />
              </div>
              <div className="space-y-2">
                <Label>发信账号</Label>
                <Input value={infraForm.systemMail.user || ''} onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, user: e.target.value } }))} />
              </div>
              <div className="space-y-2">
                <Label>授权码</Label>
                <Input type="password" value={infraForm.systemMail.pass || ''} onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, pass: e.target.value } }))} placeholder="已配置可留空保留" />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>From（可选）</Label>
                <Input value={infraForm.systemMail.from || ''} onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, from: e.target.value } }))} />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>站点公网地址（找回密码链接用）</Label>
                <Input
                  placeholder="http://127.0.0.1:3000"
                  value={infraForm.systemMail.publicBaseUrl || ''}
                  onChange={(e) => setInfraForm((c) => ({ ...c, systemMail: { ...c.systemMail, publicBaseUrl: e.target.value } }))}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>管理员邮箱名单（每行一个）</Label>
                <Textarea
                  rows={3}
                  value={infraForm.auth.adminEmailsText ?? (infraForm.auth.adminEmails || []).join('\n')}
                  onChange={(e) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, adminEmailsText: e.target.value } }))}
                />
              </div>
              <Button className="md:col-span-2" disabled={busy} onClick={saveInfra}>
                <Save className="size-4" />保存 SMTP
              </Button>
            </div>
          </Panel>

          {mailTemplates ? (
            <Panel
              title="邮件模板"
              description="占位符：{{code}} {{email}} {{username}} {{minutes}} {{resetUrl}} {{title}} {{body}} {{version}}"
              actions={(
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={previewTemplate}>预览</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={sendTestTemplate}>发测试信</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={resetTemplates}>恢复默认</Button>
                </div>
              )}
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {mailTemplateMeta.map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant={activeTemplateId === item.id ? 'default' : 'outline'}
                    onClick={() => setActiveTemplateId(item.id)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              {mailTemplateMeta.find((item) => item.id === activeTemplateId) ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  {mailTemplateMeta.find((item) => item.id === activeTemplateId)?.description}
                  {' · 变量 '}
                  {(mailTemplateMeta.find((item) => item.id === activeTemplateId)?.vars || []).map((v) => `{{${v}}}`).join(' ')}
                </p>
              ) : null}
              <div className="grid gap-3">
                <div className="space-y-2">
                  <Label>主题</Label>
                  <Input
                    value={mailTemplates[activeTemplateId]?.subject || ''}
                    onChange={(e) => setMailTemplates((c) => ({
                      ...c,
                      [activeTemplateId]: { ...c[activeTemplateId], subject: e.target.value },
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>纯文本</Label>
                  <Textarea
                    rows={4}
                    value={mailTemplates[activeTemplateId]?.text || ''}
                    onChange={(e) => setMailTemplates((c) => ({
                      ...c,
                      [activeTemplateId]: { ...c[activeTemplateId], text: e.target.value },
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>HTML</Label>
                  <Textarea
                    rows={6}
                    value={mailTemplates[activeTemplateId]?.html || ''}
                    onChange={(e) => setMailTemplates((c) => ({
                      ...c,
                      [activeTemplateId]: { ...c[activeTemplateId], html: e.target.value },
                    }))}
                  />
                </div>
                <Button disabled={busy} onClick={saveMailTemplates}>
                  <Save className="size-4" />保存模板
                </Button>
              </div>
            </Panel>
          ) : null}
        </div>
      )}

      {section === 'onboarding' && (
        <Panel
          title="新手引导"
          description="维护工作区用法步骤。启用 PostgreSQL 时写入数据库（app_settings），并缓存到本地 JSON；未开 PG 时仅 JSON。audience=all/hr/personal；selector 对应页面 data-tour。"
          actions={(
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const id = `step_${Date.now().toString(36)}`;
                  setOnboardingSteps((current) => [...current, {
                    id,
                    audience: 'all',
                    title: '新步骤',
                    text: '',
                    tips: [],
                    path: '/app',
                    selector: '[data-tour="overview"]',
                  }]);
                  setActiveOnboardingId(id);
                }}
              >
                <Plus className="size-3.5" />添加步骤
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={resetOnboardingGuide}>恢复默认</Button>
              <Button size="sm" disabled={busy} onClick={saveOnboardingGuide}>
                <Save className="size-3.5" />保存
              </Button>
            </div>
          )}
        >
          {!onboardingSteps.length ? (
            <p className="text-sm text-muted-foreground">暂无步骤，可恢复默认或手动添加。</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
              <div className="flex flex-col gap-1">
                {onboardingSteps.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    className={cn(
                      'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      activeOnboardingId === step.id ? 'border-primary bg-primary/10' : 'hover:bg-muted/50',
                    )}
                    onClick={() => setActiveOnboardingId(step.id)}
                  >
                    <div className="font-medium">{index + 1}. {step.title || step.id}</div>
                    <div className="text-[11px] text-muted-foreground">{step.audience || 'all'} · {step.id}</div>
                  </button>
                ))}
              </div>
              {(() => {
                const step = onboardingSteps.find((item) => item.id === activeOnboardingId) || onboardingSteps[0];
                if (!step) return null;
                return (
                  <div className="space-y-3 rounded-lg border p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>步骤 id</Label>
                        <Input
                          value={step.id}
                          onChange={(e) => {
                            const nextId = e.target.value;
                            setOnboardingSteps((current) => current.map((item) => (
                              item.id === step.id ? { ...item, id: nextId } : item
                            )));
                            setActiveOnboardingId(nextId);
                          }}
                        />
                      </div>

                      <div className="space-y-2 sm:col-span-2">
                        <Label>标题</Label>
                        <Input value={step.title || ''} onChange={(e) => patchOnboardingStep(step.id, { title: e.target.value })} />
                      </div>
                      <div className="space-y-2">
                        <Label>跳转路径</Label>
                        <Input value={step.path || ''} onChange={(e) => patchOnboardingStep(step.id, { path: e.target.value })} placeholder="/app/settings" />
                      </div>
                      <div className="space-y-2">
                        <Label>高亮选择器</Label>
                        <Input value={step.selector || ''} onChange={(e) => patchOnboardingStep(step.id, { selector: e.target.value })} placeholder='[data-tour="settings"]' />
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <Label>正文</Label>
                        <Textarea rows={4} value={step.text || ''} onChange={(e) => patchOnboardingStep(step.id, { text: e.target.value })} />
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <Label>提示（每行一条）</Label>
                        <Textarea
                          rows={3}
                          value={(step.tips || []).join('\n')}
                          onChange={(e) => patchOnboardingStep(step.id, {
                            tips: e.target.value.split(/\n+/).map((line) => line.trim()).filter(Boolean),
                          })}
                        />
                      </div>
                    </div>
                    <div className="flex justify-between gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={onboardingSteps.length <= 1 || busy}
                        onClick={() => {
                          const next = onboardingSteps.filter((item) => item.id !== step.id);
                          setOnboardingSteps(next);
                          setActiveOnboardingId(next[0]?.id || '');
                        }}
                      >
                        <Trash2 className="size-3.5" />删除此步
                      </Button>
                      <Button type="button" size="sm" disabled={busy} onClick={saveOnboardingGuide}>
                        <Save className="size-3.5" />保存全部
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Panel>
      )}

      {section === 'workspace' && settingsForm && (
        <Panel title="模型与工作区" description="全局模型、邮箱列表与同步策略">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label className={labelClass}>模型 Base URL</Label>
              <Input value={settingsForm.baseUrl || ''} onChange={(e) => setSettingsForm((c) => ({ ...c, baseUrl: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label className={labelClass}>模型名</Label>
              <Input value={settingsForm.model || ''} onChange={(e) => setSettingsForm((c) => ({ ...c, model: e.target.value }))} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label className={labelClass}>API Key</Label>
              <Input type="password" value={settingsForm.apiKey || ''} onChange={(e) => setSettingsForm((c) => ({ ...c, apiKey: e.target.value }))} placeholder="已配置可留空保留" />
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">邮箱列表</h3>
              <Button
                size="sm"
                variant="outline"
                className="hover:bg-accent"
                onClick={() => setSettingsForm((c) => ({
                  ...c,
                  mailboxes: [...(c.mailboxes || []), {
                    id: `mb_${Date.now()}`,
                    email: '',
                    provider: 'qq',
                    tag: 'work',
                    fetchLimit: 15,
                  }],
                }))}
              >
                <Plus className="size-3.5" />添加邮箱
              </Button>
            </div>
            {(settingsForm.mailboxes || []).map((mailbox, index) => (
              <div key={mailbox.id || index} className="grid gap-2 rounded-lg border p-3 md:grid-cols-3">
                <Input placeholder="邮箱" value={mailbox.email || ''} onChange={(e) => setSettingsForm((c) => {
                  const mailboxes = [...(c.mailboxes || [])];
                  mailboxes[index] = { ...mailboxes[index], email: e.target.value };
                  return { ...c, mailboxes };
                })} />
                <Input placeholder="ownerUserId（可选）" value={mailbox.ownerUserId || ''} onChange={(e) => setSettingsForm((c) => {
                  const mailboxes = [...(c.mailboxes || [])];
                  mailboxes[index] = { ...mailboxes[index], ownerUserId: e.target.value };
                  return { ...c, mailboxes };
                })} />
                <div className="flex gap-2">
                  <Select value={mailbox.tag || 'work'} onValueChange={(value) => setSettingsForm((c) => {
                    const mailboxes = [...(c.mailboxes || [])];
                    mailboxes[index] = { ...mailboxes[index], tag: value };
                    return { ...c, mailboxes };
                  })}>
                    <SelectTrigger ><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="work">工作</SelectItem>
                      <SelectItem value="personal">个人</SelectItem>
                      <SelectItem value="life">生活</SelectItem>
                      <SelectItem value="custom">自定义</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => setSettingsForm((c) => ({
                      ...c,
                      mailboxes: (c.mailboxes || []).filter((_, i) => i !== index),
                    }))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button className="mt-4" disabled={busy} onClick={saveSettings}>
            <Save className="size-4" />保存工作区
          </Button>
        </Panel>
      )}

      {section === 'auth' && infraForm && (
        <Panel title="认证门禁">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label className={labelClass}>JWT Secret</Label>
              <Input type="password" value={infraForm.auth.jwtSecret || ''} onChange={(e) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, jwtSecret: e.target.value } }))} />
            </div>
            <div className="space-y-2">
              <Label className={labelClass}>会话天数</Label>
              <Input type="number" value={infraForm.auth.sessionDays || 14} onChange={(e) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, sessionDays: Number(e.target.value) || 14 } }))} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={Boolean(infraForm.auth.requireAuth)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, requireAuth: checked } }))} />
              API 强制鉴权（前端 /app 始终需要登录）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={Boolean(infraForm.auth.allowLocalDemoLogin)} onCheckedChange={(checked) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, allowLocalDemoLogin: checked } }))} />
              本地演示（回传验证码明文）
            </label>
            <div className="space-y-2 md:col-span-2">
              <Label className={labelClass}>管理员邮箱名单（每行一个）</Label>
              <Textarea
                rows={4}
                value={infraForm.auth.adminEmailsText ?? (infraForm.auth.adminEmails || []).join('\n')}
                onChange={(e) => setInfraForm((c) => ({ ...c, auth: { ...c.auth, adminEmailsText: e.target.value } }))}
              />
            </div>
            <Button className="md:col-span-2" disabled={busy} onClick={saveInfra}>
              <Save className="size-4" />保存
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
