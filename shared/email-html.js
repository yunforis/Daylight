/** 判断一段邮件正文是不是 HTML。标签不限于 div/table，避免把带样式的邮件当成纯文本。 */
export function looksLikeEmailHtml(value) {
  return /<[a-z!][^>]*>/i.test(String(value || ''));
}

/** 去掉脚本和事件，保留样式、图片和表格。 */
export function sanitizeEmailHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<\/?(iframe|object|embed|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

export function emailHtmlDocument(raw) {
  let html = sanitizeEmailHtml(raw);
  const extra = '<style>img,video{max-width:100%;height:auto;}table{max-width:100%;}</style>';
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8">${extra}</head><body>${html}</body></html>`;
  } else if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${extra}`);
  } else {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8">${extra}</head>${html}</html>`;
  }
  return html;
}

export function emailDisplayHtml(email = {}) {
  if (looksLikeEmailHtml(email.html)) return String(email.html);
  if (looksLikeEmailHtml(email.body)) return String(email.body);
  return '';
}
