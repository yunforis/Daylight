# README 素材与截图计划 / Assets & capture checklist

中英文 README 共用本目录，避免引用被 Git 忽略的 `output/`。2026-10-17 从用户提供的 `output/pdf/assets` 选取并原样复制说明图。未使用占位问卷/收益数据图；本目录的 PNG 说明图不是软件截图或自动生成的测量证据。

## 已有说明图 / Existing illustrations

| 仓库文件 | 用户素材原名 | 用途 / Purpose |
| --- | --- | --- |
| `banner.png` / `wordmark.png` | `daylight-banner.png` / `daylight-wordmark.png` | 品牌 / Branding（此前已加入） |
| `architecture.png` | `图05-逻辑架构.png` | 逻辑组件 / Logical components |
| `deployment.png` | `图06-单节点容器编排部署拓扑.png` | 单节点 Compose / Single-node topology |
| `startup.png` | `图07-启动顺序.png` | 依赖启动 / Initialization order |
| `agent-control.png` | `图12-智能体四层控制流.png` | Agent 控制流 / Agent control flow |
| `mailbox-scopes.png` | `图02-多邮箱标签与视图隔离.png` | 多邮箱与查看范围 / Mailbox categories and scope |
| `recruitment-flow.png` | `图14-招聘引擎内部数据流.png` | 招聘附件与检索 / Recruitment processing |
| `invoice-flow.png` | `图15-发票助手数据流.png` | 发票处理 / Invoice flow |
| `recovery.png` | `图11-故障与恢复总览.png` | 故障恢复示意 / Recovery overview |

图内公网端口是部署选项；实际 Compose 默认 API 与依赖都绑定回环地址，公开访问需显式配置。Agent 图表示工作台的受控执行；基础邮件同步另有直接写日历/待办的语义，README 已说明。图中 iOS 为独立工程客户端，不随本仓库构建。图的美术表达不替代代码契约与实际验收记录。

## 八个关键截图 / Eight key captures

| 占位 / Filename | 建议展示 / Capture content | 验收重点 / Check |
| --- | --- | --- |
| `workbench-placeholder.svg` | 模板中心与一个事项详情：官方招聘/发票入口、社区分类、材料和行动；保研可用作扩展示例 | 以事项组织信息；收到通知不等于已提交 |
| `mail-placeholder.svg` | 邮件列表、摘要与正文，侧边问答引用，点击命中原文高亮 | 展示真实检索模式与来源，隐藏私人正文 |
| `calendar-placeholder.svg` | 展示单邮箱/同类/全部范围及面试冲突；改期后原安排取消、新安排关联 | 北京时间一致，展示冲突与前后记录 |
| `tasks-placeholder.svg` | 补材料/限时确认任务、截止、来源、回执限制 | 待办与面试分开，未提交不可假完成 |
| `assistant-placeholder.svg` | 小 D 完成一次工具调用，显示待审核发信卡 | 展示收件人、内容、确认状态；不暴露真实地址 |
| `recruitment-placeholder.svg` | 脱敏候选人、简历原件/引用、筛选或邀约草稿 | 证据来自简历；生成邀约不代表发送 |
| `invoices-placeholder.svg` | 原票据与金额、税号、明细的结构化对照 | 数据可核查；模糊字段保留待确认 |
| `trace-placeholder.svg` | 后台任务与一条执行记录、工具、耗时和费用覆盖 | 失败/重试与实际状态一致，不截取密钥或私信 |

建议桌面截图宽 1440–1600 像素，统一浏览器缩放、浅/深色主题、字号和窗口比例。增加移动端时可用单独的对比图，不把截图压到看不清文字。首次公开截图优先使用专用演示租户和合成通知，真实服务调用须标明，确保截图与提交版本一致。

For publication, capture the running submission version using a dedicated demo tenant. Use the same viewport/theme across images. Clearly identify synthetic inputs and live calls. Never publish credentials, private ICS URLs, personal email content, tokens, or unauthorized resumes.

## 替换方法 / Replacing placeholders

1. 将实机图以 `workbench.png`、`mail.png` 等稳定文件名放到本目录。
2. 同时修改根目录 `README.md` 与 `README_EN.md` 的 `src`，由 `*-placeholder.svg` 改为对应 PNG。
3. 删除两份文档中“截图占位”提示，更新 alt，保留真实/示例数据和版本口径。
4. 检查 GitHub 能直接加载图片，确认文件受 Git 管理，清理未经授权内容。

当前 SVG 均为项目制作的占位图；不得称作实机截图。`architecture-placeholder.svg` 为上一版遗留，当前首页已使用实际说明图。
