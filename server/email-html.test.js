import assert from 'node:assert/strict';
import test from 'node:test';
import { emailDisplayHtml, emailHtmlDocument, looksLikeEmailHtml, sanitizeEmailHtml } from '../shared/email-html.js';

test('带图片和样式的邮件按 HTML 识别，并去掉脚本', () => {
  const source = '<html><head><style>.a{color:red}</style></head><body><img src="https://example.com/a.png"><script>alert(1)</script><p onclick="x()">你好</p></body></html>';
  assert.equal(looksLikeEmailHtml(source), true);
  const doc = emailHtmlDocument(source);
  assert.match(doc, /<img src="https:\/\/example.com\/a.png">/);
  assert.match(doc, /\.a\{color:red\}/);
  assert.doesNotMatch(doc, /<script/);
  assert.doesNotMatch(doc, /onclick/);
  assert.equal(emailDisplayHtml({ html: source, body: '你好' }), source);
  assert.equal(sanitizeEmailHtml('<p>纯文本</p>').includes('<p>'), true);
});
