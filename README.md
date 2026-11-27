# GongXi Mail (廾匸邮箱)

使用 Microsoft OAuth2 进行邮箱收取的 API 服务。

## 技术栈

- **后端**: Fastify 5 + TypeScript + Prisma 6
- **数据库**: PostgreSQL
- **缓存**: Redis
- **前端**: React + Ant Design + Vite

## 项目结构

```
├── server/                 # 后端服务
│   ├── src/
│   │   ├── config/        # 环境配置
│   │   ├── lib/           # 核心库
│   │   ├── plugins/       # Fastify 插件
│   │   ├── modules/       # 业务模块
│   ├── prisma/            # 数据库 Schema
│   └── package.json
├── web/                    # 前端管理面板
├── docker-compose.yml
└── Dockerfile
```

## 快速开始

### Docker 部署

密钥无需手动准备：首次启动自动生成 `JWT_SECRET`、`ENCRYPTION_KEY` 和一个强随机的 `ADMIN_PASSWORD`，
持久化到 `app_data` 卷中的 `data/bootstrap-secrets.json`（重启与重建容器后保持不变），
初始管理员密码只在首次启动日志里打印一次，可随时 `docker compose logs app | grep "initial admin password"` 找回。

如需固定密钥（例如多实例共享），在启动前显式注入环境变量，显式值永远优先于自动生成：

```bash
export JWT_SECRET="replace-with-at-least-32-char-random-secret"
export ENCRYPTION_KEY="replace-with-32-character-secret-key"
export ADMIN_PASSWORD="replace-with-strong-password"
```

然后启动：

```bash
docker-compose up -d --build
```

访问 http://localhost:3000

> 注意：`app_data` 卷里存有加密数据所依赖的 `ENCRYPTION_KEY`，删除该卷会导致已入库的
> refresh token 无法解密，请像对待数据库卷一样对待它。

### 健康检查

```bash
curl http://localhost:3000/health
# {"success":true,"data":{"status":"ok"}}
```

## 开发质量检查

```bash
# 前端
cd web
npm run lint
npm run build

# 后端
cd ../server
npm run lint
npm run lint:fix
npm run build
npm run test
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| NODE_ENV | 环境 | development |
| PORT | 端口 | 3000 |
| DATABASE_URL | PostgreSQL 连接 | - |
| REDIS_URL | Redis 连接 | - |
| CORS_ORIGIN | 允许跨域来源（逗号分隔） | 开发环境默认放开 |
| JWT_SECRET | JWT 密钥 (≥32字符) | - |
| JWT_EXPIRES_IN | Token 过期时间 | 2h |
| ENCRYPTION_KEY | 加密密钥 (32字符) | - |
| ADMIN_USERNAME | 默认管理员用户名 | admin |
| ADMIN_PASSWORD | 默认管理员密码（生产禁止使用默认值） | - |
| ADMIN_LOGIN_MAX_ATTEMPTS | 管理员连续失败最大次数 | 5 |
| ADMIN_LOGIN_LOCK_MINUTES | 登录失败锁定分钟数 | 15 |
| ADMIN_2FA_SECRET | 可选管理员 TOTP Base32 密钥 | - |
| ADMIN_2FA_WINDOW | TOTP 时间窗口（步长） | 1 |
| API_LOG_RETENTION_DAYS | API 日志保留天数 | 30 |
| API_LOG_CLEANUP_INTERVAL_MINUTES | API 日志清理间隔（分钟） | 60 |
| HTTPS_PROXY / HTTP_PROXY | 出站代理兜底（请求未带 socks5/http 参数时生效，含 Token 轮换） | - |

## 枚举约定

为避免前后端不一致，所有枚举统一使用大写：

| 类型 | 枚举值 |
|------|--------|
| 管理员角色 | `SUPER_ADMIN` / `ADMIN` |
| 管理员/API Key 状态 | `ACTIVE` / `DISABLED` |

## 邮件拉取策略（分组级）

邮箱分组支持配置 `fetchStrategy`，同组邮箱统一使用该策略：

| 策略 | 行为 |
|------|------|
| `GRAPH_FIRST` | 先 Graph，失败后回退 IMAP |
| `IMAP_FIRST` | 先 IMAP，失败后回退 Graph |
| `GRAPH_ONLY` | 仅 Graph，不回退 |
| `IMAP_ONLY` | 仅 IMAP，不回退 |

说明：`IMAP_ONLY` 不支持“清空邮箱（process-mailbox）”，该操作依赖 Graph API。

## API 文档

后台「API 文档」页面有完整的参数、响应和错误码说明，下面是摘要。代码位于 `server/src/modules/mail/mail.routes.ts`。

### 通用约定

- **认证**：`X-API-Key: sk_xxx`（推荐），或 `Authorization: Bearer sk_xxx`，或 URL 参数 `?api_key=sk_xxx`（不推荐）。
- **请求**：所有 `/api/*` 接口都接受 GET 和 POST。GET 参数放查询串，POST 参数放 JSON body，并且必须带 `Content-Type: application/json`。
  GET 参数含正则等特殊字符时需要 URL 编码（curl 用 `-G --data-urlencode`）。
- **响应**：成功 `{"success": true, "data": {...}}`；失败 `{"success": false, "requestId": "...", "error": {"code": "...", "message": "..."}}`。
  `mail_text` 和 `wait_code?format=text` 返回 `text/plain`，失败内容为 `Error: 原因`，状态码与 JSON 一致；认证、权限、限流错误始终是 JSON。
- **范围**：API Key 的「可用分组 / 可用邮箱」限制所有接口能访问的邮箱。
- **限流**：按 Key 每分钟 `rateLimit` 次（默认 60），不参与全局 IP 限流。

### 接口列表

| 接口 | 权限键 | 说明 |
|------|--------|------|
| `/api/claim-email` | `claim_email` | 领取邮箱（带租约，默认 600 秒），到期未处理自动回收 |
| `/api/complete-email` | `complete_email` | 完成领取，邮箱不再分配给该 Key；幂等 |
| `/api/release-email` | `release_email` | 释放领取，邮箱回到池中；已完成的不能释放 |
| `/api/get-email` | `get_email` | 分配邮箱并立即永久标记已用（无租约） |
| `/api/pool-stats` | `pool_stats` | 邮箱池统计：`total` / `used` / `remaining` / `claimed` / `completed` |
| `/api/reset-pool` | `pool_reset` | 清除该 Key 的分配记录（已用完和领取中都清除） |
| `/api/list-emails` | `list_emails` | 可用范围内正常状态的邮箱列表（最多 1000 个） |
| `/api/wait_code` | `wait_code` | 长轮询等待新验证码，超时 404 `CODE_TIMEOUT` |
| `/api/mail_text` | `mail_text` | 最新一封邮件的纯文本，可用正则提取（`text/plain`） |
| `/api/mail_new` | `mail_new` | 最新一封邮件（JSON） |
| `/api/mail_all` | `mail_all` | 文件夹内邮件，从新到旧最多 100 封（JSON） |
| `/api/process-mailbox` | `process_mailbox` | 清空文件夹（仅 Graph，分组策略为 `IMAP_ONLY` 时不可用） |

### 推荐流程

```bash
KEY="sk_xxx"; BASE="http://localhost:3000"

# 1. 领取（租约 15 分钟）
EMAIL=$(curl -s -X POST "$BASE/api/claim-email" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"group": "aws", "lease": 900}' | jq -r .data.email)

# 2. 用 $EMAIL 在目标网站触发发送验证码

# 3. 等待验证码（最长 90 秒，客户端超时要更长）
CODE=$(curl -s --max-time 100 "$BASE/api/wait_code?email=$EMAIL&timeout=90&format=text" -H "X-API-Key: $KEY")

# 4. 成功标记已用完；失败改调 /api/release-email 归还
curl -s -X POST "$BASE/api/complete-email" -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d "{\"email\": \"$EMAIL\"}"
```

只读取一次最新邮件（不等待）：

```bash
curl -G "$BASE/api/mail_text" -H "X-API-Key: $KEY" \
  --data-urlencode "email=xxx@outlook.com" --data-urlencode 'match=\d{6}'
# 返回: 123456
```

### 参数

| 参数 | 适用接口 | 说明 |
|------|----------|------|
| `email` | 除分配类外全部 | 邮箱地址，必填，需与系统中保存的地址完全一致 |
| `group` | claim / get-email、pool-stats、reset-pool、list-emails | 分组名，可选 |
| `lease` | claim-email | 租约秒数，默认 600，范围 30~86400 |
| `mailbox` | mail_new、mail_all、mail_text、process-mailbox | `inbox`（默认）/ `junk`，不区分大小写 |
| `mailbox` | wait_code | `inbox` / `junk` / `all`（默认） |
| `match` | mail_text、wait_code | 正则，有捕获组时返回第一个捕获组；`wait_code` 不填时自动识别 4~8 位数字验证码 |
| `timeout` | wait_code | 最长等待秒数，默认 60，范围 5~180 |
| `interval` | wait_code | 收信间隔秒数，默认 5，范围 3~30 |
| `since` | wait_code | 只看此时间之后的邮件（ISO 或 Unix 秒 / 毫秒）；默认取该 Key 的领取 / 分配时间（最早 10 分钟前），否则为请求前 60 秒 |
| `format` | wait_code | `json`（默认）或 `text` |
| `socks5` / `http` | 收信类与 process-mailbox | 出站代理，未传时使用 `HTTPS_PROXY` / `HTTP_PROXY` |

单个 Key 同时最多 10 个 `wait_code` 请求，一次等待只计一次限流。走 Graph 时邮件的 `text` 只是摘要，完整内容在 `html`。

### 错误码

| 错误码 | HTTP | 说明 |
|--------|------|------|
| `UNAUTHORIZED` / `INVALID_API_KEY` | 401 | 未携带 / 无效的 API Key |
| `API_KEY_DISABLED` / `API_KEY_EXPIRED` | 403 | Key 已禁用 / 已过期 |
| `FORBIDDEN_PERMISSION` | 403 | Key 没有该接口的权限键 |
| `RATE_LIMIT_EXCEEDED` | 429 | 超过每分钟调用次数 |
| `VALIDATION_ERROR` | 400 | 参数缺失或格式错误 |
| `EMAIL_NOT_FOUND` / `EMAIL_FORBIDDEN` | 404 / 403 | 邮箱不存在 / 不在 Key 可用范围内 |
| `GROUP_NOT_FOUND` / `GROUP_FORBIDDEN` | 404 / 403 | 分组不存在 / 不在 Key 可用范围内 |
| `NO_UNUSED_EMAIL` | 400 | 没有可分配的邮箱 |
| `CONCURRENCY_LIMIT` | 429 | 分配并发冲突，稍后重试 |
| `CLAIM_NOT_FOUND` | 404 | 该 Key 没有领取过这个邮箱 |
| `ALREADY_COMPLETED` | 409 | 已完成的邮箱不能释放 |
| `CODE_TIMEOUT` | 404 | `wait_code` 超时没等到验证码 |
| `INVALID_REGEX` / `INVALID_SINCE` | 400 | 正则无效或被拒绝 / since 无法解析 |
| `TOO_MANY_WAITS` | 429 | 同一 Key 等待中的请求超过 10 个 |
| `NO_MESSAGES` / `NO_MATCH` | 404 | `mail_text` 没有邮件 / 正则没匹配 |
| `GRAPH_TOKEN_FAILED` / `GRAPH_SCOPE_MISSING` / `IMAP_TOKEN_FAILED` | 502 | 获取访问令牌失败或缺少权限 |
| `MAILBOX_CLEAR_UNSUPPORTED` | 400 | 分组策略为 `IMAP_ONLY`，不能清空 |
| `GRAPH_API_FAILED` | 500 | 清空邮箱时获取 Graph 访问令牌失败 |

## Resend 兼容发信接口（Graph 账号池）

在 `/resend` 下提供与 [Resend](https://resend.com/docs/api-reference/emails/send-email) 相同的发信接口：请求字段、响应结构、错误格式都一致，
已有的 Resend SDK / 代码只需把接口地址改为 `https://你的域名/resend`、密钥换成本系统的 `sk_` Key。邮件由分组发信池中的 Outlook 账号通过 Microsoft Graph `sendMail` 发出。
代码位于 `server/src/modules/resend/`、`server/src/modules/send/`。

| 接口 | 对应 Resend | 权限键 | 说明 |
|------|-------------|--------|------|
| `POST /resend/emails` | `POST /emails` | `send_mail` | 同步发送，返回 `{"id": "uuid"}` |
| `POST /resend/emails/batch` | `POST /emails/batch` | `send_mail` | 最多 100 封，排队逐封发送；支持 `x-batch-validation: strict / permissive`；不支持附件 |
| `GET /resend/emails/:id` | `GET /emails/:id` | `send_read` | 查询已发邮件 |
| `GET /resend/emails` | `GET /emails` | `send_read` | 列表，`limit`（1~100，默认 20）、`after` / `before` 游标 |

```js
import { Resend } from 'resend';
const resend = new Resend('sk_xxx', { baseUrl: 'https://你的域名/resend' }); // 或设置环境变量 RESEND_BASE_URL
await resend.emails.send({ from: 'Acme <noreply@acme.dev>', to: ['user@example.com'], subject: 'hi', html: '<p>hi</p>' });
```

**启用步骤**

1. 「邮箱管理 → 邮箱分组」编辑分组，开启「参与发信池」，设置挑号方式、每账号 24 小时上限、同账号发信间隔、每封收件人上限。
2. 在邮箱列表选中账号「检测发信权限」：令牌必须带 `Mail.Send`（取决于导入账号时 client_id 申请的权限，服务端无法补充），没有的账号不会进入发信池。
3. API Key 勾选 `send_mail`（以及需要查询时的 `send_read`）。**这两项必须显式勾选，未配置权限的 Key 也不能发信。**
   Key 的「可用分组 / 可用邮箱」同时决定能用哪些账号发信。

**挑号规则**：账号正常、分组已开启发信、未被标记无权限、不在冷却中、距上次发信超过间隔、24 小时内（滚动窗口）未达上限、分组收件人上限足够；
按分组的挑号方式排序（最少使用 / 轮流 / 随机），用数据库行锁避免并发挑中同一账号。Graph 返回限流按 `Retry-After` 冷却、被禁止发信冷却 24 小时、
无权限标记为不可发信，并自动换下一个账号重试（每封最多 3 个账号）；收件人错误等请求问题不重试。

**与 Resend 的差异**（由 Graph 发信决定）：

- `from`：地址是发信池中（Key 范围内、分组已开启发信）的账号时用该账号发；否则从池中挑号，保留显示名，实际发件地址为挑中的账号。
- 附件：`content`（base64）或 `path`（仅 https 公网地址，拒绝内网与保留地址），每封合计 3 MB 以内。
- `headers` 只支持 `X-` 开头的自定义头；`scheduled_at`、`template`、`topic_id` 暂不支持，传入返回 422。
- `last_event` 只有 `sent`（Graph 已接收）、`queued`、`failed`；`message_id` 为 `null`。
- `Idempotency-Key` 规则与 Resend 相同（24 小时、最长 256 字符、同 Key 不同请求体返回 409）。

后台「发信记录」页面可以查看每个分组的发信池状态（可发 / 未检测 / 无权限 / 冷却中、24 小时已发、剩余额度）和每封邮件的发送详情；
邮箱列表可对单个账号「测试发信」（不受分组开关、间隔、额度限制，但计入发信量）。

后台「在线发信」页面可以直接写信发送：选择「发信池轮换」（按分组规则挑号，可限定分组）或「指定账号」（不受分组开关、间隔、额度限制），
支持多收件人 / 抄送 / 密送 / 回复地址、HTML（可预览）或纯文本正文、合计 3 MB 以内的附件；草稿（不含附件）自动保存在浏览器，发送记录在「发信记录」中可查。

## 操作日志 Action 与 API Key 权限键

每次外部调用都会记录到 `/admin/dashboard/logs`，`action` 与 API Key 的 `permissions` 使用同一套值，
对应关系见上方「接口列表」的权限键列（注意 `/api/reset-pool` 的权限键是 `pool_reset`）。

未配置 `permissions` 时默认允许全部 `/api/*` 接口（发信的 `send_mail` / `send_read` 除外，必须显式勾选）；配置了权限的旧 Key 需要在后台勾选
`wait_code` / `claim_email` / `complete_email` / `release_email` 后才能调用新接口。
两端定义分别在 `server/src/modules/mail/mail.actions.ts` 与 `web/src/constants/logActions.ts`，需保持一致。

## 生产配置要求

- `JWT_SECRET`、`ENCRYPTION_KEY`、`ADMIN_PASSWORD` 可以不设置——首次启动会自动生成并持久化到 `app_data` 卷；多实例部署或需要固定值时才必须显式注入。
- 如启用 2FA，`ADMIN_2FA_SECRET` 也必须通过外部环境变量注入。
- 不要在 `docker-compose.yml`、`.env`、代码仓库中写死生产密钥。
- `server/.env.example` 仅作为模板，不能直接用于生产。
- 如需跨域访问，配置 `CORS_ORIGIN`（如 `https://admin.example.com,https://ops.example.com`）。
- 生产模式会在启动时对前端静态资源生成 `.gz/.br` 预压缩文件，并优先下发压缩版本。
- 服务会按 `API_LOG_RETENTION_DAYS` 与 `API_LOG_CLEANUP_INTERVAL_MINUTES` 自动清理历史 API 日志。
- 全局 IP 限流默认 300 次/分钟，登录接口 10 次/分钟/IP；`/api/*` 不参与全局限流，改用按 API Key 的限流（每分钟 `rateLimit` 次）。
- 邮箱明文导出（`/admin/emails/export`、`/admin/emails/:id?secrets=true`）仅超级管理员可用。

## 数据库迁移

项目使用 Prisma Migrate 管理表结构，初始基线在 `server/prisma/migrations/20260222000000_init`。

- 本地开发：改 `schema.prisma` 后用 `npx prisma migrate dev --name <change>` 生成迁移文件并一起提交。
- 生产/容器：容器启动时自动执行 `server/scripts/migrate-up.mjs` —— 全新数据库直接 `migrate deploy`；老库（此前由 `db push` 维护）会自动把基线标记为已应用再 `deploy`，无需任何手动步骤。日常更新只需 `git pull && docker-compose up -d --build`。
- `db push` 仅保留在开发期快速试验用，不要再用于生产。

## License

MIT
