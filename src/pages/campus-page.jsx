import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, FolderTree, LoaderCircle, PanelLeft, PanelRight, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { AgentThinkingChain } from '@/components/agent-thinking';
import { RichMarkdown } from '@/components/rich-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { authFetch, fetchAuthorizedBlobUrl } from '@/lib/auth-fetch';
import { request } from '@/lib/api';
import { useWorkspace } from '@/context/workspace';

const EXAMPLES = ['这周作业要求是什么？', '用这门课的讲义解释贪心算法', '下次课要看哪几页？'];
const FOLDERS = [
  { id: 'lecture', label: 'Lecture Notes' },
  { id: 'homework', label: 'Homework' },
  { id: 'notice', label: '通知' },
  { id: 'other', label: '其他' },
];

function folderOf(doc) {
  if (doc.kind === 'homework') return 'homework';
  if (doc.kind === 'lecture') return 'lecture';
  if (doc.kind === 'notice') return 'notice';
  return 'other';
}

const SOURCES = [
  { id: 'graduate', label: '研究生课表', href: 'https://graduate.shanghaitech.edu.cn/gsapp/sys/yjsemaphome/portal/index.do' },
  { id: 'piazza', label: 'Piazza', href: 'https://piazza.com/' },
  { id: 'blackboard', label: 'Blackboard', href: 'https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1' },
];

function sourceLabel(id) {
  return SOURCES.find((item) => item.id === id)?.label || '未分类';
}

export default function CampusPage() {
  const { reload: reloadWorkspace } = useWorkspace();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState('');
  const [progress, setProgress] = useState(null);
  const [panel, setPanel] = useState('files');
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [selectedPage, setSelectedPage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState([]);
  const [asking, setAsking] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [openFolders, setOpenFolders] = useState({});
  const chatEnd = useRef(null);

  const load = async (id) => {
    const list = await request('/campus');
    const nextId = id || list.projects?.[0]?.id;
    if (!nextId) {
      setProject(null);
      return null;
    }
    const next = await request(`/campus/projects/${nextId}`);
    setProject(next);
    return next;
  };

  useEffect(() => {
    load().catch((error) => toast.error(error.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end' }); }, [messages, asking]);

  useEffect(() => {
    if (!syncing) return undefined;
    let stopped = false;
    const pull = async () => {
      try {
        const status = await request('/campus/sync-progress');
        if (!stopped) setProgress(status);
      } catch { /* 进度读不到时仍保留按钮上的转圈 */ }
    };
    pull();
    const timer = setInterval(pull, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [syncing]);

  const tree = useMemo(() => {
    if (!project) return [];
    return SOURCES.map((item) => ({
      ...item,
      pages: (project.pages || []).filter((page) => page.source === item.id),
      documents: (project.documents || []).filter((doc) => (doc.source || 'upload') === item.id || (item.id === 'graduate' && !doc.source)),
    }));
  }, [project]);

  const createProject = async () => {
    try {
      const created = await request('/campus/projects', 'POST', { title: '科大学习站' });
      await load(created.id);
      toast.success('已添加科大学习站');
    } catch (error) { toast.error(error.message); }
  };

  const sync = async (source) => {
    if (!project || syncing) return;
    setSyncing(source);
    setProgress({ phase: 'running', source, label: `正在同步${sourceLabel(source)}`, done: 0, total: 0 });
    setPanel('import');
    try {
      const result = await request(`/campus/projects/${project.id}/sync`, 'POST', { source });
      await load(project.id);
      const failed = (result.results || []).filter((item) => item.error);
      const ok = (result.results || []).filter((item) => !item.error);
      const written = ok.reduce((sum, item) => sum + (item.calendar?.events || 0), 0);
      if (written) await reloadWorkspace();
      if (ok.length) {
        const names = ok.map((item) => sourceLabel(item.source)).join('、');
        toast.success(written ? `${names}已同步，并写入日历 ${written} 节课` : `已同步 ${names}`);
      }
      const calendarErrors = ok.map((item) => item.calendarError).filter(Boolean);
      if (calendarErrors.length) toast.error(calendarErrors.join('；'));
      if (failed.length) toast.error(failed.map((item) => `${sourceLabel(item.source)}：${item.error}`).join('；'));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSyncing('');
    }
  };

  const openDocument = async (doc) => {
    setSelectedPage(null);
    setSelectedDoc(doc);
    setPreviewing(true);
    try {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const mode = doc.previewReady || doc.format === 'pdf' ? 'preview' : 'original';
      const file = await fetchAuthorizedBlobUrl(`/api/campus/projects/${project.id}/documents/${doc.id}/${mode}`);
      setPreviewUrl(file.blobUrl);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setPreviewing(false);
    }
  };

  const openPage = (page) => {
    setSelectedDoc(null);
    setSelectedPage(page);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
  };

  const uploadFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !project) return;
    setSyncing('upload');
    authFetch(`/api/campus/projects/${project.id}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        'X-Campus-Source': 'piazza',
        'X-Campus-Course': encodeURIComponent('手动上传'),
        'X-Campus-Kind': 'lecture',
      },
      body: file,
    }).then(async (response) => {
      if (!response.ok) throw new Error('课件上传失败');
      await load(project.id);
      toast.success('课件已保存');
    }).catch((error) => toast.error(error.message)).finally(() => setSyncing(''));
  };

  const ask = async (event) => {
    event?.preventDefault?.();
    const text = question.trim();
    if (!text || !project || asking) return;
    const history = messages.slice(-6).map((item) => ({ role: item.role, content: item.content }));
    setQuestion('');
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: text }]);
    setAsking(true);
    try {
      const reply = await request(`/campus/projects/${project.id}/ask`, 'POST', {
        message: text,
        history,
        ...(selectedDoc ? { scope: 'document', documentId: selectedDoc.id } : {}),
      });
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: reply.answer,
        citations: reply.citations || [],
        steps: reply.steps || [],
      }]);
    } catch (error) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: error.message || '暂时无法回答。' }]);
    } finally { setAsking(false); }
  };

  const confirmSchedule = async () => {
    if (!project) return;
    setSyncing('calendar');
    try {
      const proposal = await request(`/campus/projects/${project.id}/propose`, 'POST', { kind: 'schedule' });
      await request(`/campus/projects/${project.id}/confirm`, 'POST', { proposalId: proposal.id });
      await reloadWorkspace();
      toast.success(`课表已写入日历，共 ${proposal.schedule?.length || 0} 节`);
    } catch (error) { toast.error(error.message); }
    finally { setSyncing(''); }
  };

  const table = selectedPage?.tables?.[0];
  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : (syncing ? 15 : 0);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">正在打开科大学习站…</div>;

  if (!project) {
    return (
      <div className="flex h-full flex-col items-start gap-3 p-6">
        <h1 className="text-2xl font-semibold">科大学习站</h1>
        <p className="text-sm text-muted-foreground">还没有学习资料夹。</p>
        <Button onClick={createProject}>添加学习站</Button>
      </div>
    );
  }

  const foldersOf = (group) => {
    if (group.id === 'blackboard') {
      const map = new Map();
      for (const doc of group.documents) {
        const label = doc.course || '课程';
        map.set(label, [...(map.get(label) || []), doc]);
      }
      return [...map.entries()].map(([label, documents]) => ({ id: label, label, documents }));
    }
    return FOLDERS.map((folder) => ({
      ...folder,
      documents: group.documents.filter((doc) => folderOf(doc) === folder.id),
    })).filter((folder) => folder.documents.length);
  };

  return (
    <div className="flex h-[calc(100svh-7.5rem)] min-h-[640px] overflow-hidden rounded-xl border bg-card">
      <aside className={`flex shrink-0 flex-col border-r ${leftOpen ? 'w-72' : 'w-11'}`}>
        <div className="flex items-center border-b p-1.5">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setLeftOpen((open) => !open)} aria-label={leftOpen ? '收起资料' : '展开资料'}>
            <PanelLeft className="size-4" />
          </Button>
          {leftOpen && (
            <div className="flex min-w-0 flex-1">
              <button type="button" className={`flex-1 rounded-md px-2 py-1.5 text-sm ${panel === 'files' ? 'bg-muted font-medium' : 'text-muted-foreground'}`} onClick={() => setPanel('files')}>资料</button>
              <button type="button" className={`flex-1 rounded-md px-2 py-1.5 text-sm ${panel === 'import' ? 'bg-muted font-medium' : 'text-muted-foreground'}`} onClick={() => setPanel('import')}>导入</button>
            </div>
          )}
        </div>
        {leftOpen && (panel === 'files' ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-sm">
            {tree.map((group) => {
              const folders = foldersOf(group);
              const pages = group.id === 'piazza' ? [] : group.pages;
              return (
                <div key={group.id}>
                  <div className="mb-1 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground"><FolderTree className="size-3.5" />{group.label}</div>
                  {pages.map((page) => (
                    <button key={page.id} type="button" className={`mb-0.5 flex w-full rounded-md px-2 py-2 text-left ${selectedPage?.id === page.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`} onClick={() => openPage(page)}>
                      <span className="truncate">{page.title}</span>
                    </button>
                  ))}
                  {folders.map((folder) => {
                    const key = `${group.id}:${folder.id}`;
                    const open = openFolders[key] !== false;
                    return (
                      <div key={key} className="mb-1">
                        <button type="button" className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left font-medium hover:bg-muted/60" onClick={() => setOpenFolders((current) => ({ ...current, [key]: !open }))}>
                          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                          <span className="truncate">{folder.label}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{folder.documents.length}</span>
                        </button>
                        {open && folder.documents.map((doc) => (
                          <button key={doc.id} type="button" className={`mb-0.5 flex w-full items-center gap-2 rounded-md py-2 pr-2 pl-7 text-left ${selectedDoc?.id === doc.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`} onClick={() => openDocument(doc)}>
                            <FileText className="size-3.5 shrink-0" />
                            <span className="truncate">{doc.filename}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {!pages.length && !folders.length && <div className="px-2 py-1 text-muted-foreground">尚未导入</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
            <p className="text-xs leading-5 text-muted-foreground">使用本机已登录的 Chrome 拉取。研究生课表同步后会直接写入日历。</p>
            <Button className="w-full" disabled={Boolean(syncing)} onClick={() => sync('all')}>{syncing === 'all' ? <LoaderCircle className="size-4 animate-spin" /> : null}同步全部</Button>
            {SOURCES.map((item) => (
              <Button key={item.id} className="w-full" variant="outline" disabled={Boolean(syncing)} onClick={() => sync(item.id)}>
                {syncing === item.id ? <LoaderCircle className="size-4 animate-spin" /> : null}同步{item.label}
              </Button>
            ))}
            {syncing && (
              <div className="space-y-1.5 rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{progress?.label || '正在同步…'}</div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-foreground transition-all" style={{ width: `${percent}%` }} />
                </div>
              </div>
            )}
            <Button className="w-full" variant="outline" disabled={Boolean(syncing)} asChild><label>补充上传课件<input className="hidden" type="file" accept=".pdf,.ppt,.pptx,.txt,.md" onChange={uploadFile} /></label></Button>
            <Button className="w-full" variant="outline" disabled={Boolean(syncing)} onClick={confirmSchedule}>再次写入日历</Button>
          </div>
        ))}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3 text-sm font-medium">{selectedDoc?.filename || selectedPage?.title || '选择左侧资料'}</div>
        <div className="min-h-0 flex-1">
          {previewing ? <div className="p-4 text-sm text-muted-foreground">正在打开文件…</div> : null}
          {!previewing && previewUrl ? <iframe title="课件预览" src={previewUrl} className="h-full w-full border-0" /> : null}
          {!previewing && !previewUrl && table ? (
            <div className="h-full overflow-auto p-4">
              <table className="w-full text-left text-sm">
                <tbody>
                  {table.map((row, index) => (
                    <tr key={index} className={index === 0 ? 'font-medium' : 'border-t'}>
                      {row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-2 align-top">{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {!previewing && !previewUrl && !table ? <div className="p-6 text-sm text-muted-foreground">从左侧点开课件或课表。导入在左侧「导入」里。</div> : null}
        </div>
      </section>
      <aside className={`flex shrink-0 flex-col border-l ${rightOpen ? 'w-96' : 'w-11'}`}>
        <div className="flex items-center gap-2 border-b px-1.5 py-2">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setRightOpen((open) => !open)} aria-label={rightOpen ? '收起课程助手' : '展开课程助手'}>
            <PanelRight className="size-4" />
          </Button>
          {rightOpen && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4" />课程助手</div>
              <div className="truncate text-xs text-muted-foreground">{selectedDoc ? selectedDoc.filename : '按已导入资料回答'}</div>
            </div>
          )}
          {rightOpen && <Badge variant={asking ? 'default' : 'secondary'}>{asking ? '执行中' : '随时可以聊'}</Badge>}
        </div>
        {rightOpen && (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-4">
                {!messages.length && (
                  <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                    <h3 className="text-lg font-medium">想弄懂哪一节？</h3>
                    <p className="text-sm text-muted-foreground">助手只根据已导入的课表和课件回答，并标出页码。</p>
                    <div className="space-y-2">
                      {EXAMPLES.map((example) => (
                        <button key={example} type="button" className="flex w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => setQuestion(example)}>
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
                      {message.role === 'user' ? '你' : <><Sparkles className="size-3" />课程助手</>}
                    </div>
                    {message.role === 'user' ? (
                      <div className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</div>
                    ) : (
                      <RichMarkdown>{message.content}</RichMarkdown>
                    )}
                    {message.steps?.length ? (
                      <AgentThinkingChain
                        toolTrace={message.steps.map((step) => ({ name: step.tool, args: { query: step.query }, result: { ok: true, count: step.count } }))}
                        title={`检索 · ${message.steps.length} 步`}
                      />
                    ) : null}
                    {message.citations?.length ? (
                      <div className="space-y-1">
                        {message.citations.map((cite) => (
                          <button key={`${cite.documentId}-${cite.page}`} type="button" className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted/40" onClick={() => { const doc = project.documents.find((item) => item.id === cite.documentId); if (doc) openDocument(doc); }}>
                            <FileText className="size-3.5 shrink-0" />
                            <span className="truncate">{cite.filename || '资料'} · 第 {cite.page} 页</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
                {asking && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    助手正在查阅课件…
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
            </ScrollArea>
            <form className="space-y-2 border-t p-4" onSubmit={ask}>
              <div className="rounded-xl border bg-muted/20 p-2">
                <Textarea
                  aria-label="向课程助手发送消息"
                  value={question}
                  rows={3}
                  placeholder="例如：这周作业要求是什么？"
                  className="min-h-[4.5rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      ask(event);
                    }
                  }}
                />
                <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
                  <span className="text-xs text-muted-foreground">Enter 发送 · Shift + Enter 换行</span>
                  <Button size="sm" disabled={!question.trim() || asking} type="submit">
                    {asking ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
                    发送
                  </Button>
                </div>
              </div>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
