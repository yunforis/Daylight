import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, HardDrive, Mail, Search, Server, Settings2, Shield, Sparkles, Users, Workflow,
} from 'lucide-react';
import { HighlightText } from '@/components/command-palette';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { authRequest } from '@/lib/auth-api';
import { cn } from '@/lib/utils';

const GROUP_ICONS = {
  操作: Sparkles,
  导航: Shield,
  系统配置: Server,
  用户: Users,
  邮箱: Mail,
  邮件模板: Mail,
  队列任务: Activity,
  处理日志: Workflow,
  默认: Search,
};

function matchQuery(query, item) {
  if (!query) return true;
  const hay = [item.label, item.hint, item.group, item.keywords, item.path]
    .filter(Boolean)
    .join('\u0001')
    .toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

export function AdminCommandPalette({ open, onOpenChange, onOpenLittleD }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState({ items: [] });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
      setLoadError('');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    authRequest('/admin/search')
      .then((data) => {
        if (!cancelled) setIndex({ items: data.items || [] });
      })
      .catch((error) => {
        if (!cancelled) {
          setIndex({ items: [] });
          setLoadError(error.message || '搜索索引加载失败；若刚更新代码请重启 npm run dev');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  const actions = useMemo(() => {
    const q = query.trim();
    const items = (index.items || []).filter((item) => matchQuery(q, item));
    const preferred = ['操作', '导航', '系统配置', '用户', '邮箱', '邮件模板', '队列任务', '处理日志'];
    if (!q) {
      items.sort((a, b) => preferred.indexOf(a.group) - preferred.indexOf(b.group));
      return items.slice(0, 60);
    }
    return items.slice(0, 150);
  }, [index, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of actions) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group).push(item);
    }
    return [...map.entries()];
  }, [actions]);

  useEffect(() => { setActive(0); }, [query, open]);

  function runItem(item) {
    if (!item) return;
    onOpenChange?.(false);
    if (item.action === 'open-little-d') {
      onOpenLittleD?.();
      return;
    }
    if (item.path) navigate(item.path);
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(actions.length - 1, value + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(actions[active]);
    }
  }

  let flatIndex = -1;
  const highlightQuery = query.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>管理端全局搜索</DialogTitle>
          <DialogDescription>搜索用户、邮箱、系统配置、队列、日志与页面</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索用户 / 邮箱 / 认证 / OSS / 队列 / 模板 / 页面…"
            className="h-12 border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[min(70vh,520px)] overflow-auto p-2">
          {loading && !actions.length ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">正在加载索引…</p>
          ) : loadError ? (
            <p className="px-2 py-6 text-center text-sm text-destructive">{loadError}</p>
          ) : actions.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">没有匹配结果</p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} className="mb-2">
                <div className="px-3 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {group}
                </div>
                {list.map((item) => {
                  flatIndex += 1;
                  const indexNum = flatIndex;
                  const Icon = GROUP_ICONS[item.group] || GROUP_ICONS.默认;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm',
                        indexNum === active ? 'bg-muted' : 'hover:bg-muted/60',
                      )}
                      onMouseEnter={() => setActive(indexNum)}
                      onClick={() => runItem(item)}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <HighlightText text={item.label} query={highlightQuery} className="block truncate font-medium" />
                        {item.hint ? (
                          <HighlightText
                            text={item.hint}
                            query={highlightQuery}
                            className="block truncate text-[11px] text-muted-foreground"
                          />
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{item.group}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
          ↑↓ 选择 · Enter 打开 · Esc 关闭 · 含用户/邮箱/配置/队列/日志 · 已高亮
          <HardDrive className="ml-1 inline size-3 opacity-60" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
