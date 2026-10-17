import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth-fetch';
import { sourceUrl } from '@/lib/attachment-source';
import { emailDisplayHtml, emailHtmlDocument } from '../../shared/email-html.js';

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function inlineCidImages(html, attachments = []) {
  const refs = [...String(html).matchAll(/cid:([^"'\s>]+)/gi)].map((match) => match[1]);
  if (!refs.length) return html;
  let next = html;
  const used = new Set();
  for (const raw of refs) {
    const cid = decodeURIComponent(raw).replace(/[<>]/g, '');
    if (used.has(cid)) continue;
    used.add(cid);
    const file = attachments.find((item) => item?.cid && item.cid === cid)
      || attachments.find((item) => item?.filename && (cid === item.filename || cid.startsWith(`${item.filename}@`)));
    const url = sourceUrl(file || {});
    if (!url) continue;
    try {
      const response = await authFetch(url);
      if (!response.ok) continue;
      const dataUrl = await blobToDataUrl(await response.blob());
      next = next.replaceAll(`cid:${raw}`, dataUrl);
    } catch { /* 单张内嵌图失败时保留其余正文 */ }
  }
  return next;
}

export function EmailHtmlView({ email, html, attachments, plain = '' }) {
  const source = html || emailDisplayHtml(email || {}) || (looksHtml(plain) ? plain : '');
  const files = attachments || email?.attachments || [];
  const fileKey = files.map((item) => item?.cid || item?.id || item?.key || item?.filename || '').join('|');
  const [doc, setDoc] = useState('');

  useEffect(() => {
    let stopped = false;
    if (!source) {
      setDoc('');
      return undefined;
    }
    inlineCidImages(source, files).then((ready) => {
      if (!stopped) setDoc(emailHtmlDocument(ready));
    });
    return () => { stopped = true; };
  }, [source, fileKey]);

  function fitFrame(event) {
    const frame = event.currentTarget;
    const height = Math.max(frame.contentDocument?.body?.scrollHeight || 0, frame.contentDocument?.documentElement?.scrollHeight || 0);
    if (height) frame.style.height = `${height + 8}px`;
  }

  if (!source) {
    return <div className="rounded-xl border bg-background px-5 py-4 text-sm leading-7 whitespace-pre-wrap break-words">{plain || '这封邮件没有可显示的正文。'}</div>;
  }

  return (
    <iframe
      title="邮件正文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      onLoad={fitFrame}
      className="block min-h-48 w-full border-0 bg-white"
    />
  );
}

function looksHtml(value) {
  return /<[a-z!][^>]*>/i.test(String(value || ''));
}
