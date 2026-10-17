import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import { PublicThemeControls } from '@/components/public-theme-controls';
import { Button } from '@/components/ui/button';

const DOCS = {
  terms: {
    title: '使用条款',
    updated: '2026-10-14',
    sections: [
      {
        heading: '1. 服务说明',
        body: 'Daylight 提供基于邮箱的日程整理与工作流能力。使用本服务即表示你同意遵守本条款及相关政策。',
      },
      {
        heading: '2. 账号与安全',
        body: '你应妥善保管账号与凭证信息。因个人保管不善导致的损失，由账号持有人自行承担相应责任。',
      },
      {
        heading: '3. 合规使用',
        body: '你不得利用本服务从事违法违规活动，不得未经授权访问他人邮箱或数据，不得干扰服务的正常运行。',
      },
      {
        heading: '4. 服务变更',
        body: '我们可能根据产品演进调整功能与接口。重大变更将通过官网或站内通知说明。',
      },
    ],
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-10-14',
    sections: [
      {
        heading: '1. 我们收集的信息',
        body: '可能包括账号信息、邮箱连接配置、日程与待办数据、以及为保障服务安全所需的基础日志。',
      },
      {
        heading: '2. 信息如何使用',
        body: '用于提供邮件同步、日程提取、冲突处理与证据回放等核心功能，并改进产品稳定性。',
      },
      {
        heading: '3. 存储与传输',
        body: '你可选择本地或云存储。敏感凭证仅保存在你的配置环境中，我们不会将其用于服务条款以外的用途。',
      },
      {
        heading: '4. 你的权利',
        body: '你可以查阅、更正或删除相关数据，也可停止使用服务。如需协助，请通过官网公布的联系方式与我们沟通。',
      },
    ],
  },
  policies: {
    title: '其他政策',
    updated: '2026-10-14',
    sections: [
      {
        heading: '1. Cookie 与本地存储',
        body: '站点可能使用本地存储保存主题、语言与登录会话等偏好，以提供一致的使用体验。',
      },
      {
        heading: '2. 第三方服务',
        body: '若你接入第三方模型或云存储，其数据处理将遵循对应服务商的条款与政策。',
      },
      {
        heading: '3. 安全实践',
        body: '我们采取合理的技术与管理措施保护数据，但不对任何绝对安全作保证。请及时更新客户端与授权码。',
      },
      {
        heading: '4. 联系我们',
        body: '政策相关问题可通过官网「联系我们」渠道提交，我们将在合理时间内回复。',
      },
    ],
  },
};

export default function LegalPage() {
  const { doc = 'terms' } = useParams();
  const content = DOCS[doc] || DOCS.terms;

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-6">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
              <CalendarDays className="size-4" />
            </span>
            <span className="font-[family-name:var(--font-display)] font-semibold">Daylight</span>
          </Link>
          <div className="flex items-center gap-2">
            <PublicThemeControls />
            <Button variant="outline" size="sm" asChild>
              <Link to="/">
                <ArrowLeft className="size-4" />
                返回官网
              </Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <p className="text-xs text-muted-foreground">最近更新：{content.updated}</p>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">{content.title}</h1>
        <div className="mt-8 space-y-8">
          {content.sections.map((section) => (
            <section key={section.heading} className="space-y-2">
              <h2 className="text-base font-semibold">{section.heading}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{section.body}</p>
            </section>
          ))}
        </div>
        <div className="mt-12 flex flex-wrap gap-4 border-t border-border pt-6 text-sm text-muted-foreground">
          <Link className="hover:text-foreground" to="/legal/terms">使用条款</Link>
          <Link className="hover:text-foreground" to="/legal/privacy">隐私政策</Link>
          <Link className="hover:text-foreground" to="/legal/policies">其他政策</Link>
        </div>
      </main>
    </div>
  );
}
