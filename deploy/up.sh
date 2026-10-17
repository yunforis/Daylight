#!/usr/bin/env sh
# Daylight 一键启动：生成环境文件（首次）→ 校验 compose → 构建并启动整套服务 → 健康检查。
#
#   sh deploy/up.sh
#   sh deploy/up.sh                            # 复用/生成 deploy/compose.env
#   DAYLIGHT_ENV_FILE=/opt/daylight/compose.env sh deploy/up.sh
#   DAYLIGHT_PROJECT=daylight-test sh deploy/up.sh
#
# 首次运行会用 openssl 生成随机密码写入环境文件（权限 600），此后一直复用，不会覆盖已有文件。
# 环境文件放在仓库外的绝对路径时也不会被提交；仓库内默认路径由 .gitignore 忽略。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE=${DAYLIGHT_ENV_FILE:-$ROOT/deploy/compose.env}
ENV_EXAMPLE=${DAYLIGHT_ENV_EXAMPLE:-$ROOT/deploy/compose.env.example}
PROJECT=${DAYLIGHT_PROJECT:-daylight}
WAIT_TIMEOUT=${DAYLIGHT_WAIT_TIMEOUT:-600}
HEALTH_PATH_LIVE=${DAYLIGHT_HEALTH_PATH_LIVE:-/health/live}
HEALTH_PATH_READY=${DAYLIGHT_HEALTH_PATH_READY:-/health/ready}

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1" >&2; exit 1; }; }
need docker
need openssl
need curl
docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose 插件（v2）" >&2; exit 1; }

read_env_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

generate_env() {
  echo "未找到环境文件，正在生成：$ENV_FILE"
  umask 077
  while IFS= read -r line; do
    case "$line" in
      POSTGRES_PASSWORD=*) printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" ;;
      REDIS_PASSWORD=*) printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" ;;
      RABBITMQ_PASSWORD=*) printf 'RABBITMQ_PASSWORD=%s\n' "$(openssl rand -hex 32)" ;;
      MINIO_ROOT_PASSWORD=*) printf 'MINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 32)" ;;
      DAYLIGHT_JWT_SECRET=*) printf 'DAYLIGHT_JWT_SECRET=%s\n' "$(openssl rand -hex 48)" ;;
      DAYLIGHT_BIND_ADDRESS=*) printf 'DAYLIGHT_BIND_ADDRESS=%s\n' "${DAYLIGHT_BIND_ADDRESS:-127.0.0.1}" ;;
      DAYLIGHT_PORT=*) printf 'DAYLIGHT_PORT=%s\n' "${DAYLIGHT_PORT:-3000}" ;;
      DAYLIGHT_PUBLIC_BASE_URL=*) printf 'DAYLIGHT_PUBLIC_BASE_URL=%s\n' "${DAYLIGHT_PUBLIC_BASE_URL:-http://localhost:${DAYLIGHT_PORT:-3000}}" ;;
      DAYLIGHT_ADMIN_EMAILS=*) printf 'DAYLIGHT_ADMIN_EMAILS=%s\n' "${DAYLIGHT_ADMIN_EMAILS:-admin@example.com}" ;;
      DEBIAN_MIRROR=*) printf 'DEBIAN_MIRROR=%s\n' "${DEBIAN_MIRROR:-deb.debian.org}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$ENV_EXAMPLE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ENV_EXAMPLE" ] || { echo "缺少示例环境文件：$ENV_EXAMPLE" >&2; exit 1; }
  generate_env
else
  echo "复用已有环境文件：$ENV_FILE"
fi

echo "校验 compose 配置…"
docker compose --env-file "$ENV_FILE" -p "$PROJECT" config --quiet

echo "构建并启动（--build --wait，超时 ${WAIT_TIMEOUT}s）…"
docker compose --env-file "$ENV_FILE" -p "$PROJECT" up -d --wait --wait-timeout "$WAIT_TIMEOUT" --build

echo
echo "服务状态："
docker compose --env-file "$ENV_FILE" -p "$PROJECT" ps

BIND=$(read_env_value DAYLIGHT_BIND_ADDRESS); BIND=${BIND:-127.0.0.1}
[ "$BIND" = "0.0.0.0" ] && BIND=127.0.0.1
PORT=$(read_env_value DAYLIGHT_PORT); PORT=${PORT:-3000}
PUBLIC=$(read_env_value DAYLIGHT_PUBLIC_BASE_URL); PUBLIC=${PUBLIC:-http://$BIND:$PORT}

echo
echo "健康检查："
for path in "$HEALTH_PATH_LIVE" "$HEALTH_PATH_READY"; do
  url="http://$BIND:$PORT$path"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
  echo "  GET $url -> $code"
  if [ "$code" != "200" ]; then
    echo "健康检查失败：$url" >&2
    echo "查看日志：docker compose --env-file $ENV_FILE -p $PROJECT logs --tail 200" >&2
    exit 1
  fi
done

echo
echo "完成。访问入口：$PUBLIC"
