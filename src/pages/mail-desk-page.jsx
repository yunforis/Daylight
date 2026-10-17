import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Forward, Inbox, LoaderCircle, Mail, PenLine, Reply, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { WorkbenchAgent } from '@/components/workbench-agent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/context/workspace';
import { request } from '@/lib/api';
import { EMAIL_CATEGORIES } from '@/lib/domain';
import { shortDate, shanghaiDate } from '@/lib/time';
import { EmailHtmlView } from '@/components/email-html-view';

const FOLDERS = [
  { id: 'inbox', label: '收件箱' },
  { id: 'starred', label: '星标' },
  { id: 'sent', label: '已发送' },
  { id: 'drafts', label: '草稿' },
  { id: 'junk', label: '垃圾邮件' },
];
const EXAMPLES = ['帮我回复，说明周五下午可以', '把这封邮件改成更正式的转发说明', '写一封群发通知，主题是本周例会'];

function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

export default function MailDeskPage() {
  const { state, reload, saveSettings } = useWorkspace();
  const mailboxes = (state?.settings?.mailboxes || []).filter((item) => item.email);
  const [mailboxId, setMailboxId] = useState('');
  const mailbox = mailboxes.find((item) => item.id === mailboxId) || mailboxes[0];
  const [folder, setFolder] = useState('inbox');
  const [category, setCategory] = useState('all');
  const [remote, setRemote] = useState([]);
  const [outbound, setOutbound] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [composer, setComposer] = useState(null);
  const [busy, setBusy] = useState('');
  const [signature, setSignature] = useState('');
  const [fromName, setFromName] = useState('');
  const [separate, setSeparate] = useState(false);
  const editorRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!mailboxId && mailboxes[0]) setMailboxId(mailboxes[0].id);
  }, [mailboxes, mailboxId]);
  useEffect(() => {
    setSignature(mailbox?.signature || '');
    setFromName(mailbox?.fromName || '');
  }, [mailbox?.id, mailbox?.signature, mailbox?.fromName]);

  const localMail = useMemo(() => (state?.emails || []).filter((email) => !mailbox || !email.mailboxId || email.mailboxId === mailbox.id), [state?.emails, mailbox]);

  useEffect(() => {
    if (!mailbox) return undefined;
    let stopped = false;
    setLoading(true);
    const load = async () => {
      try {
        const sentBox = await request('/mail/outbound?limit=80', 'GET', undefined, { mailboxId: mailbox.id });
        if (!stopped) setOutbound(sentBox.items || sentBox.outbound || sentBox || []);
        if (['sent', 'drafts', 'junk'].includes(folder)) {
          const preview = await request(`/mail/folder/${folder}`, 'GET', undefined, { mailboxId: mailbox.id });
          if (!stopped) setRemote(preview.messages || []);
        } else if (!stopped) setRemote([]);
      } catch (error) {
        if (!stopped) {
          setRemote([]);
          if (['sent', 'drafts', 'junk'].includes(folder)) toast.error(error.message);
        }
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    load();
    return () => { stopped = true; };
  }, [mailbox?.id, folder]);

  const rows = useMemo(() => {
    if (folder === 'sent') {
      const local = (Array.isArray(outbound) ? outbound : []).filter((item) => item.status === 'sent').map((item) => ({
        id: item.id, kind: 'outbound', title: item.subject || '（无主题）', from: (item.to || []).join(', '), when: item.sentAt, body: item.body, raw: item,
      }));
      return [...local, ...remote.map((item) => ({ id: `imap-${item.uid}`, kind: 'imap', title: item.subject, from: item.from, when: item.date, body: '这封信在邮箱的已发送文件夹里，正文仍以邮箱原文为准。', raw: item }))];
    }
    if (folder === 'drafts') {
      const local = (Array.isArray(outbound) ? outbound : []).filter((item) => item.status === 'draft').map((item) => ({
        id: item.id, kind: 'draft', title: item.subject || '（无主题）', from: (item.to || []).join(', ') || '未填写收件人', when: item.updatedAt, body: item.body, raw: item,
      }));
      return [...local, ...remote.map((item) => ({ id: `imap-${item.uid}`, kind: 'imap', title: item.subject, from: item.from, when: item.date, body: '这封草稿在邮箱草稿箱里。', raw: item }))];
    }
    if (folder === 'junk') {
      return remote.map((item) => ({ id: `imap-${item.uid}`, kind: 'imap', title: item.subject, from: item.from, when: item.date, body: '这封信在垃圾邮件文件夹里。', raw: item }));
    }
    return localMail.filter((email) => {
      if (folder === 'starred' && !email.flagged) return false;
      if (category !== 'all' && (email.category || email.extraction?.category) !== category) return false;
      return true;
    }).map((email) => ({
      id: email.id, kind: 'local', title: email.subject || '（无主题）', from: email.sender || '', when: email.receivedAt, body: email.body || email.summary || '', raw: email,
    }));
  }, [folder, outbound, remote, localMail, category]);

  const openComposer = (seed = {}) => {
    setComposer({ to: '', cc: '', bcc: '', subject: '', html: '<p></p>', draftId: '', ...seed });
    setSeparate(false);
    window.setTimeout(() => {
      if (editorRef.current) editorRef.current.innerHTML = seed.html || '<p></p>';
    }, 0);
  };

  const reply = async (mode) => {
    if (selected?.kind !== 'local') return;
    setBusy('reply');
    try {
      const draft = await request(`/emails/${encodeURIComponent(selected.id)}/reply-draft`, 'POST', { mode }, { mailboxId: mailbox.id });
      const quoted = `<p></p><blockquote>${escapeHtml(selected.body || '').replace(/\n/g, '<br>')}</blockquote>`;
      openComposer({ to: (draft.to || []).join(', '), cc: (draft.cc || []).join(', '), subject: draft.subject || '', html: quoted, inReplyTo: draft.inReplyTo, references: draft.references });
    } catch (error) { toast.error(error.message); }
    finally { setBusy(''); }
  };

  const sendComposer = async (asDraft) => {
    if (!composer || !mailbox) return;
    const html = editorRef.current?.innerHTML || composer.html;
    const payload = { to: composer.to, cc: composer.cc, bcc: composer.bcc, subject: composer.subject, body: html, draft: asDraft, mailboxId: mailbox.id, inReplyTo: composer.inReplyTo, references: composer.references };
    setBusy(asDraft ? 'draft' : 'send');
    try {
      if (composer.draftId) {
        await request(`/mail/outbound/${composer.draftId}/draft`, 'POST', { ...payload, send: !asDraft }, { mailboxId: mailbox.id });
      } else if (separate && !asDraft) {
        const people = String(composer.to || '').split(/[,;，；\n]+/).map((item) => item.trim()).filter(Boolean);
        if (people.length < 2) throw new Error('分别发送至少需要两个收件人。');
        for (const person of people) {
          await request('/mail/compose', 'POST', { ...payload, to: person, cc: '', bcc: '', draft: false }, { mailboxId: mailbox.id });
        }
        toast.success(`已分别排入 ${people.length} 封，发送前有几秒可以撤回`);
      } else {
        const result = await request('/mail/compose', 'POST', payload, { mailboxId: mailbox.id });
        if (asDraft) setComposer((current) => ({ ...current, draftId: result.outbound?.id || '' }));
        toast.success(asDraft ? '已存入草稿' : '已排入发送，几秒内可以在已发送里撤回');
      }
      if (!asDraft) setComposer(null);
      setFolder(asDraft ? 'drafts' : folder);
      const sentBox = await request('/mail/outbound?limit=80', 'GET', undefined, { mailboxId: mailbox.id });
      setOutbound(sentBox.items || sentBox.outbound || sentBox || []);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(''); }
  };

  const toggleStar = async (row) => {
    if (row.kind !== 'local') return;
    const flagged = !row.raw.flagged;
    try {
      await request(`/emails/${encodeURIComponent(row.id)}/mail-action`, 'POST', { action: flagged ? 'flag' : 'unflag' }, { mailboxId: mailbox.id });
    } catch (error) {
      if (error.code !== 'MAIL_WRITE_BACK_DISABLED' && !/写回真实邮箱/.test(error.message || '')) {
        toast.error(error.message);
        return;
      }
      await request(`/emails/${encodeURIComponent(row.id)}/local-flag`, 'POST', { flagged }, { mailboxId: mailbox.id });
      toast.message('星标先记在 Daylight。到设置里打开写回后，会同步到 QQ 或网易邮箱。');
    }
    await reload();
  };

  const moveJunk = async (row) => {
    if (row.kind !== 'local') return;
    setBusy('junk');
    try {
      await request(`/emails/${encodeURIComponent(row.id)}/mail-action`, 'POST', { action: 'junk' }, { mailboxId: mailbox.id });
      toast.success('已移到垃圾邮件');
      await reload();
    } catch (error) { toast.error(error.message); }
    finally { setBusy(''); }
  };

  const saveIdentity = async () => {
    if (!mailbox) return;
    setBusy('sign');
    try {
      await saveSettings({ mailboxId: mailbox.id, email: mailbox.email, provider: mailbox.provider, signature, fromName });
    } catch (error) { toast.error(error.message); }
    finally { setBusy(''); }
  };

  const ask = async (event) => {
    event?.preventDefault?.();
    const text = question.trim();
    if (!text || asking) return;
    const history = messages.slice(-6).map((item) => ({ role: item.role, content: item.content }));
    setQuestion('');
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }]);
    setAsking(true);
    try {
      const reply = await request('/mail/assist', 'POST', {
        message: text,
        history,
        context: selected ? `${selected.title}\n${selected.from}\n${String(selected.body || '').slice(0, 2000)}` : '',
      }, { mailboxId: mailbox?.id });
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: reply.answer || '已写好草稿。' }]);
      if (reply.subject || reply.body) {
        openComposer({ ...(composer || {}), subject: reply.subject || composer?.subject || '', html: reply.body || composer?.html || '<p></p>' });
      }
    } catch (error) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: error.message || '暂时无法起草。' }]);
    } finally { setAsking(false); }
  };

  if (!mailbox) {
    return <div className="p-6 text-sm text-muted-foreground">先在设置里添加邮箱，再打开邮件收发。</div>;
  }

  return (
    <div className="flex h-[calc(100svh-7.5rem)] min-h-[640px] overflow-hidden rounded-xl border bg-card">
      <aside className="flex w-52 shrink-0 flex-col border-r">
        <div className="border-b p-3">
          <div className="text-sm font-medium">邮件收发</div>
          <select className="mt-2 w-full rounded-md border bg-background px-2 py-1.5 text-xs" value={mailbox.id} onChange={(event) => setMailboxId(event.target.value)}>
            {mailboxes.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}
          </select>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
          {FOLDERS.map((item) => (
            <button key={item.id} type="button" className={`flex w-full rounded-md px-2 py-2 text-left text-sm ${folder === item.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`} onClick={() => { setFolder(item.id); setSelected(null); }}>
              {item.label}
            </button>
          ))}
          <div className="px-2 pt-3 text-xs font-medium text-muted-foreground">分类</div>
          <button type="button" className={`flex w-full rounded-md px-2 py-1.5 text-left text-sm ${category === 'all' ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`} onClick={() => { setCategory('all'); setFolder('inbox'); }}>全部</button>
          {Object.entries(EMAIL_CATEGORIES).map(([id, label]) => (
            <button key={id} type="button" className={`flex w-full rounded-md px-2 py-1.5 text-left text-sm ${category === id && folder === 'inbox' ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`} onClick={() => { setCategory(id); setFolder('inbox'); setSelected(null); }}>{label}</button>
          ))}
        </div>
        <div className="space-y-2 border-t p-3">
          <Input value={fromName} onChange={(event) => setFromName(event.target.value)} placeholder="发件人显示名" aria-label="发件人显示名" />
          <textarea className="min-h-16 w-full rounded-md border bg-background px-2 py-1.5 text-xs" value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="邮件签名" aria-label="邮件签名" />
          <Button className="w-full" size="sm" variant="outline" disabled={busy === 'sign'} onClick={saveIdentity}>保存签名</Button>
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Button size="sm" onClick={() => openComposer()}><PenLine className="size-4" />写邮件</Button>
          <Button size="sm" variant="outline" disabled={selected?.kind !== 'local' || Boolean(busy)} onClick={() => reply('reply')}><Reply className="size-4" />回复</Button>
          <Button size="sm" variant="outline" disabled={selected?.kind !== 'local' || Boolean(busy)} onClick={() => reply('reply-all')}><Reply className="size-4" />回复全部</Button>
          <Button size="sm" variant="outline" disabled={!selected} onClick={() => openComposer({ subject: `转发：${selected.title}`, html: `<p></p><blockquote>${escapeHtml(selected.body || '')}</blockquote>` })}><Forward className="size-4" />转发</Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
          <div className="overflow-auto border-r">
            {loading && <div className="p-3 text-xs text-muted-foreground">正在读取…</div>}
            {rows.map((row) => (
              <button key={row.id} type="button" className={`block w-full border-b px-3 py-2 text-left ${selected?.id === row.id ? 'bg-muted' : 'hover:bg-muted/50'}`} onClick={() => { setSelected(row); if (row.kind === 'draft') openComposer({ draftId: row.id, to: (row.raw.to || []).join(', '), cc: (row.raw.cc || []).join(', '), bcc: (row.raw.bcc || []).join(', '), subject: row.raw.subject || '', html: row.raw.body || '<p></p>' }); }}>
                <div className="truncate text-sm font-medium">{row.title}</div>
                <div className="truncate text-xs text-muted-foreground">{row.from}{row.when ? ` · ${shortDate(shanghaiDate(row.when))}` : ''}</div>
              </button>
            ))}
            {!loading && !rows.length && <div className="p-4 text-sm text-muted-foreground">这个文件夹里还没有邮件。</div>}
          </div>
          <div className="min-h-0 overflow-auto p-4">
            {composer ? (
              <div className="space-y-2">
                <Input aria-label="收件人" value={composer.to} placeholder="收件人，多个用逗号分隔" onChange={(event) => setComposer({ ...composer, to: event.target.value })} />
                <Input aria-label="抄送" value={composer.cc} placeholder="抄送" onChange={(event) => setComposer({ ...composer, cc: event.target.value })} />
                <Input aria-label="密送" value={composer.bcc} placeholder="密送" onChange={(event) => setComposer({ ...composer, bcc: event.target.value })} />
                <Input aria-label="主题" value={composer.subject} placeholder="主题" onChange={(event) => setComposer({ ...composer, subject: event.target.value })} />
                <div className="flex flex-wrap gap-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => document.execCommand('bold')}>加粗</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => document.execCommand('italic')}>斜体</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => document.execCommand('insertUnorderedList')}>列表</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => { const url = window.prompt('链接地址'); if (url) document.execCommand('createLink', false, url); }}>链接</Button>
                  <label className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><input type="checkbox" checked={separate} onChange={(event) => setSeparate(event.target.checked)} />分别发送</label>
                </div>
                <div ref={editorRef} className="min-h-56 rounded-md border bg-background p-3 text-sm outline-none" contentEditable role="textbox" aria-label="邮件正文" suppressContentEditableWarning />
                <div className="flex flex-wrap gap-2">
                  <Button disabled={Boolean(busy)} onClick={() => sendComposer(false)}>{busy === 'send' ? <LoaderCircle className="size-4 animate-spin" /> : <Mail className="size-4" />}发送</Button>
                  <Button variant="outline" disabled={Boolean(busy)} onClick={() => sendComposer(true)}><FileText className="size-4" />存草稿</Button>
                  <Button variant="ghost" onClick={() => setComposer(null)}>关闭</Button>
                </div>
              </div>
            ) : selected ? (
              <article className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-medium">{selected.title}</h2>
                  <div className="flex gap-1">
                    {selected.kind === 'local' && <Button size="icon" variant="ghost" aria-label="星标" onClick={() => toggleStar(selected)}><Star className={`size-4 ${selected.raw.flagged ? 'fill-current' : ''}`} /></Button>}
                    {selected.kind === 'local' && <Button size="icon" variant="ghost" aria-label="标为垃圾邮件" disabled={Boolean(busy)} onClick={() => moveJunk(selected)}><Trash2 className="size-4" /></Button>}
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">{selected.from}</div>
                {selected.raw?.category && <Badge variant="secondary">{EMAIL_CATEGORIES[selected.raw.category] || selected.raw.category}</Badge>}
                <div className="overflow-hidden rounded-xl border bg-white">
                  <EmailHtmlView email={selected.raw} html={selected.raw?.html || selected.raw?.body} plain={selected.body || '没有正文'} attachments={selected.raw?.attachments || []} />
                </div>
              </article>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Inbox className="mr-2 size-4" />选择一封邮件，或写一封新邮件。</div>
            )}
          </div>
        </div>
      </section>
      <aside className="flex w-96 shrink-0 flex-col border-l">
        <WorkbenchAgent
          title="邮件助手"
          description={selected ? selected.title : '按当前邮件或你的要求起草，发送前仍由你确认。'}
          examples={EXAMPLES}
          messages={messages}
          asking={asking}
          value={question}
          onChange={setQuestion}
          onSend={ask}
          onExample={setQuestion}
          placeholder="例如：帮我回复，说明周五下午可以"
          note="助手与招聘、课程工作台共用同一套对话。这里只把草稿放进写信框。"
        />
      </aside>
    </div>
  );
}
