import { useEffect, useRef, useState } from 'react';
import { request } from '@/lib/api';
import { ChevronRight, LoaderCircle, Send, Sparkles } from 'lucide-react';
import { AgentThinkingChain } from '@/components/agent-thinking';
import { RichMarkdown } from '@/components/rich-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';

export function WorkbenchAgent({
  title = '助手',
  description = '说出想做的事。助手只给出草稿和建议，不会代替你发出。',
  examples = [],
  messages = [],
  asking = false,
  value = '',
  onChange,
  onSend,
  onExample,
  placeholder = '例如：帮我写一封回复',
  footer = 'Enter 发送 · Shift + Enter 换行',
  note = '',
}) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, asking]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <Sparkles className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <Badge variant={asking ? 'default' : 'secondary'}>{asking ? '执行中' : '随时可以聊'}</Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {!messages.length && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <h3 className="text-lg font-medium">{title}</h3>
              <p className="text-sm text-muted-foreground">{description}</p>
              <div className="space-y-2">
                {examples.map((example) => (
                  <button key={example} type="button" className="flex w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => onExample?.(example)}>
                    <span className="min-w-0 flex-1">{example}</span>
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`space-y-2 rounded-lg border p-3 ${message.role === 'user' ? 'bg-primary/5' : 'bg-background'}`}>
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {message.role === 'user' ? '你' : <><Sparkles className="size-3" />{title}</>}
              </div>
              {message.role === 'user' ? (
                <div className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</div>
              ) : (
                <RichMarkdown>{message.content}</RichMarkdown>
              )}
              {message.steps?.length ? (
                <AgentThinkingChain toolTrace={message.steps} title="起草" />
              ) : null}
            </article>
          ))}
          {asking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-3.5 animate-spin" />
              助手正在写…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      <form className="space-y-2 border-t p-4" onSubmit={onSend}>
        <div className="rounded-xl border bg-muted/20 p-2">
          <Textarea
            aria-label={`向${title}发送消息`}
            value={value}
            rows={3}
            placeholder={placeholder}
            className="min-h-[4.5rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            onChange={(event) => onChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSend?.(event);
              }
            }}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
            <span className="text-xs text-muted-foreground">{footer}</span>
            <Button size="sm" disabled={!value.trim() || asking} type="submit">
              {asking ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              发送
            </Button>
          </div>
        </div>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </form>
    </div>
  );
}

export function WorkbenchChat({ workbenchId, title = '工作台助手', description = '按这个工作台的规则帮你整理下一步。发送和写入仍要你确认。' }) {
  const [messages, setMessages] = useState([]);
  const [value, setValue] = useState('');
  const [asking, setAsking] = useState(false);
  const send = async (event) => {
    event?.preventDefault?.();
    const text = value.trim();
    if (!text || asking) return;
    const history = messages.slice(-6).map((item) => ({ role: item.role, content: item.content }));
    setValue('');
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }]);
    setAsking(true);
    try {
      const reply = await request(`/scenarios/workbenches/${workbenchId}/assistant`, 'POST', { message: text, history });
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: reply.answer || '已整理好，请再核对。' }]);
    } catch (error) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: error.message || '暂时无法回答。' }]);
    } finally { setAsking(false); }
  };
  return (
    <div className="h-[32rem] overflow-hidden rounded-xl border">
      <WorkbenchAgent title={title} description={description} messages={messages} asking={asking} value={value} onChange={setValue} onSend={send} onExample={setValue} examples={['下一步该准备什么？', '帮我写一封待确认的回复']} />
    </div>
  );
}
