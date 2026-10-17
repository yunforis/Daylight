import React, { useEffect, useRef, useState } from 'react';
import {
  LoaderCircle, SendHorizontal, Shield, Sparkles, Target, X,
} from 'lucide-react';
import { AgentThinkingChain } from '@/components/agent-thinking';
import { RichMarkdown } from '@/components/rich-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { getAuthToken } from '@/lib/auth-api';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  '系统现在整体健康吗？',
  '列出全部用户和角色',
  '最近有哪些失败的处理日志？',
  '测试对象存储和消息队列连通性',
  '管理端小 D 能调用哪些接口？',
];

const RISK_LABEL = {
  read: '只读查询',
  write: '写操作',
  dangerous: '危险操作',
};

const WELCOME = {
  role: 'assistant',
  content: '我是管理端小 D。可以查询运维监控、用户与邮箱、基础设施与邮件模板，并在确认后执行管理操作。每次会先做意图识别，再展示工具执行步骤。',
};

async function streamAdminChat(messages, { onEvent, signal } = {}) {
  const response = await fetch('/api/admin/assistant/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
    body: JSON.stringify({ messages, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const fallback = await fetch('/api/admin/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      },
      body: JSON.stringify({ messages, stream: false }),
      signal,
    });
    const result = await fallback.json().catch(() => ({}));
    if (!fallback.ok) throw new Error(result.error || '管理助手请求失败');
    onEvent?.({ type: 'done', ...result });
    return result;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(6));
        onEvent?.(event);
        if (event.type === 'done') finalResult = event;
        if (event.type === 'error') throw new Error(event.message || '管理助手失败');
      } catch (error) {
        if (error.message && !/JSON/.test(error.message)) throw error;
      }
    }
  }
  if (finalResult) return finalResult;
  const fallback = await fetch('/api/admin/assistant/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
    },
    body: JSON.stringify({ messages, stream: false }),
  });
  const result = await fallback.json().catch(() => ({}));
  if (!fallback.ok) throw new Error(result.error || '管理助手请求失败');
  onEvent?.({ type: 'done', ...result });
  return result;
}

function IntentCard({ intent }) {
  if (!intent?.intent) return null;
  return (
    <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
        <Target className="size-3.5 text-primary" />
        意图识别
        <Badge variant="outline" className="font-normal">{intent.category || 'other'}</Badge>
        <Badge
          variant={intent.risk === 'dangerous' ? 'destructive' : intent.risk === 'write' ? 'secondary' : 'outline'}
          className="font-normal"
        >
          {RISK_LABEL[intent.risk] || intent.risk || 'read'}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed">{intent.intent}</p>
      {Array.isArray(intent.plan) && intent.plan.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
          {intent.plan.map((step, index) => (
            <li key={`${step}-${index}`}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AdminLittleD({ open, onOpenChange }) {
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTrace, setLiveTrace] = useState([]);
  const [liveStatus, setLiveStatus] = useState('');
  const [liveIntent, setLiveIntent] = useState(null);
  const [liveCost, setLiveCost] = useState(null);
  const bottomRef = useRef(null);
  const pendingRef = useRef(false);
  const epochRef = useRef(0);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, busy, liveTrace, liveStatus, liveIntent]);

  useEffect(() => {
    function onOpen(event) {
      if (event?.detail?.prompt) setInput(String(event.detail.prompt));
      onOpenChange?.(true);
    }
    window.addEventListener('daylight:open-admin-little-d', onOpen);
    return () => window.removeEventListener('daylight:open-admin-little-d', onOpen);
  }, [onOpenChange]);

  async function send(text) {
    const content = String(text || input).trim();
    if (!content || pendingRef.current) return;
    pendingRef.current = true;
    const epoch = ++epochRef.current;
    const isCurrent = () => epoch === epochRef.current;
    setInput('');
    setBusy(true);
    setLiveTrace([]);
    setLiveIntent(null);
    setLiveCost(null);
    setLiveStatus('正在识别意图…');
    const history = [...messages, { role: 'user', content }];
    setMessages(history);
    try {
      const result = await streamAdminChat(
        history.filter((item) => item.role === 'user' || item.role === 'assistant').map(({ role, content: c }) => ({ role, content: c })),
        {
          onEvent: (event) => {
            if (!isCurrent()) return;
            if (event.type === 'status') setLiveStatus(event.message || '处理中…');
            if (event.type === 'intent') setLiveIntent(event.intent);
            if (event.type === 'tool_start') {
              setLiveTrace((current) => {
                const next = [...current];
                next.push({
                  name: event.name,
                  args: event.args,
                  running: true,
                  kind: event.name === 'declare_intent' ? 'intent' : 'tool',
                });
                return next;
              });
            }
            if (event.type === 'tool_end') {
              setLiveTrace((current) => {
                const next = [...current];
                const index = next.findLastIndex((item) => item.name === event.name && item.running);
                const entry = {
                  name: event.name,
                  args: event.args,
                  result: event.result,
                  latency_ms: event.latency_ms,
                  running: false,
                  ok: event.result?.ok !== false,
                  kind: event.kind || (event.name === 'declare_intent' ? 'intent' : 'tool'),
                };
                if (index >= 0) next[index] = entry;
                else next.push(entry);
                return next;
              });
            }
            if (event.type === 'usage' && event.cost) setLiveCost(event.cost);
            if (event.type === 'done' && (event.cost_cny != null || event.usage)) {
              setLiveCost({
                cost_cny: event.cost_cny,
                cost_status: event.cost_status,
                usage: event.usage,
              });
            }
          },
        },
      );
      if (!isCurrent()) return;
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: result.reply || '好的。',
          toolTrace: result.toolTrace || [],
          intent: result.intent || null,
          cost_cny: result.cost_cny,
          cost_status: result.cost_status,
          usage: result.usage,
        },
      ]);
      setLiveTrace([]);
      setLiveStatus('');
      setLiveIntent(null);
      setLiveCost(null);
    } catch (error) {
      if (!isCurrent()) return;
      const raw = error.message || '管理端小 D 暂时无法回答。';
      const hint = /接口不存在/.test(raw)
        ? `${raw} 管理端助手路由是新加的，请在项目目录重启 \`npm run dev\` 后再试。`
        : raw;
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: hint },
      ]);
      setLiveTrace([]);
      setLiveStatus('');
      setLiveIntent(null);
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setBusy(false);
      }
    }
  }

  if (!open) return null;

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex flex-col items-end gap-3">
      <div
        role="dialog"
        aria-label="管理端小 D"
        className={cn(
          'pointer-events-auto flex h-[min(40rem,calc(100svh-5rem))] w-[min(28rem,calc(100vw-2rem))]',
          'flex-col overflow-hidden rounded-2xl border border-border/80',
          'bg-background/95 shadow-2xl shadow-black/15 backdrop-blur-xl',
        )}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Shield className="size-3.5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">管理端小 D</div>
              <div className="text-[11px] text-muted-foreground">全系统接口 · 意图识别 · 执行步骤</div>
            </div>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="关闭" onClick={() => onOpenChange?.(false)}>
            <X className="size-4" />
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 px-3 py-3">
          <div className="space-y-3">
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[94%] space-y-2 rounded-2xl px-3 py-2 text-sm leading-relaxed',
                    message.role === 'user'
                      ? 'bg-foreground text-background'
                      : 'border bg-card text-card-foreground',
                  )}
                >
                  {message.role === 'user' ? (
                    <div className="whitespace-pre-wrap">{message.content}</div>
                  ) : (
                    <RichMarkdown>{message.content}</RichMarkdown>
                  )}
                  {message.intent && <IntentCard intent={message.intent} />}
                  {message.toolTrace?.length > 0 && (
                    <AgentThinkingChain
                      toolTrace={message.toolTrace}
                      defaultOpen={Boolean(message.intent)}
                      className="bg-background/60"
                      title="执行步骤"
                      cost={message.cost_cny != null || message.usage ? {
                        cost_cny: message.cost_cny,
                        cost_status: message.cost_status,
                        usage: message.usage,
                      } : null}
                    />
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div className="space-y-2 rounded-2xl border bg-card p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  {liveStatus || '管理端小 D 正在处理…'}
                </div>
                {liveIntent && <IntentCard intent={liveIntent} />}
                <AgentThinkingChain
                  toolTrace={liveTrace}
                  running
                  defaultOpen
                  cost={liveCost}
                  title={liveTrace.length ? `执行步骤 · ${liveTrace.length}` : '等待工具调用'}
                />
              </div>
            )}

            {messages.length <= 1 && (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] leading-relaxed text-muted-foreground">管理端小 D 可以查看系统健康、用户与邮箱、处理日志、对象存储和消息队列。写操作和删除会先说明风险，危险操作需要确认后才执行。</p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((item) => (
                  <Button
                    key={item}
                    type="button"
                    disabled={busy}
                    variant="outline"
                    size="xs"
                    className="h-auto whitespace-normal rounded-full px-2.5 py-1 text-left text-[11px] font-normal text-muted-foreground"
                    onClick={() => send(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <form
          className="border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className="flex items-end gap-2 rounded-xl border bg-muted/20 p-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：有多少用户？测试 OSS…（危险操作会要求确认）"
              rows={2}
              className="min-h-[2.5rem] flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="发送">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
            </Button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
            <Sparkles className="mr-1 inline size-3" />
            先意图识别，再逐步调用管理 API；删除用户等须明确确认。
          </p>
        </form>
      </div>
    </div>
  );
}
