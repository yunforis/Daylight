# systemd 部署单元（原生安装路径）

云端单节点验证最初使用原生 systemd 单元，而不是容器。当时的原因是目标实例**尚未安装 Docker**（早期一度记为「无法访问 Docker Hub」，该归因已更正）。后续已在同一实例安装 Docker 并通过 Docker Compose 跑通全栈，应用现由 Compose 承载，本目录的单元作为可复现的基线保留。详见 [部署验收报告](../../docs/submission/deployment/README.md)。本目录保存**在验证实例上实际运行**的三个单元文件，可直接复制到 `/etc/systemd/system/` 复现。

## 单元

| 单元 | 入口 | 健康端口 |
| --- | --- | --- |
| `daylight-api.service` | `node server/index.js --production` | 业务端口 3000（`/health/live`、`/health/ready`） |
| `daylight-worker.service` | `node server/worker.js` | `DAYLIGHT_HEALTH_PORT=3002` |
| `daylight-scheduler.service` | `node server/scheduler.js` | `DAYLIGHT_HEALTH_PORT=3003` |

三个单元共同的约定：

- `WorkingDirectory=/opt/daylight/app`，`EnvironmentFile=/opt/daylight/.env`（权限 `600`）。
- `Restart=always`、`RestartSec=3`；停机用 `SIGTERM`，`TimeoutStopSec=60`（与应用的有界关闭流程配合，超时后由 systemd 强制结束）。
- `After=` / `Wants=` PostgreSQL、Redis、RabbitMQ，保证依赖先启动；应用自身仍会在依赖不可用时拒绝转为 ready（不静默降级）。
- 日志追加到 `/var/log/daylight/<role>.log`（`logrotate` 未内置，按需配置）。

## 安装与验证

```sh
# 1. 放置代码与配置
sudo install -d -m 755 /opt/daylight /opt/daylight/app /var/log/daylight
sudo cp -a . /opt/daylight/app            # 或 rsync 发布产物
sudo install -m 600 deploy/compose.env.example /opt/daylight/.env   # 再填真实值

# 2. 迁移数据库（幂等，不导入本地 JSON）
set -a; . /opt/daylight/.env; set +a
node /opt/daylight/app/scripts/migrate.js

# 3. 安装并启动服务
sudo cp deploy/systemd/daylight-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daylight-api.service daylight-worker.service daylight-scheduler.service

# 4. 验证
systemctl is-active daylight-api.service daylight-worker.service daylight-scheduler.service
curl -fsS http://127.0.0.1:3000/health/ready
curl -fsS http://127.0.0.1:3002/health/ready
curl -fsS http://127.0.0.1:3003/health/ready
```

`/health/ready` 返回 `{"ok":...,"role":...,"draining":...,"metrics":{...}}`：`metrics.enabled` 反映埋点开关，`written`/`dropped`/`sinkError` 用于在线确认埋点是否真的在写、有没有丢样。`ready` 为 503 表示依赖或 schema 未就绪，此时不要接入流量。

生产环境变量清单见 [DEPLOY.md](../../DEPLOY.md#生产模式环境变量daylight_runtimeproduction)。
