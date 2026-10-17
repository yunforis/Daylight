# Daylight 部署说明

2026-10-17 实施增量：新增 `DAYLIGHT_RUNTIME=production` 严格基础设施模式、PG 快照/CAS 业务提交、持久任务及独立 API / Worker / Scheduler 入口。**全部 9 个服务已在真实云主机以 Docker Compose 一键启动并通过验证**（套件 547/547、真实 IMAP 与真实模型调用、邮箱知识库检索问答、容器内 MinIO 对象存储、公网 3000 可达）。完整 Compose、Kubernetes 资源、独立迁移与隔离验证步骤见 **[deploy/README.md](deploy/README.md)**，实际验证与限制见 [deploy/VALIDATION.md](deploy/VALIDATION.md) 与 [云端部署验收报告](docs/submission/deployment/README.md)。整体集成仍在收口，不能据局部测试推定生产验收完成。恢复入口见 `docs/submission/cloud-native-execution.md`。

本文前六节记录当前实现的单实例启动与依赖配置方式，不代表已完成云原生生产部署。商业化及比赛交付目标见 [云原生建设与比赛验收基线](docs/cloud-native-roadmap.md)，云端验收见第七节。

生产目标：业务与用户使用 PostgreSQL 权威存储，验证码/共享临时状态使用 Redis，附件使用对象存储，异步任务使用可靠消息队列。当前代码存在 JSON、内存与进程内队列回退，这些是开发便利能力，不能保证多实例一致性或故障后的任务恢复。生产故障策略、共享状态与恢复机制需完成建设和验证后才可据此上线。`data/` **不提交到 Git**。

默认：**没有内置管理员账号和密码。**

---

## 1. 启动前

- Node **≥ 22**（`nvm use 22`）
- 分支示例：`feat/cloud-native-platform`
- `npm install` → `npm run build` → `npm start`（或 `npm run dev`）
- 监听：`http://127.0.0.1:3000`（生产请前面加反代/HTTPS）

当前可配置依赖（回退行为仅说明实现现状，不作为生产容灾方案）：

| 组件 | 作用 | 未配时 |
| --- | --- | --- |
| PostgreSQL | 用户与业务权威存储（含新手引导 `app_settings`） | 回退 `data/users.json`、`data/onboarding-guide.json` 等 |
| Redis | 验证码 / 会话辅助 | 内存回退 |
| RabbitMQ | 异步同步任务 | 进程内队列 |
| OSS | 邮件附件等对象存储 | 本地 `data/attachments` |

当前 `docker-compose.yml` 已改为完整隔离栈，要求显式提供依赖密码和 JWT secret；不再包含默认 `daylight/daylight` 凭据。依照 [deploy/README.md](deploy/README.md) 配置后启动。仅本地开发若要单独启动 RabbitMQ，可执行 `docker compose up -d rabbitmq`，同样需要配置凭据。不要将现有真实 `data/` 挂载到验证栈。

---

## 2. 管理员：没有默认密码

### 推荐：命令行引导（首台机器执行一次）

```bash
node scripts/bootstrap-admin.js \
  --email your-admin@example.com \
  --username admin \
  --password '至少8位强密码'
```

作用：

- 在用户库创建（或提升）管理员
- 把该邮箱写入 `auth.adminEmails`
- 关闭 `allowLocalDemoLogin`，并在缺省时生成 `jwtSecret`

之后：

- 用户工作区：`/login`
- 管理端：`/admin` → `/admin/login`（**同一账号密码**）

### Compose / 严格生产模式的首个管理员

完整可复制命令见 [README 的首个管理员步骤](README.md#3-创建首个管理员) 或 [English](README_EN.md#3-bootstrap-the-administrator)。在 API 容器内执行 `scripts/bootstrap-admin.js`，密码通过 `DAYLIGHT_ADMIN_PASSWORD` 传入。生产模式只在 PostgreSQL 创建/提升账号，不调用 `saveInfraConfig`；认证、系统发信等配置由部署环境变量维护，不能通过修改容器内 `infra.json` 生效。脚本结束时关闭数据库连接池。

上面的“写入 auth.adminEmails、生成 JWT secret”只适用于本地运行模式；Compose 的 JWT secret 由 `up.sh` 首次生成，`DAYLIGHT_ADMIN_EMAILS` 由环境文件管理。数据库账号本身的管理员角色可以用于管理端登录。

### 后续再加管理员（不用手改 JSON）

1. 用已有管理员登录 `/admin`
2. **账号 → 新建用户**，角色选管理员；或  
3. **系统服务 / 认证**：在「管理员邮箱名单」追加邮箱 → 对方用该邮箱注册/登录后即管理员

---

## 3. 系统发信 SMTP（注册 / 找回密码）

**用途**：注册验证码、找回密码邮件。与用户在设置里填的「工作邮箱 SMTP」不是同一套。

### 在哪配

管理端 → **系统服务 / 发信（systemMail）**（写入 `data/infra.json`，界面保存即可）：

| 字段 | 说明 | 常见 QQ 邮箱示例 |
| --- | --- | --- |
| enabled | 开启 | √ |
| host | SMTP 主机 | `smtp.qq.com` |
| port | 端口 | `465`（SSL） |
| secure | 是否 TLS/SSL | true |
| user | 发信邮箱 | `你的QQ@qq.com` |
| pass | **授权码**（不是登录密码） | QQ 邮箱生成的 16 位授权码 |
| from | 显示发件人 | 可空，默认用 user |
| publicBaseUrl | 对外站点根 URL | `https://你的域名`（找回链接用） |

生产务必：`allowLocalDemoLogin = false`（引导脚本已关），不要把验证码明文回给前端。

---

## 4. OSS（对象存储）

**用途**：邮件附件等；未开启时落本地目录。

### 在哪配

管理端 → **存储 / OSS** → 勾选启用 → 选提供商 → 填密钥 → **测试连接** → 保存。

| 字段 | 含义 |
| --- | --- |
| provider | `aliyun` / `qiniu` / `upyun` / `us3` / `s3`（其余选项可能仍预留） |
| endpoint | 服务端点，如阿里云 `https://oss-cn-beijing.aliyuncs.com` |
| bucket | 桶名 / 服务名 |
| region | 地域，如 `oss-cn-beijing` |
| publicBaseUrl | 对外访问或 CDN 域名 |
| accessKey | AccessKey / Operator |
| secretKey | Secret / Password |

也可用环境变量（可选）：`DAYLIGHT_OSS_ACCESS_KEY`、`DAYLIGHT_OSS_SECRET_KEY`。

### 密钥怎么拿（阿里云示例）

1. 开通 [阿里云 OSS](https://oss.console.aliyun.com/)，建 Bucket，记下地域与 Endpoint  
2. 控制台 → AccessKey，创建 **AccessKeyId / AccessKeySecret**（权限最小化）  
3. 桶建议私有 + 用本系统下载接口；若用 CDN，把 `publicBaseUrl` 设成 CDN 域名  
4. 在管理端点「测试 OSS」，成功后再开业务上传  

七牛 / 又拍 / US3 / S3 兼容：在对应控制台建空间并创建密钥，按管理端占位符填写。

---

## 5. 还要配什么

| 项 | 说明 |
| --- | --- |
| PostgreSQL | 管理端开 `postgres.enabled`，填连接信息；生产以此为准 |
| Redis | 建议开启，验证码更稳 |
| RabbitMQ | 建议开启；`docker compose up -d` 或云 MQ |
| jwtSecret | 生产必改长随机串（引导脚本可生成） |
| requireAuth | 保持 `true` |
| allowLocalDemoLogin | 生产必须 `false` |
| 用户工作邮箱 | 用户在 `/app/settings` 填 IMAP/SMTP **授权码**（读信/回信） |
| 模型 API | 用户或管理员配置 Base URL / API Key / 模型名 |

路径备忘：

- 用户站：`/`、`/login`、`/register`、`/app`
- 管理站：`/admin/login` → `/admin`
- 配置落盘：`data/infra.json`（密钥脱敏展示；**勿提交仓库**）

---

## 6. 一键 Docker Compose 部署（云端已验证）

全部服务由 `docker-compose.yml` 编排：`api` / `worker` / `scheduler` 三个应用角色 + `postgres` / `redis` / `rabbitmq` / `minio` 四个依赖 + `migrate` / `minio-init` 两个一次性任务。依赖顺序由 healthcheck 与 `service_completed_successfully` 强制，不依赖 sleep；迁移失败则应用不启动。

```sh
cp deploy/compose.env.example /opt/daylight/compose.env   # 填真实口令，权限 600
cd /opt/daylight/app
docker compose --env-file /opt/daylight/compose.env -p daylight up -d --wait --build
docker compose --env-file /opt/daylight/compose.env -p daylight ps
```

`--wait` 会等到所有 healthcheck 通过、一次性服务退出 0 才返回，因此命令返回即可用；日常重启去掉 `--build`。

- 国内或受限网络：环境文件里设 `DEBIAN_MIRROR=mirrors.aliyun.com`（构建镜像时替换 Debian 源并强制 IPv4，否则默认 Fastly CDN 可能挂死），并在 `/etc/docker/daemon.json` 配置 `registry-mirrors`。
- 依赖默认只绑回环端口（`15432` / `16379` / `15673` / `15674` / `19000` / `19001`），便于在宿主机运行迁移、`scripts/verify-*.mjs`、负载与埋点工具，不对外暴露；端口被占用时用 `DAYLIGHT_*_HOST_PORT` 覆盖。
- 对公网提供服务需设 `DAYLIGHT_BIND_ADDRESS=0.0.0.0`，默认只绑 `127.0.0.1`。
- 监控查看方式（健康端点、埋点文件与 `npm run metrics:report`、RabbitMQ 管理台、MinIO Console、日志）见 [云端部署验收报告 §4](docs/submission/deployment/README.md)。

## 7. 单实例部署基础检查（不替代生产验收）

1. `bootstrap-admin` 已执行，能进 `/admin`  
2. systemMail 发信就绪，真实邮箱能收到注册码  
3. PG 已连上；OSS 测试通过（若需要）  
4. `allowLocalDemoLogin=false`，`jwtSecret` 已设  
5. `npm run build && npm start`，反代 HTTPS  
6. 勿把 `data/settings.json`、真实授权码、API Key 写进文档或 Git  

## 8. 云原生交付与生产验收

以下是上线目标。已完成并在真实云端验证的部分标注状态，其余逐项完成后在 `STATUS.md` 记录对应版本与证据。

- 提供应用/API 与后台 Worker 的容器构建和 Kubernetes 部署配置，说明网络入口、健康检查、资源配置、密钥注入及迁移步骤；验证干净环境部署、滚动更新和回滚。**容器构建与干净环境部署（9 服务 Compose）已在真实云端验证；滚动更新与回滚仍未验证。**
- 核对所有业务/会话/任务状态的共享持久化，验证多实例隔离、幂等、邮箱任务顺序及调度协调。不能把当前文件回退或部分 PG 双写直接用于多副本生产承诺。
- 明确 PG、Redis、MQ、对象存储不可用时的暂停/失败/降级策略，完成告警与恢复验证；测试任务重投和进程重启，防止重复发信或丢失业务结果。
- 使用受控测试账号完成真实邮件、模型、日历或招聘的核心闭环；复验权限边界、密钥保护和附件访问，记录备份恢复及数据保留/删除流程。**真实 IMAP 读取与真实模型调用已在云端验证通过；完整「通知→事项→行动→回执」业务闭环仍未用真实邮件端到端触发。**
- 提交容量与成本报告：负载、成功率、p50/p95 延迟、资源和 API 用量、云资源成本、瓶颈与优化结果；在验收前约定服务目标及预算。
- 随可复现版本交付架构与选型说明、部署操作、故障处理步骤和演示视频。具体考核映射见 [建设与比赛验收基线](docs/cloud-native-roadmap.md)。

### 生产模式环境变量（`DAYLIGHT_RUNTIME=production`）

生产模式不读取 `data/infra.json` 作为配置来源，也不在启动时建表或导入 JSON；下表变量由部署环境注入，缺失或依赖不可用时**明确失败**，不静默回退到本地文件或内存。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DAYLIGHT_RUNTIME` | 是 | 固定 `production`；其他值报错 |
| `DAYLIGHT_DATA_DIR` | 是 | 进程可写目录（临时/轨迹/指标），不存放权威业务数据 |
| `DAYLIGHT_DATABASE_URL` | 是 | PostgreSQL 连接串（业务权威存储与任务队列） |
| `DAYLIGHT_REDIS_URL` | 是 | Redis（会话/验证码） |
| `DAYLIGHT_AMQP_URL` | 是 | RabbitMQ（任务唤醒；PG 轮询为最终恢复手段） |
| `DAYLIGHT_JWT_SECRET` | 是 | 会话签名密钥，需长随机串 |
| `DAYLIGHT_OSS_*` | 视附件 | `ENDPOINT`/`REGION`/`BUCKET`/`ACCESS_KEY`/`SECRET_KEY`/`PROVIDER`/`PUBLIC_BASE_URL` |
| `DAYLIGHT_ADMIN_EMAILS` | 否 | 逗号分隔的管理员邮箱白名单 |
| `DAYLIGHT_SYSTEM_MAIL_ENABLED` | 否 | `0` 关闭系统发信（注册/找回密码），用于不接入 SMTP 的部署 |
| `DAYLIGHT_HEALTH_PORT` / `HOST` | 否 | worker/scheduler 的独立健康检查端口（默认 3001）；**api 不使用该变量**，其 `/health/live`、`/health/ready` 与业务共用主端口（`PORT`，默认 3000），Compose healthcheck 与 K8s 探针均按此配置。同一主机部署多个 worker/scheduler 时需分别指定 |
| `TZ` | 建议 | `Asia/Shanghai`，时间语义统一为北京时间 |
| `DAYLIGHT_AUTO_PROXY` | 否 | 设为 `0` 不继承系统代理；部署时也应清除 `*_PROXY` 环境变量 |

调优与观测（可选，均有保守默认值）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DAYLIGHT_PG_POOL_MAX` | `5` | 单进程 PG 连接池上限（1–100）。同一进程内运行多个 Worker 时需相应放大；本机矩阵显示池大小不是吞吐瓶颈，限制来自事件循环 |
| `DAYLIGHT_MAIL_BACKOFF_BASE_MS` | `300000` | 邮箱连续失败后的退避基数（5 分钟），按 2 的幂增长 |
| `DAYLIGHT_MAIL_BACKOFF_MAX_MS` | `3600000` | 退避上限（1 小时）。手动同步不受退避限制，用户修复后立即生效 |
| `DAYLIGHT_METRICS` | 未设置=关闭 | `1` 开启埋点；其余变量见 [埋点与可观测性](docs/submission/observability/README.md) |
| `DEBIAN_MIRROR` | `deb.debian.org` | 构建镜像时的 Debian 源；国内用 `mirrors.aliyun.com`，构建同时强制 IPv4 |
| `DAYLIGHT_PG_HOST_PORT` / `DAYLIGHT_REDIS_HOST_PORT` / `DAYLIGHT_MQ_HOST_PORT` / `DAYLIGHT_MQ_UI_HOST_PORT` / `DAYLIGHT_MINIO_HOST_PORT` / `DAYLIGHT_MINIO_CONSOLE_HOST_PORT` | `15432` / `16379` / `15673` / `15674` / `19000` / `19001` | 依赖的宿主机回环端口，仅绑 `127.0.0.1`；被占用时覆盖（见 §6） |

## 场景工作台存储（开发中）

新工作台 API `/api/scenarios` 始终要求登录，按用户隔离；所选邮箱必须属于当前用户。未启用 PostgreSQL 时，数据保存至 `DAYLIGHT_DATA_DIR/scenarios/<用户ID摘要>.json`，同进程写入串行并采用临时文件原子替换。启用 PostgreSQL 时使用 `app_settings` 的 `scenarios:<用户ID>` 行作为权威副本，事务及行锁串行更新；首次写入会承接该用户的本地数据。数据库写入失败不会静默回退到文件。建议阶段保存在事项上，采用后才改看板。招聘附件和执行记录仍在原邮箱的招聘资料里，工作台只按已关联邮件做只读引用。工作台内嵌的招聘页和发票页读取该工作台绑定的邮箱：招聘接口认请求头里属于当前用户的邮箱，发票列表用 `GET /api/state?mailbox=`，都不改活动邮箱。未拥有的邮箱仍拒绝。独立的 `/app/recruitment` 与 `/app/invoices` 继续使用活动邮箱。该 PG 路径尚需真实依赖及多实例验证，不能据代码实现宣称已完成生产验收。

部署需包含新增 `shared/` 与 `server/scenarios/`。侧栏「管理工作台」负责添加与移除入口；智能招聘与发票助手为官方模板，保研、申博、校招、投稿为社区模板，闭环能力不变。旧邮箱、招聘、附件及账号文件保留原位；账号历史类型字段不再限制功能。工作台确认后才会写入待办或日历。同一封邮件在多个工作台确认相同待办或相同时刻的日程时只写入一次，记录上会保留每个相关工作台，筛选任一工作台都能看到。事项可只读查看已关联附件名、已入库知识片段和执行记录中的工具名，不重新识别文件，也不返回草稿正文。从工作台写入的待办在登记已提交、已发送或对方确认前不能勾成完成。模板里标记了回执的阶段，没有回执不能进入；已有工作台保留旧快照，升级后才生效。勾选完成后工作台行动标出「待办已完成」，外部回执状态不变。从日历删除工作台写入的安排后，行动仍保留并标出「日程已从日历删除」。工作台本身可删除；已写入邮箱的待办、日程和招聘资料保留，删掉招聘工作台后不会自动再挂接。改期会把原日程标为已取消并保留关联，不删除原记录。作废通知只按最新这封通知生成行动，把已有材料标为已覆盖，并取消尚未确认的旧行动，不另建待准备材料。已经确认写入的待办和日程保留。模板按声明校验，页面表单和 JSON 包走同一白名单，不能附带代码或密钥。该链路已有本地夹具测试。2026-10-16 在本机 PostgreSQL 上用合成用户验证了场景行的写入、单进程并发、失败回滚，以及两个 Node 进程同时写入后都不丢失，并删除了探针行。尚未做 Kubernetes 多副本和真实邮箱、模型、SMTP 验收。

小 D 的审核草稿和请求记录按邮箱存放。未启用 PostgreSQL 时写入该邮箱目录的 `assistant-drafts.json`、`assistant-requests.json`；会议操作写入 `assistant-meetings.json`。启用 PostgreSQL 后以 `app_settings` 为权威，并留下 `.postgres` 标记。数据库不可用或权威记录缺失时拒绝继续，不会静默退回旧 JSON，以免重复发信。发信和飞书会议都要用户在审核卡确认后才执行。工作台里的「保存回复草稿」不发信；「放入小 D 审核」只创建待审核草稿，确认后才走这条发送流程。该路径已有本地测试，尚未做真实 SMTP 与飞书联调。
