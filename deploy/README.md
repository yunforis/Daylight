# Deployment assets

These assets describe a production-mode topology. Passing local checks does not constitute cloud deployment, capacity, or production acceptance. API, Worker and Scheduler share one image; PostgreSQL holds business and job state, Redis holds shared ephemeral state, RabbitMQ carries job wakeups, and private S3-compatible storage holds attachments.

## One-command bring-up

`sh deploy/up.sh` (or `npm run deploy:up`) is the one-command path: on first run it generates `deploy/compose.env` with `openssl`-random passwords (mode `600`, gitignored), validates the Compose file, runs `docker compose up -d --wait --build`, then probes `/health/live` and `/health/ready`. Later runs reuse the existing environment file. Point it elsewhere with `DAYLIGHT_ENV_FILE=/opt/daylight/compose.env sh deploy/up.sh` and pick a project name with `DAYLIGHT_PROJECT=daylight-2`. Overridable during first-run generation: `DAYLIGHT_BIND_ADDRESS`, `DAYLIGHT_PORT`, `DAYLIGHT_PUBLIC_BASE_URL`, `DAYLIGHT_ADMIN_EMAILS`, `DEBIAN_MIRROR`.

Run `sh deploy/verify-compose.sh` for an isolated disposable check with generated credentials, a random project name and an automatically allocated loopback port. It builds the image, starts all services, checks readiness and native PDF/canvas/OCR module loading, reruns migrations, then removes only its own project and volumes. This does not perform real mailbox/model calls or OCR recognition and does not validate cloud reliability.

## Verified single-node bring-up (2026-10-17)

The complete stack has been brought up on a real cloud instance with one command:

```sh
docker compose --env-file /opt/daylight/compose.env -p daylight up -d --wait --build
```

All nine services reached the expected state — `api`, `worker`, `scheduler`, `postgres`, `redis`, `rabbitmq` and `minio` healthy; `migrate` and `minio-init` exited `0` — and the full test suite plus every real-dependency script were then re-run against that topology. Results, monitoring commands and remaining boundaries: [docs/submission/deployment/README.md](../docs/submission/deployment/README.md).

Two environment notes for restricted networks:

- `DEBIAN_MIRROR` (for example `mirrors.aliyun.com`) replaces Debian's default CDN while the runtime image is built; apt also forces IPv4, because a dual-stack host can resolve the CDN to a black-holed IPv6 address and hang. The default is `deb.debian.org`.
- Dependency services publish on **loopback-only** host ports (`15432` / `16379` / `15673` / `15674` / `19000` / `19001` by default, overridable) so host-side tooling such as `scripts/verify-*.mjs`, `scripts/load-test.mjs`, `scripts/probe-pg-commit.mjs` and `npm run metrics:report` can reach them. They are never bound to a public interface. Override them in the environment file when those ports are already taken.

## Isolated Compose environment

Copy `deploy/compose.env.example` to a gitignored environment file and replace every placeholder. Generate independent hex passwords (`openssl rand -hex 32`); the database, Redis and AMQP credentials are interpolated into URLs, so other special characters require URL encoding. The example values are documentation, not generated secrets. Configure system SMTP before testing registration. All services use project-scoped volumes and networks; no host `data/` directory is mounted. Only the API publishes a host port, bound to loopback by default. MinIO uses private buckets; root credentials are suitable for this isolated topology, while a hosted deployment should issue bucket-scoped application credentials.

```sh
docker compose --env-file .env.compose -p daylight-sandbox config --quiet
docker compose --env-file .env.compose -p daylight-sandbox build
docker compose --env-file .env.compose -p daylight-sandbox up -d --wait --wait-timeout 300
docker compose --env-file .env.compose -p daylight-sandbox ps -a
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Use an unused `DAYLIGHT_PORT` when another application already owns port 3000. The dependency health checks precede the one-shot schema migration and private bucket initializer; app services wait for those jobs to finish successfully. The migration does not import existing JSON data. Migration failure stops application startup. A production cutover with existing data requires an explicit data migration and backup plan.

Scale independent consumers with `docker compose --env-file .env.compose -p daylight-sandbox up -d --scale worker=3`. The scheduler replica count should follow the implemented database coordination policy. All roles receive SIGTERM and have 90 seconds to drain; work that exceeds this deadline relies on persistent job leases/recovery. `/health/live` checks process liveness and `/health/ready` checks usable dependencies; Worker/Scheduler expose these on port 3001 internally.

For an isolated verification environment only, `docker compose --env-file .env.compose -p daylight-sandbox down --volumes` removes that project's containers and persistent volumes. Do not run it against a project containing data to preserve. Use PostgreSQL backups, object-store backups/versioning and recovery drills for retained environments. Images and assets do not include repository secrets, user `data/`, reports, or local test artifacts.

`scripts/migrate.js` also explicitly bootstraps the `app_settings/default` row with empty credentials and no mailboxes. `ON CONFLICT DO NOTHING` preserves existing settings, timestamps and versions on every rerun. The same empty-install operation can be invoked separately with `node scripts/bootstrap-settings.js`; it never reads local files or imports user data. Missing default settings should make service readiness fail; this is part of application health integration, not schema creation on a request path.

Run `sh deploy/verify-migrations.sh` for an independent real PostgreSQL check of fresh bootstrap and non-overwriting migration reruns, including native module smoke checks. It builds the current source under a random image tag, uses a random Compose project and credentials, and removes its containers/network/volumes on exit. Service logs are saved under `deploy/verification/`. Run `sh deploy/verify-compose.sh` for the complete topology, frontend, role health and graceful shutdown checks. Both scripts require dependency images to be available; see `VALIDATION.md` for actual results.

## Kubernetes with external managed dependencies

Provision PostgreSQL, Redis, RabbitMQ and a private object bucket outside this manifest set. Configure endpoints, trusted TLS certificates and a secret manager; application startup validates dependencies but does not create databases or buckets. The ConfigMap enables verified PostgreSQL TLS, and the Secret example uses Redis/AMQP TLS. For private CAs mount the trust chain and configure `NODE_EXTRA_CA_CERTS`; never disable certificate verification. Render `secret.example.yaml` with real secrets outside the repository. Install an ingress controller and provide the named TLS Secret before applying the optional Ingress.

Build and push the Docker image to your registry, then replace every `image: daylight:local` in `apps.yaml` and `migrate.yaml` with the same immutable release digest. The sample resources are initial sizing, not measured capacity. Apply migrations before rolling application pods:

```sh
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/configmap.yaml
kubectl apply -f /secure/path/daylight-secret.yaml
kubectl apply -f deploy/kubernetes/migrate.yaml
kubectl -n daylight wait --for=condition=complete job/daylight-migrate --timeout=600s
kubectl apply -f deploy/kubernetes/apps.yaml
kubectl apply -f deploy/kubernetes/service.yaml
kubectl -n daylight rollout status deployment/daylight-api --timeout=300s
kubectl -n daylight rollout status deployment/daylight-worker --timeout=300s
kubectl -n daylight rollout status deployment/daylight-scheduler --timeout=300s
```

On the next release, inspect and delete the completed `daylight-migrate` Job, replace its image with the release digest, rerun and wait for completion before applying the updated Deployments. Never delete a running migration Job as a routine release step. Migrations are idempotent and serialized with PostgreSQL advisory locks. Retain backward schema compatibility across rolling deployments; `kubectl rollout undo` rolls back application images, not database changes. First exercise migrations and backups on a clone with representative data.

The API Service is ClusterIP. The optional `ingress.example.yaml` uses nginx timeouts for long requests/SSE; adapt hostname, controller and certificate to the cluster. Processes run as UID 1000 with read-only root filesystems and a bounded writable `/tmp` for OCR/PDF temporary files; no persistent local business storage is attached. CJK fonts and native canvas bindings run on Debian Bookworm with Node 22.23.3. OCR language assets may require outbound access on first use.

`keda.example.yaml` is optional and requires installed KEDA CRDs and RabbitMQ metric access. Its queue threshold is an initial setting. RabbitMQ messages are wakeups, so queue depth alone can miss due jobs retained in PostgreSQL; keep at least one Worker and validate this signal against actual task latency before enabling autoscaling. The fixed two-worker Deployment and the ScaledObject should not be simultaneously managed by competing autoscalers.

Before cloud acceptance, record real dependency connectivity, migration/rerun, core business execution, multi-replica isolation/idempotency, dependency outages, SIGTERM/restart recovery, rolling upgrade/rollback and measured latency/resources/cost against the release digest. No such cloud acceptance is implied by these manifests.
