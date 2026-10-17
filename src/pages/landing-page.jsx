import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download } from 'lucide-react';
import { toast } from 'sonner';
import { PublicThemeControls } from '@/components/public-theme-controls';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DOWNLOAD_OPTIONS, EXTRA_DOWNLOADS, DESKTOP_RELEASE, DESKTOP_RELEASES_URL, detectDevice, desktopDownload, downloadFormat, releaseAssetUrl } from '@/lib/platform';

const NAV = [
  { href: '#product', label: '产品' },
  { href: '#workflow', label: '流程' },
  { href: '#download', label: '下载' },
  { href: '#trust', label: '可靠' },
];

const TRUST_MARKS = ['日历', '邮件', '待办', '证据链', '多邮箱'];

const CAPABILITIES = [
  {
    title: '从邮件到安排，一步到位',
    text: 'IMAP 拉取邀请、改期与取消通知，模型一次识别分类、摘要与日程变更，写入可核对的日历。',
  },
  {
    title: '为真实工程节奏而设计',
    text: '冲突仍入历并标识，生成候选时段与回复草稿；证据链保留每次工具调用，方便回溯与复核。',
  },
  {
    title: '本地优先，云原生就绪',
    text: '默认本地存储即可运行；需要时热切换 PostgreSQL、Redis、对象存储与消息队列，无需停机改造。',
  },
];

const STEPS = [
  { n: '01', title: '连接邮箱', text: 'QQ、163、Gmail 等 IMAP 预设，授权码安全保存。' },
  { n: '02', title: '模型提取', text: '识别新增、取消、调整与待办，形成结构化结果。' },
  { n: '03', title: '写入核对', text: '日程入历、冲突提示、草稿可发送，全程可回放。' },
];

export default function LandingPage() {
  const [device, setDevice] = useState({ id: null, arch: '' });

  useEffect(() => {
    let cancelled = false;
    detectDevice().then((next) => {
      if (!cancelled) setDevice(next);
    });
    return () => { cancelled = true; };
  }, []);

  const { id: preferred, arch } = device;

  const preferredOption = useMemo(
    () => DOWNLOAD_OPTIONS.find((item) => item.id === preferred) || null,
    [preferred],
  );

  const preferredDownload = useMemo(
    () => desktopDownload(preferredOption, arch),
    [preferredOption, arch],
  );

  function onDownload(option) {
    toast.message(`${option.label}客户端正在准备中`, {
      description: '移动端安装包尚未发布，当前可先使用网页版工作区。',
    });
  }

  return (
    <div className="landing-page">
      <div className="landing-atmosphere" aria-hidden />

      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link to="/" className="landing-brand">
            <BrandMark className="landing-mark" />
            <span>Daylight</span>
          </Link>

          <nav className="landing-nav-links" aria-label="站点导航">
            {NAV.map((item) => (
              <a key={item.href} href={item.href}>{item.label}</a>
            ))}
          </nav>

          <div className="landing-nav-actions">
            <PublicThemeControls />
            <Link to="/login" className="landing-link-quiet hidden sm:inline">登录</Link>
            <Button asChild className="landing-btn-solid h-9 rounded-full px-4">
              <Link to="/register">
                免费开始
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero：品牌 + 一句主张 + CTA，对齐 Codex 居中构图 */}
        <section className="landing-hero">
          <div className="landing-hero-inner landing-rise">
            <div className="landing-hero-mark landing-rise-delay-1" aria-hidden>
              <img src="/logo.png" alt="" draggable={false} className="h-[92%] w-[92%] object-contain" />
            </div>
            <h1 className="landing-hero-title landing-rise-delay-2">
              Daylight
            </h1>
            <p className="landing-hero-lead landing-rise-delay-3">
              借助 Daylight，
              <br />
              把每一封邮件变成清晰安排。
            </p>
            <p className="landing-hero-sub landing-rise-delay-4">
              加快日程整理，走得更稳，
              <br />
              将零散通知沉淀为可核对的日历工作流。
            </p>
            <div className="landing-hero-cta landing-rise-delay-5">
              {preferredDownload ? (
                <a href={preferredDownload.url} className="landing-btn-solid landing-btn-lg">
                  <Download className="size-4" />
                  下载 {preferredOption.label}
                </a>
              ) : preferredOption ? (
                <button
                  type="button"
                  className="landing-btn-solid landing-btn-lg"
                  onClick={() => onDownload(preferredOption)}
                >
                  <Download className="size-4" />
                  {preferredOption.label}客户端
                </button>
              ) : (
                <Button asChild className="landing-btn-solid landing-btn-lg">
                  <Link to="/register">创建账号</Link>
                </Button>
              )}
              <Button asChild variant="secondary" className="landing-btn-ghost landing-btn-lg">
                <Link to="/app">打开网页版</Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="landing-trust-strip" aria-label="能力概览">
          <p className="landing-trust-label">为日程工作流而生</p>
          <div className="landing-trust-marks">
            {TRUST_MARKS.map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
        </section>

        <section id="product" className="landing-section">
          <div className="landing-section-head">
            <p className="landing-eyebrow">产品</p>
            <h2>为实际日程工作的核心需求而打造</h2>
            <p>连接邮箱、提取安排、核对冲突——同一工作区覆盖完整链路。</p>
          </div>
          <div className="landing-capability-list">
            {CAPABILITIES.map((item, index) => (
              <article key={item.title} className="landing-capability">
                <span className="landing-capability-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="workflow" className="landing-section landing-section-soft">
          <div className="landing-section-head">
            <p className="landing-eyebrow">流程</p>
            <h2>三步走完：连接、提取、核对</h2>
            <p>保持流程短而可复核，让邮件驱动的日程更新成为日常习惯。</p>
          </div>
          <div className="landing-steps">
            {STEPS.map((step) => (
              <div key={step.n} className="landing-step">
                <span>{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="download" className="landing-section">
          <div className="landing-section-head">
            <p className="landing-eyebrow">下载</p>
            <h2>在你常用的设备上使用 Daylight</h2>
            <p>
              桌面端安装包已发布（{DESKTOP_RELEASE.version}，macOS / Windows / Linux 各双架构）。我们已按当前设备推荐对应的安装包；移动端客户端正在准备中。
            </p>
          </div>
          <div className="landing-download-grid">
            {DOWNLOAD_OPTIONS.map((option) => {
              const active = preferred === option.id;
              const target = desktopDownload(option, arch);
              const body = (
                <>
                  <span className="landing-download-meta">
                    <span className="landing-download-label">{option.label}</span>
                    {target ? (
                      <span className="landing-download-hint">{downloadFormat(option, arch)}</span>
                    ) : (
                      <span className="landing-download-hint">移动端正在准备</span>
                    )}
                  </span>
                  {active ? (
                    <span className="landing-download-badge">推荐</span>
                  ) : (
                    <Download className="size-4 opacity-40" />
                  )}
                </>
              );
              const className = cn('landing-download-item', active && 'is-preferred');

              return target ? (
                <a key={option.id} className={className} href={target.url} title={target.name}>
                  {body}
                </a>
              ) : (
                <button
                  key={option.id}
                  type="button"
                  className={className}
                  onClick={() => onDownload(option)}
                >
                  {body}
                </button>
              );
            })}
          </div>
          <div className="landing-download-extras">
            <p className="landing-download-extras-label">其它安装格式</p>
            <div className="landing-download-extra-links">
              {EXTRA_DOWNLOADS.map((item) => (
                <a key={item.asset} href={releaseAssetUrl(item.asset)}>
                  {item.label}
                </a>
              ))}
              <a href={DESKTOP_RELEASES_URL} target="_blank" rel="noreferrer">
                全部产物与校验签名
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>
          <p className="landing-download-note">
            macOS 安装包尚未签名与公证，首次打开需在「系统设置 → 隐私与安全性」中允许。
          </p>
          <div className="landing-download-web">
            <Button asChild variant="outline" className="landing-btn-ghost landing-btn-lg">
              <Link to="/app">先使用网页版工作区</Link>
            </Button>
          </div>
        </section>

        <section id="trust" className="landing-section landing-section-close">
          <div className="landing-close-panel">
            <p className="landing-eyebrow">可靠</p>
            <h2>开始整理你的日程工作流</h2>
            <p>网页版现已可用。注册即可连接邮箱，把邀请与改期沉淀进日历。</p>
            <div className="landing-hero-cta">
              <Button asChild className="landing-btn-solid landing-btn-lg">
                <Link to="/register">免费开始</Link>
              </Button>
              <Button asChild variant="secondary" className="landing-btn-ghost landing-btn-lg">
                <Link to="/login">登录</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div className="landing-footer-brand">
            <Link to="/" className="landing-brand">
              <BrandMark className="landing-mark" />
              <span>Daylight</span>
            </Link>
            <p>邮件驱动的日程工作流。本地优先，云原生就绪。</p>
          </div>
          <div>
            <h3>产品</h3>
            <a href="#product">功能介绍</a>
            <a href="#download">客户端下载</a>
            <Link to="/app">网页工作区</Link>
          </div>
          <div>
            <h3>账户</h3>
            <Link to="/login">登录</Link>
            <Link to="/register">注册</Link>
            <Link to="/forgot-password">找回密码</Link>
          </div>
          <div>
            <h3>法律信息</h3>
            <Link to="/legal/terms">使用条款</Link>
            <Link to="/legal/privacy">隐私政策</Link>
            <Link to="/legal/policies">其他政策</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span>© {new Date().getFullYear()} Daylight</span>
          <span>持续构建更可靠的日程工作流</span>
        </div>
      </footer>
    </div>
  );
}
