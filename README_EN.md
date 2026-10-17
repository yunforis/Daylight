<div align="center">
  <img src="docs/assets/readme/banner.png" alt="Daylight — Turn messages into next steps." width="100%" />
  <p><strong>Turn messages into next steps.</strong></p>
  <p>An email-driven Agent workspace · UCloud AI Hackathon · Track B / AI Application</p>
  <p><strong><a href="README.md">简体中文</a> · English</strong></p>
  <p>
    <img src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&amp;logo=react&amp;logoColor=white" alt="React 19" />
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-43853D?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js >=22" />
    <img src="https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&amp;logo=postgresql&amp;logoColor=white" alt="PostgreSQL 17 in Compose" />
    <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white" alt="Docker Compose" />
    <img src="https://img.shields.io/badge/Agent-Human_in_the_loop-F4B544?style=flat-square" alt="Human-in-the-loop Agent" />
  </p>
  <p><a href="#overview">Overview</a> · <a href="#screenshots">Screenshots</a> · <a href="#architecture">Architecture</a> · <a href="#quickstart">Quick start</a> · <a href="#deploy">Deployment</a> · <a href="#usage">User guide</a> · <a href="docs/README.md">Documentation</a> · <a href="#contributing">Contribute</a></p>
</div>

<details>
<summary><strong>Contents</strong></summary>

[Overview](#overview) · [Quick start](#quickstart) · [Mailboxes](#mailboxes) · [Recruitment & invoices](#workflows) · [Screenshots](#screenshots) · [Architecture](#architecture) · [Deployment](#deploy) · [Operations](#operations) · [User guide](#usage) · [Templates](#templates) · [Development](#development) · [Verification & submission](#evidence) · [Roadmap](#roadmap) · [Contributing](#contributing)

</details>

---

<a id="overview"></a>
## ☀️ Overview

**Daylight is a self-hostable, customizable Agent workspace for email-driven work.** It brings mail, attachments, calendars, and tasks together to help people find notices, organize materials, track progress, and prepare replies.

The project grew out of daily email use at ShanghaiTech University. Event registration, competition deadlines, document requests, supervisor conversations, and interview changes arrive in the same inbox. Important messages are easy to miss and difficult to find again. Recruitment and invoice handling create similar work: connect candidates with their conversations, or check extracted fields against original receipts. **Opening an email does not mean the work is done.**

Daylight provides everyday mail/search/calendar/task tools alongside scenario workspaces that organize materials and progress. Recruitment and invoice handling are the main showcase flows; admission, research outreach, job applications, and publication templates extend the same approach.

| Common approach | With Daylight |
| --- | --- |
| Star a message and remember to revisit it | Associate notices with cases; track actions, stages, and materials separately |
| Repeatedly search the inbox | Ask about indexed mail/attachments and open the original from an answer |
| Switch between campus, personal, and work accounts | View one mailbox, a category, or all owned mailboxes |
| Rewrite calendar entries after changes | Retain earlier arrangements and link replacement events to their sources |
| Handle resumes and invoices as scattered attachments | Review them in dedicated recruitment/invoice pages alongside originals |

**Current delivery:** a Web workspace, presets, retrieval, Little D, and separate API / Worker / Scheduler roles in Compose. Records cover single-node cloud operation and selected real-service flows. Multi-server HA, sustained capacity, and user benefits require separate measurement. Uncollected survey placeholders are not treated as results, and no unmeasured efficiency gains are claimed. See [STATUS](STATUS.md).

<a id="quickstart"></a>
## ⚡ Quick start

With **Docker, Compose v2, Git, openssl, and curl** installed, run in Linux/macOS or Windows WSL:

```bash
git clone --branch feat/cloud-native-platform https://github.com/why121368/Daylight.git
cd Daylight
sh deploy/up.sh
```

Open **[http://localhost:3000](http://localhost:3000)**.

The script generates configuration/random service passwords, builds images, initializes the database/private bucket, and checks health. Host Node.js or database installations are unnecessary. This guide currently targets `feat/cloud-native-platform`; prefer the matching release Tag when published.

**First-use steps:** [bootstrap an admin](#admin-setup) → [configure system SMTP for registration](#system-mail) → [connect your inbox and model](#usage). Starting the platform does not connect private mailboxes or purchase model access.

- Full instructions and settings: [deployment](#deploy)
- Existing installation: [operations and troubleshooting](#operations)
- Code changes: [local development](#development)
- Implementation scope and competition materials: [verification and delivery](#evidence)

### Six preset workspaces

| Scenario | Cases and workflows | Business boundary |
| --- | --- | --- |
| **Recruitment** | Candidates, resume PDF/OCR, screening, retrieval, interview invitations, communication | Sending requires review; Feishu needs separate setup and authorization |
| **Invoice assistant** | Attachment extraction, field checks, original documents, reimbursement preparation | Verify against originals; invoice extraction does not automatically change tasks/events |
| **Graduate admission** | Summer programs, pre-admission, supervisor outreach; opportunities, materials, deadlines, interviews, changes | Positive feedback is not formal admission; portal actions require receipts |
| **PhD / overseas research / RA** | Contact context, research plan versions, time zones, follow-ups | Polite interest is not a position guarantee; retain original zone, UTC, and Beijing time |
| **Campus job applications** | Company/role progress, assessments, document requests, interviews, submissions | A document request does not imply advancement; platform/SMS/chat information requires input |
| **Publications & conferences** | Revisions, coauthor prerequisites, final manuscripts, registration, presentations | Submission/payment outcomes require external evidence |

One account can add multiple workspaces, without personal/HR feature restrictions. The template center currently places recruitment/invoices under official entries and other presets under the community category; that label does not mean an open third-party publishing marketplace exists.

### Platform capabilities

| Module | Main features | Notes |
| --- | --- | --- |
| **Recruitment** | Candidates, resume PDF/OCR, screening, interviews | Source citations; reviewed sending; optional Feishu |
| **Invoices** | Invoice number, parties, amounts, tax, items | Check against originals; open the source attachment |
| **Mailboxes** | Provider/custom IMAP/SMTP, categories, combined views | User/mailbox isolation, associations, external notices |
| **Calendar & tasks** | Month/week/day, deadlines, priorities, conflicts, changes | Sources, workspace filters, completion checks |
| **Cases & materials** | Stages, suggestions, material versions, prerequisites | History retained; receipts for designated stages |
| **Little D** | Mail lookup, briefings, calendar/tasks, draft replies | Speech input, meeting assistance, sending review |
| **Retrieval** | Mail/attachment/resume chunks, hybrid search, highlights | RRF, MMR, bounded embedding retries |
| **Templates** | Fields, stages, rules, materials, views, capabilities | JSON import/export, upgrades, visibility, deletion |
| **Background jobs** | Status, cancel/retry, checkpoints, mailbox ordering | Finite retry budgets, leases, stale-worker protection |
| **Logs & cost** | Tools, errors, duration, tokens, estimated costs | Call-time prices, known totals, pricing coverage |
| **Accounts** | Authentication, sessions, admin, configuration, search | Separate system and user mailbox SMTP |
| **Collaboration** | External calendars, private ICS, event materials/reports | Companion iOS project reuses shared APIs |

<a id="mailboxes"></a>
## 📬 Separate mailboxes, optional combined views

Categorize campus, personal, and work inboxes. Calendars/tasks follow the selected view; email Q&A and Little D knowledge search use that scope to find indexed notices.

<img src="docs/assets/readme/mailbox-scopes.png" alt="Mailbox categories and single, same-tag, and all-mailbox views" width="100%" />

| View | Useful for | Retrieval scope |
| --- | --- | --- |
| **Single mailbox** | Working in one inbox | Indexed content from the current owned mailbox |
| **Same category** | Campus or work inboxes together | Indexed content from owned mailboxes sharing the tag |
| **All mailboxes** | Finding a notice when its inbox is unclear, or reviewing schedules | Indexed content from all mailboxes owned by this user |

Combined viewing does not grant access to other users or broadcast writes. Ordinary event/draft/send operations still use the selected mailbox; workspaces use their bound mailboxes with ownership checks. Retrieval covers indexed content, not necessarily the entire mailbox history.

<a id="workflows"></a>
## 🧑‍💼 Two main workflows: recruitment and invoices

### Recruitment: from resume to interview communication

Receive application → store attachment → extract PDF text/OCR → organize candidate profile → conversational screening → prepare invitation → review and send.

Inspect candidate details, resumes, and origins; answers can reference source pages. Scans, extraction errors, and incomplete profiles require review/retry. Feishu meetings are optional and require configuration. Existing recruitment records are reused rather than duplicated when adding workspaces.

<details>
<summary>Recruitment processing diagram</summary>

<img src="docs/assets/readme/recruitment-flow.png" alt="Resume storage, OCR, chunk retrieval and invitation workflow" width="100%" />

</details>

### Invoices: from attachment to field checks

Find invoice attachment → extract number/date/parties/amount/tax/items → check original → prepare reimbursement materials.

Open/download originals from the invoice page. Extracted fields do not establish tax authenticity, reimbursement, or payment. Invoice recognition alone does not create calendar events/tasks.

<details>
<summary>Invoice processing diagram</summary>

<img src="docs/assets/readme/invoice-flow.png" alt="Invoice extraction, field checking and original attachment workflow" width="100%" />

</details>

<a id="screenshots"></a>
## 🖼️ Screenshots & demo

These are **screenshot placeholders**, selected around the core user journey. See the [capture checklist](docs/assets/readme/README.md) for what each should show. Architecture illustrations below use existing project assets and are not screenshots.

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/readme/recruitment-placeholder.svg" alt="Placeholder: candidates, resume citations and interviews" /><br /><b>01 · Recruitment: candidates & interviews</b></td>
    <td width="50%" align="center"><img src="docs/assets/readme/invoices-placeholder.svg" alt="Placeholder: invoice original and extracted fields" /><br /><b>02 · Invoices: originals & checks</b></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/readme/workbench-placeholder.svg" alt="Placeholder: opportunities, material versions, action dependencies" /><br /><b>03 · Workspaces: cases & materials</b></td>
    <td width="50%" align="center"><img src="docs/assets/readme/mail-placeholder.svg" alt="Placeholder: email, retrieval, cited answers and highlights" /><br /><b>04 · Mail: search & originals</b></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/readme/calendar-placeholder.svg" alt="Placeholder: cross-workspace conflicts and rescheduling" /><br /><b>05 · Calendar: conflicts & changes</b></td>
    <td width="50%" align="center"><img src="docs/assets/readme/tasks-placeholder.svg" alt="Placeholder: deadlines, completion evidence and sources" /><br /><b>06 · Tasks: deadlines & completion</b></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/readme/assistant-placeholder.svg" alt="Placeholder: Little D tools and email review card" /><br /><b>07 · Little D: tools & review</b></td>
    <td width="50%" align="center"><img src="docs/assets/readme/trace-placeholder.svg" alt="Placeholder: jobs, tool traces, duration and cost coverage" /><br /><b>08 · Execution: jobs & costs</b></td>
  </tr>
</table>

**Suggested demo:** recruitment email → resume/candidate → source lookup → prepare/review invitation, followed by invoice fields alongside the original. Campus notices and mailbox categories explain the motivation; admission and other templates illustrate extensions. Demonstrate live; use recordings as backups. See [demo notes](docs/submission/defense.md) and [submission checklist](docs/submission/README.md). Account access and demo URLs follow the release, without publishing private mailbox passwords.

<a id="architecture"></a>
## 🏗️ Architecture

<img src="docs/assets/readme/architecture.png" alt="Logical architecture: clients, API, Worker, Scheduler and shared persistence" width="100%" />

| Component | Responsibility | Technology and state |
| --- | --- | --- |
| **Web** | Workspaces, email, calendar, tasks, reviews, execution records | React 19, Vite 7, Tailwind CSS 4, shadcn/Radix, FullCalendar |
| **API** | Authentication, mailbox ownership, interaction, business commits, job receipts | Node.js 22+, Express; shared state in production |
| **Worker** | Mailbox synchronization, scenario planning, external calendar jobs | Durable claims, heartbeats, checkpoints, bounded retries |
| **Scheduler** | Scheduled synchronization and recovery coordination | Pending-sync checks and failure backoff avoid repeated buildup |
| **PostgreSQL** | Authoritative business snapshots, jobs, steps, outbox | Transactions, versions/CAS, leases and commit validation |
| **Redis** | Verification codes, session support, shared temporary state | Explicit production failures, no silent process-memory replacement |
| **RabbitMQ** | Confirmed notifications and job wakeups | PG owns job state; duplicate notifications are expected, polling recovers |
| **Object storage** | Attachments and files | Private MinIO in Compose; configurable US3, S3-compatible and other supported providers |
| **External services** | Mail, models, calendars, meetings | IMAP/SMTP, OpenAI-compatible Chat Completions, embeddings, optional Feishu |

### Topology & consistency

<img src="docs/assets/readme/deployment.png" alt="Single-node Compose topology: three application roles, four dependencies, two initializers and volumes" width="100%" />

Compose runs **7 persistent services + 2 one-shot initialization jobs**. The illustration's public `:3000` is a configurable exposure option; **the actual default is loopback `127.0.0.1:3000`**. Dependency host ports also bind only to loopback. Environment variables configure production, migrations and private bucket initialization run explicitly, and application services wait for successful initialization. Local development can use JSON/files; production does not treat silent file fallback as recovery.

Jobs and outbox entries commit together. Workers claim through PG, preserving mailbox order while allowing different mailboxes to run concurrently. Database steps can resume from checkpoints. SMTP and other remote effects cannot be rolled back with a database transaction: unknown outcomes remain `unknown` for reconciliation rather than blind resending. Scaling depends on independent mailboxes, database capacity, and provider quotas; KEDA examples are not proof of validated autoscaling.

See [code architecture](docs/submission/architecture.md), [reliability](docs/submission/reliability/README.md), and the [cloud-native roadmap](docs/cloud-native-roadmap.md). The separate iOS client is not built in this repository; it shares authentication/mailbox/calendar APIs, controlled native CORS, and private ICS subscriptions.

### Agent control flow

<img src="docs/assets/readme/agent-control.png" alt="Agent ingestion, understanding, decision rules, human confirmation and execution" width="100%" />

1. **Read and associate:** access permitted emails/attachments or supplied notices; identify the relevant case.
2. **Understand and propose:** combine rules/model context into stage, material, deadline, appointment, and draft suggestions.
3. **Review and execute:** check targets, times, conflicts, and prerequisite receipts; confirm workspace actions.
4. **Track and recover:** retain sources, states, tool results, costs, later changes, errors, and retries.

Email is data, not instructions. Read, prepared, sent, submitted, and acknowledged are distinct. Workspace writes require confirmation; basic email synchronization can create events/tasks from extraction results. Actual sending uses a separate review step. Invalid model output, tool failures, and ambiguity must remain visible in state and traces.

<a id="deploy"></a>
## 🚀 One-command deployment: Docker Compose

### 1. Prerequisites

| Dependency | Requirement |
| --- | --- |
| System | Linux; Docker Desktop on macOS; Docker Desktop + WSL2 on Windows, with commands run in WSL Bash |
| Tools | Git, Docker Engine/Desktop, Compose v2 plugin, `sh`, `openssl`, `curl` |
| Resources | A 4-vCPU / approximately 8-GiB cloud node has validation records; use as a trial reference, not a minimum or capacity guarantee |
| Network | Access to container registries, npm, system package mirrors; live use also needs mail/model endpoints, and OCR may download language packs |

The Docker path does not require host Node.js, PostgreSQL, Redis, or RabbitMQ. Start Docker and check:

```bash
docker info
docker compose version
openssl version
curl --version
```

### 2. Clone and start

```bash
git clone --branch feat/cloud-native-platform https://github.com/why121368/Daylight.git
cd Daylight
sh deploy/up.sh
```

With Node.js installed, `npm run deploy:up` is equivalent. The script:

- Generates `deploy/compose.env` once, with independent random passwords/JWT secret and mode `600`; reuses existing files.
- Validates Compose, builds the frontend/runtime image, starts PG/Redis/RabbitMQ/MinIO.
- Runs `migrate` and `minio-init`, then starts API/Worker/Scheduler.
- Waits for health and probes `/health/live` and `/health/ready`, then prints the entry URL.

Open **[http://localhost:3000](http://localhost:3000)**. **Exited (0)** is expected for `migrate` and `minio-init`; the other 7 services should be healthy. This provisions the platform; initialize accounts, mailboxes, and models below.

<details>
<summary>View startup-order illustration</summary>

<img src="docs/assets/readme/startup.png" alt="Dependency health, migration, bucket initialization and application readiness" width="100%" />

</details>

<a id="admin-setup"></a>
### 3. Bootstrap the administrator

There is no default account/password. Enter the running API container and **choose a password of at least 8 characters**; terminal echo is disabled while reading it:

```bash
docker compose --env-file deploy/compose.env -p daylight exec \
  -e DAYLIGHT_ADMIN_EMAIL=admin@example.com \
  -e DAYLIGHT_ADMIN_USERNAME=admin api sh -ec '
  trap "stty echo 2>/dev/null || true" EXIT
  printf "Set administrator password (at least 8 characters): "
  stty -echo
  IFS= read -r DAYLIGHT_ADMIN_PASSWORD
  stty echo
  printf "\n"
  export DAYLIGHT_ADMIN_PASSWORD
  node scripts/bootstrap-admin.js
'
```

Replace `admin@example.com` with your email. Sign in at `/login` or `/admin/login` with that email or `admin` and your password. Rerunning updates the password/promotes the same email account. In production the script updates PostgreSQL accounts only; deployment configuration stays in environment variables, managed through `deploy/compose.env`.

<a id="system-mail"></a>
### 4. Enable registration and password-reset email

The bootstrapped administrator can sign in without registering. Self-service registration needs **system SMTP**. Edit these values in `deploy/compose.env`, then rerun `sh deploy/up.sh` to recreate services:

```dotenv
DAYLIGHT_SYSTEM_MAIL_ENABLED=1
DAYLIGHT_SYSTEM_MAIL_HOST=smtp.example.com
DAYLIGHT_SYSTEM_MAIL_PORT=465
DAYLIGHT_SYSTEM_MAIL_SECURE=1
DAYLIGHT_SYSTEM_MAIL_USER=your-system-mailbox@example.com
DAYLIGHT_SYSTEM_MAIL_PASS=your-smtp-authorization-code
DAYLIGHT_SYSTEM_MAIL_FROM=your-system-mailbox@example.com
DAYLIGHT_PUBLIC_BASE_URL=https://daylight.example.com
```

Use your provider's actual settings. Port 465 commonly uses direct TLS; 587/STARTTLS generally uses `SECURE=0`. System mail sends registration/reset messages. User inbox IMAP/SMTP is configured separately after login. Production infrastructure configuration is environment-managed.

### 5. Ports, project names & remote access

During **first-time environment generation**, you can set:

```bash
DAYLIGHT_PORT=3080 DAYLIGHT_PROJECT=daylight-demo sh deploy/up.sh
```

If `deploy/compose.env` already exists, edit `DAYLIGHT_PORT` there; first-generation options do not rewrite it. Keep the same `-p` project name for subsequent operations, or you will create another set of volumes. Coexisting projects also need different dependency host ports in their environment files.

| Setting | Default | Purpose |
| --- | --- | --- |
| `DAYLIGHT_BIND_ADDRESS` / `DAYLIGHT_PORT` | `127.0.0.1` / `3000` | API exposure; controlled remote trials may use `0.0.0.0` with firewall rules |
| `DAYLIGHT_PUBLIC_BASE_URL` | `http://localhost:3000` | External URL and mail links; a domain still needs a real reverse proxy/TLS setup |
| `DAYLIGHT_ENV_FILE` | `deploy/compose.env` | Environment file for `up.sh`; create custom parent directories first |
| `DAYLIGHT_PROJECT` | `daylight` | Compose project for `up.sh`; volumes/networks are project-scoped |
| `DAYLIGHT_WAIT_TIMEOUT` | `600` seconds | Health wait timeout in `up.sh` |
| `DEBIAN_MIRROR` | Generator: `deb.debian.org` | Debian build mirror; does not change the container registry |
| `DAYLIGHT_JOB_TIMEOUT_MS` | Compose template: `900000` | Per-job budget; tune slow batch-model workflows using logs |
| `DAYLIGHT_METRICS` | Disabled | Set `1` in the environment file and recreate services to collect metrics |

For restricted networks, the first run can use `DEBIAN_MIRROR=mirrors.aliyun.com sh deploy/up.sh`; edit `DEBIAN_MIRROR` directly in an existing environment file. This only changes Debian package downloads; container registries must remain reachable.

Full settings: [environment example](deploy/compose.env.example), [Compose](docker-compose.yml), [DEPLOY](DEPLOY.md). Dependency host ports default to PG `15432`, Redis `16379`, MQ `15673`, MQ management `15674`, MinIO `19000` / console `19001`, **all loopback-only**. Change the corresponding `DAYLIGHT_*_HOST_PORT` / console-port variables if occupied. Public deployments should terminate HTTPS at a reverse proxy supporting SSE; setting a URL does not provision certificates.

<a id="operations"></a>
## 🔧 Operations & updates

Commands below use the default file/project; adjust both arguments for custom deployments.

```bash
# Services and one-shot initialization status
docker compose --env-file deploy/compose.env -p daylight ps -a

# Recent application logs
docker compose --env-file deploy/compose.env -p daylight logs --tail 100 api worker scheduler

# Liveness and readiness; adjust custom ports
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready

# More Workers: one mailbox remains ordered; independent mailboxes gain concurrency
docker compose --env-file deploy/compose.env -p daylight up -d --scale worker=3

# Stop/start while retaining volumes
docker compose --env-file deploy/compose.env -p daylight stop
docker compose --env-file deploy/compose.env -p daylight start
```

Preserve both `deploy/compose.env` and named volumes. **Do not regenerate credentials for existing volumes by deleting the environment file, and do not use `down --volumes` on retained environments.** For updates, back up, fetch/review the intended version, then rerun `sh deploy/up.sh`; it rebuilds and runs explicit migrations. It is not an automatic rollback system. Validate old-code/new-schema compatibility beforehand.

Fresh migrations do not automatically import host `data/`. Existing users/business data/attachments require a backup-reviewed migration process; see [migration script](scripts/migrate-production-data.mjs) and [production execution notes](docs/submission/cloud-native-execution.md). The partial `import-storage.js` importer is not a complete migration of every module.

<details>
<summary>View failure and recovery illustration</summary>

<img src="docs/assets/readme/recovery.png" alt="Failure and recovery design illustration; actual verification scope is tracked separately" width="100%" />

</details>

### Metrics & troubleshooting

After enabling `DAYLIGHT_METRICS=1`, inspect the shared metrics volume from the API container:

```bash
docker compose --env-file deploy/compose.env -p daylight exec -T api node scripts/metrics-report.mjs /var/lib/daylight-metrics
```

| Symptom | Check first |
| --- | --- |
| Docker unavailable / Compose missing | Docker daemon, permissions, Compose v2; use WSL on Windows |
| Image pulls/builds fail | Registry, npm/apt access; `DEBIAN_MIRROR` changes apt only; inspect logs |
| Port occupied | API and dependency loopback ports; edit the environment file and retry |
| `migrate` / `minio-init` exits nonzero | Initializer logs, credentials, existing volumes; apps wait for successful initialization |
| No registration code | System SMTP is disabled by default; bootstrap an admin, configure SMTP, recreate and verify |
| Signed in but mailbox empty | Login email is not automatically an inbox; add IMAP and check ownership/sync range |
| Model/embedding failures | Base URL, key, model, JSON/Embedding compatibility, quotas, network; inspect jobs/traces |
| Keyword-only retrieval | RAG flags, embedding configuration and `embeddedCount`; rebuild the index and inspect limits |
| Configuration unchanged | Recreate containers for changed environment variables; `restart` does not reload them, and `up.sh` preserves existing env files |
| Reply result `unknown` | Reconcile actual sending/receipt first, then use the recovery path; avoid duplicates |

See [deployment details](DEPLOY.md), [calendar reconciliation API](docs/calendar-recovery-api.md), and [STATUS](STATUS.md).

<a id="usage"></a>
## 🧭 User guide

1. **Connect email:** add IMAP/TLS and provider authorization credentials; configure SMTP for replies. QQ examples: `imap.qq.com:993`, `smtp.qq.com:465`. Other accounts depend on provider permissions and networking.
2. **Configure models:** enter an OpenAI-compatible Chat Completions Base URL, key, and model supporting `response_format: { type: 'json_object' }`. Vector retrieval also needs embeddings; keyword search can operate without them. Check actual retrieval mode.
3. **Sync and search:** inspect categories, summaries, extracted results, errors, and cited source passages. The recent-N-message scope is not a guarantee of complete historical scanning.
4. **Add a workspace:** choose a preset, bind your mailboxes, create opportunities/cases, associate notices or paste external sources, inspect materials and suggestions.
5. **Confirm actions:** verify deadlines, zones, targets, conflicts, and stage suggestions before writes. Record sent/submitted/acknowledged separately. Adding a prerequisite task alone does not unlock later actions; its required receipt must be completed.
6. **Use Little D:** query, plan, draft, review recipients/body/evidence, then confirm sending. Saving a draft or manually recording “sent” does not send SMTP. Use review cards; the older production trace-page direct-send route still has a migration boundary.
7. **Follow changes:** later updates preserve sources/history and link old/new events. `/app/jobs` shows background state and permitted retries/cancellation; traces expose duration and cost.

Templates are declarative JSON, not arbitrary executable code. Deleting a workspace preserves previously written mailbox events/tasks/recruitment data; hiding an entry also preserves data. External calendar failures/unknown outcomes follow recovery contracts. Unconnected portals, payments, and submission systems cannot be marked successful automatically.

<a id="templates"></a>
## 🧩 Create your own workspace

Use “Create template” in My Workspaces, or export and edit an existing definition. Personal templates configure fields, business stages, notice signals, materials, views, and allowed features. Multiple workspace instances can use one definition while keeping separate cases and business records.

1. Choose fields such as university, role, or organizer.
2. Define stages such as new, following up, and done; require receipts for selected stages.
3. Add keywords, handling rules, materials, and allowed mail/task/calendar features.
4. Replay template samples, then create a workspace and bind your mailbox.
5. Export JSON for reuse and import it as a personal template.

Try the [campus follow-up example](docs/examples/campus-followup.template.json) through the import UI. It contains no user records; labels are Chinese, matching the sample workflow. Sample replay previews rules without sending email or calling a paid model.

| Definition | Meaning |
| --- | --- |
| `format` / `schemaVersion` | Package format `daylight-scenario-template`, current schema `1` |
| `fields` / `stages` | Fields and business stages; types: text, email, url, number, date, timezone |
| `signals` / `rules` | Keyword-based suggestions and rules used during model analysis |
| `capabilities` / `views` | Platform feature/view allowlists, with no executable code |
| `materials` / `samples` | Materials and privacy-safe examples |

Imported personal packages cannot activate the built-in recruitment/invoice adapters or bypass ownership. Inspect text and samples before sharing: structural filtering does not identify every private detail. The [shared definition](shared/scenario-templates.js) is the contract.

**Community direction:** discover, share, and update templates with versioning, review, and permission controls. Admission and other presets currently shown in the community category are bundled content. An open third-party publishing market and arbitrary-code plugins are not available.

<a id="development"></a>
## 💻 Local development & alternative deployments

Local development requires **Node.js ≥22 and npm**:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`; workspace `/app`. The default is `DAYLIGHT_RUNTIME=local`. Use an isolated `DAYLIGHT_DATA_DIR` for write-based demos. Bootstrap a local admin with the same script, supplying the password through the environment as above: `node scripts/bootstrap-admin.js --email admin@example.com --username admin`. Local mode saves authentication configuration; production uses environment variables.

```bash
# Build and serve the compiled frontend
npm run build
npm start

# Tests with an independent data directory (POSIX shell)
DAYLIGHT_DATA_DIR="$PWD/work/readme-test" npm test
```

The `--production` argument in `npm start` selects built frontend assets; **strict production runtime additionally requires `DAYLIGHT_RUNTIME=production` and shared dependency configuration**. Separate roles use `npm run start:worker` and `npm run start:scheduler`; `npm start` does not launch them automatically.

| Method | Entry | Requirements |
| --- | --- | --- |
| **Compose** | `sh deploy/up.sh` | Recommended complete single-node setup; dependencies, migration, bucket initialization |
| **Kubernetes** | [Manifests and order](deploy/README.md#kubernetes-with-external-managed-dependencies) | Cluster, controlled Secrets, dependencies, registry; run migration Job before apps; cluster acceptance still required |
| **Native systemd** | [Units and configuration](deploy/systemd/README.md) | Linux alternative with separately provisioned shared services |
| **Existing Windows runtime** | [PowerShell tools](scripts/production.ps1) | Specialized path for existing local runtime configuration, not a fresh-machine one-command installer |

### Script reference

| Command / script | Purpose and prerequisites |
| --- | --- |
| `sh deploy/up.sh` / `npm run deploy:up` | Generate/reuse configuration, build/start, health-check |
| `scripts/bootstrap-admin.js` | Create/promote administrator; 8+ character password; rerun may update password |
| `scripts/migrate.js` | Explicit schema migration and empty settings bootstrap; automatic in Compose |
| `scripts/bootstrap-settings.js` | Initialize empty settings without reading local email data |
| `scripts/migrate-production-data.mjs` | Existing users/business/attachments; follow backup and plan contracts |
| `sh deploy/verify-compose.sh` | Disposable project deployment/health/module checks, cleanup of own volumes; Docker, openssl, Python 3 |
| `sh deploy/verify-migrations.sh` | Isolated migration/idempotency checks |
| `scripts/verify-jobs.mjs` / `verify-production.mjs` | Jobs/business commits with dedicated PG/MQ; see reliability docs for dependencies/gates |
| `scripts/verify-concurrency.mjs` | Concurrency, leases, isolation, CAS with isolated dependencies |
| `scripts/verify-oss.mjs` / `verify-real-mail.mjs` | Live storage/mail checks with controlled credentials/authorization; may call external services |
| `scripts/verify-redis-restart.mjs` | Temporary Redis disconnect/recovery check; requires `redis-server` |
| `scripts/load-test.mjs` / `benchmark-jobs.mjs` | Synthetic jobs, not live-model business throughput |
| `npm run metrics:report -- <dir>` | Recompute distributions/overhead from previously collected metrics |
| `node scripts/evaluate-mail.js --validate` | Zero-network dataset validation; `--live` needs configuration and an explicit budget |

<a id="evidence"></a>
## 📊 Verification, performance & competition delivery

Records cover cloud Compose deployment, live IMAP/model/SMTP flows, object storage, hybrid retrieval, and real-dependency tests. **Historical counts apply only to their recorded version/environment**, not automatically to current uncommitted edits or every integration. This documentation revision's check scope is recorded in STATUS.

Costs are estimates using actual usage and call-time prices, with known totals/means and coverage; missing portions stay unknown. Partially priced traces are not the entire bill. Performance matrices use real PG/MQ with synthetic handlers and cannot directly express real emails processed per second. Placeholder survey charts are not presented as measured user benefit.

| Track B deliverable | Repository entry |
| --- | --- |
| Seven-chapter report: value, architecture, Agent, failures, evaluation, cost, deployment | [LaTeX/build guide](docs/hackathon-report/README.md) · [Source](docs/hackathon-report/daylight-report.tex) |
| Deployment and reproduction | [Deployment assets](deploy/README.md) · [Configuration](DEPLOY.md) · [Cloud acceptance](docs/submission/deployment/README.md) |
| Architecture and reliability | [Architecture](docs/submission/architecture.md) · [Failure matrix](docs/submission/reliability/README.md) |
| Performance/cost and observability | [Raw measurements](docs/submission/performance/README.md) · [Instrumentation](docs/submission/observability/README.md) |
| Slides, live demo, backup video | [Speaker notes and script](docs/submission/defense.md); final files/video follow the release checklist |
| Frozen version and source snapshot | [Submission checklist](docs/submission/README.md) · [Release freeze](docs/submission/release.md) |

HTTPS, Kubernetes replicas, cross-node HA, backup/restore, rollback, soak testing, and measured user benefit still require final-version evidence. An integration endpoint does not establish every provider's live connectivity; Feishu and external calendar acceptance are tracked separately. Supporting technical documents are primarily Chinese.

## 📁 Repository map

```text
Daylight/
├── src/                        # Pages, components, workspace state
├── server/
│   ├── index.js                # API / Web entry
│   ├── worker.js               # Background execution
│   ├── scheduler.js            # Scheduling
│   ├── jobs/                   # Durable jobs, leases, outbox, notifications
│   ├── scenarios/              # Workspaces, sources, materials, actions, receipts
│   ├── storage/                # Shared state and transactional commits
│   ├── rag/                    # Chunks, indexing, retrieval, answers
│   └── infra/                  # PostgreSQL / Redis / MQ / OSS
├── shared/                     # Shared templates and definitions
├── scripts/                    # Bootstrap, migration, verification, measurement
├── deploy/                     # Compose, Kubernetes, systemd
├── docs/assets/readme/         # Versioned illustrations and screenshot placeholders
├── docs/submission/            # Competition delivery and evidence
├── docs/hackathon-report/      # LaTeX report
├── Dockerfile
└── docker-compose.yml
```

<a id="roadmap"></a>
## 🗺️ Progress & roadmap

| Area | Current scope | Next steps |
| --- | --- | --- |
| **Campus and multiple inboxes** | Categories, combined views, retrieval, calendars/tasks | More natural notices; record omissions, corrections, and handling time |
| **Recruitment and invoices** | Two built-in workspaces reusing attachments, models, retrieval, and review | Complex files, retries, and ongoing conversations |
| **Custom workspaces** | Declarative definitions, personal import/export, fields/stages/rules | Community sharing, versions, review |
| **Web / iOS / Desktop** | Web is this repository's main client; iOS is connected and Desktop has an initial version; companion clients remain in development | Installers and feature coverage documented with releases |
| **Android / HarmonyOS** | Planned | Gradually build clients using shared APIs |
| **Cloud operations** | Single-node Compose and selected live flows validated | HTTPS, backup/restore, multiple servers, scaling, rollback, soak tests |

This is direction, not a release-date promise or completed acceptance. Companion iOS/Desktop projects and installers are not built by this repository's Docker image; the Web client is directly deployable.

<a id="contributing"></a>
## 🤝 Contributing

Help with bugs, deployment docs, representative mail formats, privacy-safe templates, translations, and UI improvements. Read [CONTRIBUTING](CONTRIBUTING.md) first.

- **Questions and bugs:** [Issues](https://github.com/why121368/Daylight/issues), with version, runtime, reproduction steps, expected/actual behavior, and sanitized logs.
- **Code:** [Pull requests](https://github.com/why121368/Daylight/pulls), explaining the problem and validation; test new behavior with isolated data.
- **Templates and scenarios:** describe users, real steps, external dependencies, and required confirmations, without private mail.
- **Sensitive reports:** do not publish credentials or exploitable details in public Issues; use a private channel provided by maintainers.

## 🛡️ Data, licensing & feedback

Keep mail, attachments, and credentials in controlled environments. Model analysis sends relevant context to your chosen provider. Do not commit `data/`, `deploy/compose.env`, private ICS links, or unauthorized screenshots/logs. Compose currently uses MinIO root credentials for its isolated single-node setup; hosted operation should use least-privilege application credentials and reviewed secret/backup management.

See [asset provenance and replacement rules](docs/assets/readme/README.md). Report issues and scenario proposals through [Issues](https://github.com/why121368/Daylight/issues). No LICENSE file is currently provided; maintainers must clarify usage/distribution terms separately.

<div align="center">
  <br />
  <strong>Daylight · Turn messages into next steps.</strong>
  <p>Find your mail. Keep track of what comes next.</p>
</div>
