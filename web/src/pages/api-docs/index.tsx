import React, { useMemo, useState } from 'react';
import {
  Typography,
  Card,
  Tag,
  Table,
  Collapse,
  Space,
  Steps,
  Input,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { LOG_ACTIONS, LOG_ACTION_LABELS, type LogAction } from '../../constants/logActions';
import { useIsMobile } from '../../hooks/useIsMobile';

const { Title, Text, Paragraph } = Typography;

// ============================================================
// 数据定义（与 server/src/modules/mail/mail.routes.ts 一一对应）
// ============================================================

interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  defaultValue?: string;
  desc: string;
}

interface ApiErrorCode {
  code: string;
  status: number;
  desc: string;
}

type ApiCategory = 'pool' | 'mail' | 'maintain';

interface ApiEndpoint {
  path: string;
  name: string;
  category: ApiCategory;
  permission: LogAction;
  responseType: 'json' | 'text';
  summary: string;
  notes?: string[];
  params: ApiParam[];
  example: (baseUrl: string) => string;
  successResponse: string;
  errors: ApiErrorCode[];
}

const CATEGORY_META: Record<ApiCategory, { title: string; desc: string }> = {
  pool: { title: '邮箱分配', desc: '从邮箱池中分配、领取、归还邮箱，以及查看和重置分配记录' },
  mail: { title: '收信与验证码', desc: '读取指定邮箱的邮件，或等待新验证码' },
  maintain: { title: '邮箱维护', desc: '清空邮箱等维护操作' },
};

const MAILBOX_PARAM: ApiParam = {
  name: 'mailbox',
  type: 'string',
  defaultValue: 'inbox',
  desc: 'inbox（收件箱）或 junk（垃圾箱），不区分大小写',
};
const PROXY_PARAMS: ApiParam[] = [
  { name: 'socks5', type: 'string', desc: 'SOCKS5 代理，如 socks5://user:pass@host:port' },
  { name: 'http', type: 'string', desc: 'HTTP 代理，如 http://user:pass@host:port' },
];
const EMAIL_PARAM: ApiParam = {
  name: 'email',
  type: 'string',
  required: true,
  desc: '邮箱地址，需与系统中保存的地址完全一致',
};
const GROUP_PARAM: ApiParam = { name: 'group', type: 'string', desc: '分组名称，仅在该分组内操作' };

const EMAIL_LOOKUP_ERRORS: ApiErrorCode[] = [
  { code: 'EMAIL_NOT_FOUND', status: 404, desc: '系统中没有这个邮箱' },
  { code: 'EMAIL_FORBIDDEN', status: 403, desc: '邮箱不在当前 API Key 的可用范围内' },
];
const GROUP_ERRORS: ApiErrorCode[] = [
  { code: 'GROUP_NOT_FOUND', status: 404, desc: 'group 指定的分组不存在' },
  { code: 'GROUP_FORBIDDEN', status: 403, desc: '分组不在当前 API Key 的可用范围内' },
];
// 同一个 refresh token 用于 Graph 和 IMAP：账号层面的问题两条路径都会失败，使用专门的错误码
const ACCOUNT_TOKEN_ERRORS: ApiErrorCode[] = [
  { code: 'REFRESH_TOKEN_INVALID', status: 502, desc: '刷新令牌无效、过期、被吊销或与客户端 ID 不匹配（如 AADSTS70000），需要重新授权' },
  { code: 'ACCOUNT_ACTION_REQUIRED', status: 502, desc: '微软要求该账号交互登录（二次验证、安全检查）' },
  { code: 'CONSENT_REQUIRED', status: 502, desc: '应用未获得该账号的授权' },
  { code: 'CLIENT_ID_INVALID', status: 502, desc: '客户端 ID 无效或不能用于该账号' },
  { code: 'MS_ACCOUNT_UNAVAILABLE', status: 502, desc: '微软账号不存在、被禁用或被锁定' },
];

const FETCH_ERRORS: ApiErrorCode[] = [
  ...ACCOUNT_TOKEN_ERRORS,
  { code: 'GRAPH_TOKEN_FAILED', status: 502, desc: '获取 Graph 访问令牌失败（网络、代理或其它原因，message 中带微软返回的原因）' },
  { code: 'GRAPH_SCOPE_MISSING', status: 502, desc: '令牌缺少 Mail.Read 权限' },
  { code: 'IMAP_TOKEN_FAILED', status: 502, desc: '获取 IMAP 访问令牌失败（同上）' },
  { code: 'GRAPH_FETCH_FAILED', status: 502, desc: '拿到令牌后通过 Graph 读取邮件失败' },
  { code: 'IMAP_FETCH_FAILED', status: 502, desc: '拿到令牌后通过 IMAP 读取邮件失败（连接、登录或超时）' },
];

const MESSAGE_FIELDS_NOTE = '邮件字段：id、from、subject、text、html、date（ISO 时间）。走 Graph 时 text 只是摘要（约 255 字），完整内容请读 html；method 为 graph_api 或 imap。';

const API_ENDPOINTS: ApiEndpoint[] = [
  // ---------------- 邮箱分配 ----------------
  {
    path: '/api/claim-email',
    name: '领取邮箱（带租约）',
    category: 'pool',
    permission: LOG_ACTIONS.CLAIM_EMAIL,
    responseType: 'json',
    summary: '领取一个当前 Key 还没用过的邮箱，并持有一段时间的租约。业务成功后调用 complete-email，失败调用 release-email；租约到期仍未处理会自动回收，可被再次领取。',
    notes: ['按邮箱编号从小到大分配，只分配状态为正常（ACTIVE）且在 Key 可用范围内的邮箱。'],
    params: [
      GROUP_PARAM,
      { name: 'lease', type: 'number', defaultValue: '600', desc: '租约秒数，范围 30 ~ 86400' },
    ],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/claim-email" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"group": "aws", "lease": 900}'`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "id": 1,
    "status": "CLAIMED",
    "claimedAt": "2026-11-23T02:00:00.000Z",
    "leaseExpiresAt": "2026-11-23T02:15:00.000Z",
    "leaseSeconds": 900
  }
}`,
    errors: [
      { code: 'NO_UNUSED_EMAIL', status: 400, desc: '没有可领取的邮箱，message 中带有已用 / 总数' },
      ...GROUP_ERRORS,
      { code: 'CONCURRENCY_LIMIT', status: 429, desc: '并发冲突重试 3 次仍失败，稍后重试' },
    ],
  },
  {
    path: '/api/complete-email',
    name: '完成领取',
    category: 'pool',
    permission: LOG_ACTIONS.COMPLETE_EMAIL,
    responseType: 'json',
    summary: '把领取的邮箱标记为已用完，之后不会再分配给当前 Key。重复调用幂等，alreadyCompleted 表示此前已完成。',
    notes: ['租约已过期但还没被重新领取时，仍可以完成。', '对 get-email 分配的邮箱调用会直接返回 alreadyCompleted: true。'],
    params: [{ ...EMAIL_PARAM, desc: '已领取的邮箱地址' }],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/complete-email" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com"}'`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "status": "COMPLETED",
    "completedAt": "2026-11-23T02:03:00.000Z",
    "alreadyCompleted": false
  }
}`,
    errors: [
      ...EMAIL_LOOKUP_ERRORS,
      { code: 'CLAIM_NOT_FOUND', status: 404, desc: '当前 Key 没有领取过这个邮箱（或已释放 / 已被回收清理）' },
    ],
  },
  {
    path: '/api/release-email',
    name: '释放领取',
    category: 'pool',
    permission: LOG_ACTIONS.RELEASE_EMAIL,
    responseType: 'json',
    summary: '归还领取的邮箱，使其回到池中可被再次领取。已完成的邮箱不能释放，如需复用请调用 reset-pool。',
    params: [{ ...EMAIL_PARAM, desc: '已领取的邮箱地址' }],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/release-email" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com"}'`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "released": true
  }
}`,
    errors: [
      ...EMAIL_LOOKUP_ERRORS,
      { code: 'CLAIM_NOT_FOUND', status: 404, desc: '当前 Key 没有领取过这个邮箱' },
      { code: 'ALREADY_COMPLETED', status: 409, desc: '邮箱已完成，不能释放' },
    ],
  },
  {
    path: '/api/get-email',
    name: '分配邮箱（永久）',
    category: 'pool',
    permission: LOG_ACTIONS.GET_EMAIL,
    responseType: 'json',
    summary: '分配一个当前 Key 还没用过的邮箱，并立即永久标记为已用完（没有租约，不能释放）。需要失败后归还时请改用 claim-email。',
    notes: ['分配规则与 claim-email 相同；领取中且租约未到期的邮箱不会被分配。'],
    params: [GROUP_PARAM],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/get-email" \\
  -H "X-API-Key: sk_your_api_key"`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "id": 1
  }
}`,
    errors: [
      { code: 'NO_UNUSED_EMAIL', status: 400, desc: '没有可分配的邮箱，message 中带有已用 / 总数' },
      ...GROUP_ERRORS,
      { code: 'CONCURRENCY_LIMIT', status: 429, desc: '并发冲突重试 3 次仍失败，稍后重试' },
    ],
  },
  {
    path: '/api/pool-stats',
    name: '邮箱池统计',
    category: 'pool',
    permission: LOG_ACTIONS.POOL_STATS,
    responseType: 'json',
    summary: '统计当前 Key 可用范围内正常状态的邮箱：总数、已占用、剩余，以及占用中的已用完 / 领取中数量。',
    notes: ['used = completed + claimed；租约已过期的领取不计入。'],
    params: [GROUP_PARAM],
    example: (baseUrl) => `curl "${baseUrl}/api/pool-stats?group=aws" \\
  -H "X-API-Key: sk_your_api_key"`,
    successResponse: `{
  "success": true,
  "data": {
    "total": 100,
    "used": 5,
    "remaining": 95,
    "claimed": 2,
    "completed": 3
  }
}`,
    errors: GROUP_ERRORS,
  },
  {
    path: '/api/reset-pool',
    name: '重置分配记录',
    category: 'pool',
    permission: LOG_ACTIONS.POOL_RESET,
    responseType: 'json',
    summary: '清除当前 Key 在可用范围内的全部分配记录（已用完和领取中都会清除），这些邮箱可以重新分配。',
    notes: ['权限键是 pool_reset，与路径名不同。'],
    params: [{ ...GROUP_PARAM, desc: '分组名称，仅重置该分组' }],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/reset-pool" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"group": "aws"}'`,
    successResponse: `{
  "success": true,
  "data": {
    "message": "Pool reset successfully for group 'aws'"
  }
}`,
    errors: GROUP_ERRORS,
  },
  {
    path: '/api/list-emails',
    name: '可用邮箱列表',
    category: 'pool',
    permission: LOG_ACTIONS.LIST_EMAILS,
    responseType: 'json',
    summary: '列出当前 Key 可用范围内、状态为正常的邮箱，不区分是否已分配。',
    notes: ['最多返回 1000 个；group 指定的分组不存在时返回空列表（不报错）。'],
    params: [{ ...GROUP_PARAM, desc: '分组名称，仅返回该分组内的邮箱' }],
    example: (baseUrl) => `curl "${baseUrl}/api/list-emails" \\
  -H "X-API-Key: sk_your_api_key"`,
    successResponse: `{
  "success": true,
  "data": {
    "total": 2,
    "emails": [
      { "email": "user1@outlook.com", "status": "ACTIVE", "group": "aws" },
      { "email": "user2@outlook.com", "status": "ACTIVE", "group": null }
    ]
  }
}`,
    errors: [],
  },

  // ---------------- 收信与验证码 ----------------
  {
    path: '/api/wait_code',
    name: '等待验证码（长轮询）',
    category: 'mail',
    permission: LOG_ACTIONS.WAIT_CODE,
    responseType: 'json',
    summary: '服务端每隔 interval 秒收一次信，直到 since 之后收到的邮件里出现验证码才返回，超时返回 CODE_TIMEOUT。默认自动识别 4~8 位数字验证码，也可以用 match 正则提取任意格式。',
    notes: [
      '客户端的 HTTP 超时要比 timeout 长（例如 timeout=90 时设 --max-time 100）。',
      '单个 Key 同时最多 10 个等待请求；一次等待只计一次频率限制。',
      '第一次收信就失败（如令牌失效）会直接报错；之后的偶发失败会自动重试。',
      'format=text 时成功返回验证码纯文本，失败返回 "Error: 原因" 纯文本，状态码不变。',
    ],
    params: [
      EMAIL_PARAM,
      { name: 'match', type: 'string', desc: '正则表达式，有捕获组时返回第一个捕获组；不填则自动识别。依次匹配主题和正文' },
      { name: 'timeout', type: 'number', defaultValue: '60', desc: '最长等待秒数，范围 5 ~ 180' },
      { name: 'interval', type: 'number', defaultValue: '5', desc: '收信间隔秒数，范围 3 ~ 30' },
      {
        name: 'since',
        type: 'string | number',
        desc: '只看此时间之后收到的邮件，ISO 时间或 Unix 时间戳（秒或毫秒）。不填时：当前 Key 领取 / 分配过此邮箱则取那个时间（最早 10 分钟前），否则取请求前 60 秒',
      },
      { name: 'mailbox', type: 'string', defaultValue: 'all', desc: 'inbox、junk 或 all（收件箱 + 垃圾箱）' },
      { name: 'format', type: 'string', defaultValue: 'json', desc: 'json，或 text（只返回验证码）' },
      ...PROXY_PARAMS,
    ],
    example: (baseUrl) => `# 触发目标网站发送验证码后调用，最长等 90 秒
curl --max-time 100 "${baseUrl}/api/wait_code?email=example@outlook.com&timeout=90&format=text" \\
  -H "X-API-Key: sk_your_api_key"

# 自定义正则（GET 时用 --data-urlencode 编码）
curl -G --max-time 100 "${baseUrl}/api/wait_code" \\
  -H "X-API-Key: sk_your_api_key" \\
  --data-urlencode "email=example@outlook.com" \\
  --data-urlencode "match=code[:：]\\s*([A-Z0-9]{6})"`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "since": "2026-11-23T02:00:00.000Z",
    "code": "482913",
    "matchedBy": "auto",
    "mailbox": "inbox",
    "messageId": "AAMk...",
    "subject": "Your security code",
    "from": "noreply@example.com",
    "receivedAt": "2026-11-23T02:00:12.000Z",
    "method": "graph_api",
    "attempts": 3,
    "waitedMs": 10342
  }
}

# format=text
482913`,
    errors: [
      { code: 'CODE_TIMEOUT', status: 404, desc: '在 timeout 秒内没有等到验证码' },
      { code: 'INVALID_REGEX', status: 400, desc: '正则无效，或可能导致回溯爆炸被拒绝' },
      { code: 'INVALID_SINCE', status: 400, desc: 'since 无法解析' },
      { code: 'TOO_MANY_WAITS', status: 429, desc: '当前 Key 同时等待的请求超过 10 个' },
      ...EMAIL_LOOKUP_ERRORS,
      ...FETCH_ERRORS,
    ],
  },
  {
    path: '/api/mail_text',
    name: '最新邮件文本（脚本）',
    category: 'mail',
    permission: LOG_ACTIONS.MAIL_TEXT,
    responseType: 'text',
    summary: '返回最新一封邮件的纯文本正文（HTML 会转成文本）；传 match 时只返回匹配内容。成功和失败都返回 text/plain，失败内容为 "Error: 原因"。',
    notes: ['只读取一次，不等待新邮件；需要等新验证码请用 wait_code。', '正则只匹配正文，不匹配主题。'],
    params: [
      EMAIL_PARAM,
      { name: 'match', type: 'string', desc: '正则表达式，有捕获组时返回第一个捕获组，例如 \\d{6}' },
      MAILBOX_PARAM,
      ...PROXY_PARAMS,
    ],
    example: (baseUrl) => `curl -G "${baseUrl}/api/mail_text" \\
  -H "X-API-Key: sk_your_api_key" \\
  --data-urlencode "email=example@outlook.com" \\
  --data-urlencode "match=\\d{6}"`,
    successResponse: `123456`,
    errors: [
      { code: 'NO_MESSAGES', status: 404, desc: '文件夹里没有邮件（返回 Error: No messages found）' },
      { code: 'NO_MATCH', status: 404, desc: '正则没有匹配（返回 Error: No match found）' },
      { code: 'INVALID_REGEX', status: 400, desc: '正则无效或被拒绝' },
      ...EMAIL_LOOKUP_ERRORS,
      ...FETCH_ERRORS,
    ],
  },
  {
    path: '/api/mail_new',
    name: '最新一封邮件',
    category: 'mail',
    permission: LOG_ACTIONS.MAIL_NEW,
    responseType: 'json',
    summary: '读取指定邮箱的最新一封邮件。邮箱只需在当前 Key 的可用范围内，不要求先分配。',
    notes: [MESSAGE_FIELDS_NOTE, '收信方式由邮箱所在分组的拉取策略决定（Graph / IMAP 及回退）。'],
    params: [EMAIL_PARAM, MAILBOX_PARAM, ...PROXY_PARAMS],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/mail_new" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com", "mailbox": "inbox"}'`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "mailbox": "inbox",
    "count": 1,
    "messages": [
      {
        "id": "AAMk...",
        "from": "noreply@example.com",
        "subject": "验证码邮件",
        "text": "您的验证码是 123456",
        "html": "<p>您的验证码是 <b>123456</b></p>",
        "date": "2026-11-23T02:00:12.000Z"
      }
    ],
    "method": "graph_api"
  },
  "email": "example@outlook.com"
}`,
    errors: [...EMAIL_LOOKUP_ERRORS, ...FETCH_ERRORS],
  },
  {
    path: '/api/mail_all',
    name: '全部邮件',
    category: 'mail',
    permission: LOG_ACTIONS.MAIL_ALL,
    responseType: 'json',
    summary: '读取指定邮箱文件夹中的邮件，按时间从新到旧，最多 100 封。',
    notes: [MESSAGE_FIELDS_NOTE],
    params: [EMAIL_PARAM, MAILBOX_PARAM, ...PROXY_PARAMS],
    example: (baseUrl) => `curl "${baseUrl}/api/mail_all?email=example@outlook.com&mailbox=junk" \\
  -H "X-API-Key: sk_your_api_key"`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "mailbox": "junk",
    "count": 2,
    "messages": [
      { "id": "...", "from": "...", "subject": "邮件1", "text": "...", "html": "...", "date": "..." },
      { "id": "...", "from": "...", "subject": "邮件2", "text": "...", "html": "...", "date": "..." }
    ],
    "method": "imap"
  },
  "email": "example@outlook.com"
}`,
    errors: [...EMAIL_LOOKUP_ERRORS, ...FETCH_ERRORS],
  },

  // ---------------- 邮箱维护 ----------------
  {
    path: '/api/process-mailbox',
    name: '清空邮箱',
    category: 'maintain',
    permission: LOG_ACTIONS.PROCESS_MAILBOX,
    responseType: 'json',
    summary: '删除指定文件夹中的邮件，data.deletedCount 为删除数量。只能通过 Graph 执行，分组策略为「仅 IMAP」时不可用。',
    notes: [
      '单次最多处理约 5000 封，邮件更多时可重复调用。',
      '删除中途出错时仍返回 HTTP 200，但 data.status 为 error，deletedCount 为已删除数量。',
    ],
    params: [EMAIL_PARAM, MAILBOX_PARAM, ...PROXY_PARAMS],
    example: (baseUrl) => `curl -X POST "${baseUrl}/api/process-mailbox" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com", "mailbox": "inbox"}'`,
    successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "mailbox": "inbox",
    "status": "success",
    "deletedCount": 5,
    "message": "Successfully deleted 5 messages"
  },
  "email": "example@outlook.com"
}`,
    errors: [
      { code: 'MAILBOX_CLEAR_UNSUPPORTED', status: 400, desc: '分组策略为「仅 IMAP」' },
      ...ACCOUNT_TOKEN_ERRORS,
      { code: 'GRAPH_API_FAILED', status: 500, desc: '获取 Graph 访问令牌失败（其它原因）' },
      ...EMAIL_LOOKUP_ERRORS,
    ],
  },
];

const AUTH_METHODS = [
  { method: 'Header（推荐）', example: 'X-API-Key: sk_your_api_key', description: '在请求头中传递 API Key' },
  { method: 'Bearer Token', example: 'Authorization: Bearer sk_your_api_key', description: '仅识别以 sk_ 开头的 Key' },
  { method: 'Query 参数', example: '?api_key=sk_your_api_key', description: '只能放在 URL 上（不能放 JSON body），会出现在访问日志中，不推荐' },
];

const COMMON_ERRORS: ApiErrorCode[] = [
  { code: 'UNAUTHORIZED', status: 401, desc: '没有携带 API Key' },
  { code: 'INVALID_API_KEY', status: 401, desc: 'API Key 不存在' },
  { code: 'API_KEY_DISABLED', status: 403, desc: 'API Key 已禁用' },
  { code: 'API_KEY_EXPIRED', status: 403, desc: 'API Key 已过期' },
  { code: 'FORBIDDEN_PERMISSION', status: 403, desc: 'API Key 没有该接口的权限键' },
  { code: 'RATE_LIMIT_EXCEEDED', status: 429, desc: '超过该 Key 每分钟的调用次数限制' },
  { code: 'VALIDATION_ERROR', status: 400, desc: '参数缺失或格式错误，error.details 为具体字段' },
  { code: 'INTERNAL_ERROR', status: 500, desc: '服务器内部错误' },
];

const SUCCESS_SHAPE = `{
  "success": true,
  "data": { ... }
}`;

const ERROR_SHAPE = `{
  "success": false,
  "requestId": "req-1a2b",
  "error": {
    "code": "EMAIL_NOT_FOUND",
    "message": "Email account not found"
  }
}`;

const RECOMMENDED_FLOW = (baseUrl: string) => `KEY="sk_your_api_key"

# 1. 领取一个邮箱（租约 15 分钟）
EMAIL=$(curl -s -X POST "${baseUrl}/api/claim-email" -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" -d '{"group": "aws", "lease": 900}' | jq -r .data.email)

# 2. 用 $EMAIL 在目标网站注册 / 触发发送验证码 ...

# 3. 等待验证码（最长 90 秒）
CODE=$(curl -s --max-time 100 "${baseUrl}/api/wait_code?email=$EMAIL&timeout=90&format=text" -H "X-API-Key: $KEY")

# 4. 成功：标记已用完；失败：归还到池中
curl -s -X POST "${baseUrl}/api/complete-email" -H "X-API-Key: $KEY" \\
  -H "Content-Type: application/json" -d "{\\"email\\": \\"$EMAIL\\"}"
# curl -s -X POST "${baseUrl}/api/release-email" ...（参数相同）`;

// ============================================================
// Resend 兼容接口
// ============================================================

interface ResendEndpoint {
  method: string;
  path: string;
  resend: string;
  permission: LogAction;
  desc: string;
}

const RESEND_ENDPOINTS: ResendEndpoint[] = [
  { method: 'POST', path: '/resend/emails', resend: 'POST /emails', permission: LOG_ACTIONS.SEND_MAIL, desc: '发送一封邮件，返回 { id }。同步发送，返回时 Graph 已接收' },
  { method: 'POST', path: '/resend/emails/batch', resend: 'POST /emails/batch', permission: LOG_ACTIONS.SEND_MAIL, desc: '批量发送，最多 100 封，返回 { data: [{ id }] }。进入队列按池内账号逐封发送；支持 x-batch-validation' },
  { method: 'GET', path: '/resend/emails/:id', resend: 'GET /emails/:id', permission: LOG_ACTIONS.SEND_READ, desc: '查询一封已发邮件（object: "email"）' },
  { method: 'GET', path: '/resend/emails', resend: 'GET /emails', permission: LOG_ACTIONS.SEND_READ, desc: '列出当前 Key 发出的邮件，支持 limit（1~100）、after、before 游标' },
];

const RESEND_DIFFERENCES = [
  { key: 'from', item: 'from', desc: '地址正好是发信池中（Key 范围内、分组已开启发信）的账号时用该账号发；否则从池中挑号，保留显示名，实际发件地址为挑中的账号（查询接口返回实际地址）' },
  { key: 'pool', item: '发信账号', desc: '来自 Key「可用分组 / 可用邮箱」范围内、分组已开启发信、且令牌带 Mail.Send 权限的账号；按分组的挑号方式、24 小时上限、发信间隔轮换' },
  { key: 'att', item: 'attachments', desc: '支持 content（base64）和 path（仅 https 公网地址），每封合计 3 MB 以内（Graph 单次请求上限）；批量接口与 Resend 一样不支持附件' },
  { key: 'headers', item: 'headers', desc: '只支持 X- 开头的自定义头，其它头返回 422' },
  { key: 'event', item: 'last_event', desc: 'Graph 只能确认已接收：sent（已提交）/ queued（排队中）/ failed（失败），没有 delivered、opened 等事件；message_id 为 null' },
  { key: 'unsupported', item: '暂不支持', desc: 'scheduled_at、template、topic_id 传入时返回 422，不会被忽略' },
  { key: 'idem', item: 'Idempotency-Key', desc: '与 Resend 相同：24 小时有效，最长 256 字符；同 Key 不同请求体返回 409 invalid_idempotent_request' },
];

const RESEND_ERRORS = [
  { key: '401a', status: 401, name: 'missing_api_key', desc: '没有携带 API Key' },
  { key: '401b', status: 401, name: 'validation_error', desc: 'API key is invalid' },
  { key: '401c', status: 401, name: 'restricted_api_key', desc: 'Key 没有 send_mail / send_read 权限' },
  { key: '403a', status: 403, name: 'restricted_api_key', desc: 'Key 已禁用或过期' },
  { key: '403b', status: 403, name: 'validation_error', desc: 'Key 范围内没有开启发信的分组，或没有带 Mail.Send 权限的账号' },
  { key: '422', status: 422, name: 'validation_error 等', desc: '字段错误：missing_required_field、invalid_from_address、invalid_attachment、invalid_parameter' },
  { key: '409', status: 409, name: 'invalid_idempotent_request / concurrent_idempotent_requests', desc: '幂等 Key 冲突' },
  { key: '429a', status: 429, name: 'daily_quota_exceeded', desc: '池内账号的 24 小时额度都已用完' },
  { key: '429b', status: 429, name: 'rate_limit_exceeded', desc: '账号都在冷却或发信间隔内，或超过 Key 的每分钟调用次数' },
  { key: '500', status: 500, name: 'application_error', desc: '换号重试后仍发送失败' },
];

const RESEND_EXAMPLE = (baseUrl: string) => `// Node.js 官方 SDK：把 baseUrl 指向本系统，密钥使用本系统的 sk_ Key
import { Resend } from 'resend';

const resend = new Resend('sk_your_api_key', { baseUrl: '${baseUrl}/resend' });
// 也可以设置环境变量 RESEND_BASE_URL=${baseUrl}/resend

const { data, error } = await resend.emails.send({
  from: 'Acme <noreply@acme.dev>',   // 显示名保留，发件地址为池中账号
  to: ['user@example.com'],
  subject: 'hello world',
  html: '<p>it works!</p>',
});`;

const RESEND_CURL = (baseUrl: string) => `curl -X POST '${baseUrl}/resend/emails' \\
  -H 'Authorization: Bearer sk_your_api_key' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: welcome-user/123' \\
  -d '{
    "from": "Acme <noreply@acme.dev>",
    "to": ["user@example.com"],
    "subject": "hello world",
    "html": "<p>it works!</p>",
    "attachments": [{ "filename": "hello.txt", "content": "aGVsbG8=" }]
  }'

# {"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}

curl '${baseUrl}/resend/emails/49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' \\
  -H 'Authorization: Bearer sk_your_api_key'`;

// ============================================================
// 组件
// ============================================================

const CodeBlock: React.FC<{ code: string; maxHeight?: number }> = ({ code, maxHeight }) => (
  <div style={{ position: 'relative' }}>
    <pre
      style={{
        margin: 0,
        padding: '12px 40px 12px 12px',
        background: '#f6f8fa',
        border: '1px solid #eef0f3',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.6,
        fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
        overflow: 'auto',
        maxHeight,
        whiteSpace: 'pre',
      }}
    >
      {code}
    </pre>
    <Text
      copyable={{ text: code, tooltips: ['复制', '已复制'] }}
      style={{ position: 'absolute', top: 8, right: 10 }}
    />
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Title level={5} style={{ margin: '16px 0 8px' }}>{children}</Title>
);

const paramColumns = [
  { title: '参数', dataIndex: 'name', key: 'name', render: (t: string) => <Text code>{t}</Text> },
  { title: '类型', dataIndex: 'type', key: 'type', render: (t: string) => <Text type="secondary">{t}</Text> },
  {
    title: '必填',
    dataIndex: 'required',
    key: 'required',
    render: (r?: boolean) => (r ? <Tag color="red">是</Tag> : <Tag>否</Tag>),
  },
  {
    title: '默认值',
    dataIndex: 'defaultValue',
    key: 'defaultValue',
    render: (v?: string) => (v ? <Text code>{v}</Text> : <Text type="secondary">-</Text>),
  },
  { title: '说明', dataIndex: 'desc', key: 'desc' },
];

const errorColumns = [
  { title: '错误码', dataIndex: 'code', key: 'code', render: (t: string) => <Text code>{t}</Text> },
  { title: 'HTTP', dataIndex: 'status', key: 'status', width: 70 },
  { title: '说明', dataIndex: 'desc', key: 'desc' },
];

const EndpointDetail: React.FC<{ api: ApiEndpoint; baseUrl: string }> = ({ api, baseUrl }) => (
  <div>
    <Paragraph style={{ marginBottom: 8 }}>{api.summary}</Paragraph>
    <Space wrap size={[8, 8]} style={{ marginBottom: 8 }}>
      <Text type="secondary">权限键</Text>
      <Text code>{api.permission}</Text>
      <Text type="secondary">返回</Text>
      <Tag color={api.responseType === 'text' ? 'orange' : 'geekblue'}>
        {api.responseType === 'text' ? 'text/plain' : 'application/json'}
      </Tag>
    </Space>
    {api.notes && api.notes.length > 0 && (
      <ul style={{ paddingInlineStart: 20, margin: '4px 0 0', color: 'rgba(0,0,0,0.65)' }}>
        {api.notes.map((note) => (
          <li key={note} style={{ marginBottom: 4 }}>{note}</li>
        ))}
      </ul>
    )}

    <SectionTitle>请求参数</SectionTitle>
    {api.params.length > 0 ? (
      <Table
        dataSource={api.params}
        columns={paramColumns}
        pagination={false}
        size="small"
        rowKey="name"
        scroll={{ x: 'max-content' }}
      />
    ) : (
      <Text type="secondary">无</Text>
    )}

    <SectionTitle>调用示例</SectionTitle>
    <CodeBlock code={api.example(baseUrl)} />

    <SectionTitle>成功响应</SectionTitle>
    <CodeBlock code={api.successResponse} maxHeight={360} />

    <SectionTitle>错误码（另见通用错误码）</SectionTitle>
    {api.errors.length > 0 ? (
      <Table
        dataSource={api.errors}
        columns={errorColumns}
        pagination={false}
        size="small"
        rowKey="code"
        scroll={{ x: 'max-content' }}
      />
    ) : (
      <Text type="secondary">只有通用错误码</Text>
    )}
  </div>
);

const ApiDocsPage: React.FC = () => {
  const baseUrl = window.location.origin;
  const isMobile = useIsMobile();
  const [keyword, setKeyword] = useState('');
  const [activeKeys, setActiveKeys] = useState<string[]>([]);

  const filteredEndpoints = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return API_ENDPOINTS;
    return API_ENDPOINTS.filter((api) =>
      [api.path, api.name, api.permission, api.summary].some((text) => text.toLowerCase().includes(kw))
    );
  }, [keyword]);

  const overviewColumns = [
    {
      title: '接口',
      dataIndex: 'path',
      key: 'path',
      render: (path: string) => (
        <a
          onClick={() => {
            setActiveKeys((prev) => (prev.includes(path) ? prev : [...prev, path]));
            window.setTimeout(() => {
              document.getElementById(`api-${path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
          }}
        >
          <Text code>{path}</Text>
        </a>
      ),
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      render: (c: ApiCategory) => <Tag>{CATEGORY_META[c].title}</Tag>,
    },
    { title: '权限键', dataIndex: 'permission', key: 'permission', render: (p: string) => <Text code>{p}</Text> },
    {
      title: '返回',
      dataIndex: 'responseType',
      key: 'responseType',
      render: (t: string) => <Text type="secondary">{t === 'text' ? 'text' : 'json'}</Text>,
    },
  ];

  const actionRows = (Object.values(LOG_ACTIONS) as LogAction[]).map((action) => ({
    action,
    label: LOG_ACTION_LABELS[action],
    path: API_ENDPOINTS.find((api) => api.permission === action)?.path
      ?? (RESEND_ENDPOINTS.filter((api) => api.permission === action).map((api) => `${api.method} ${api.path}`).join('、') || '-'),
  }));

  return (
    <div>
      <div className="gx-page-head" style={{ marginBottom: 8 }}>
        <Title level={4} style={{ margin: 0 }}>API 文档</Title>
      </div>
      <Paragraph type="secondary">
        外部接口统一以 <Text code>/api/</Text> 开头，共 {API_ENDPOINTS.length} 个，需要 API Key。
      </Paragraph>

      <Card title="推荐流程：领取 → 等验证码 → 完成 / 释放" style={{ marginBottom: 16 }}>
        <Steps
          orientation={isMobile ? 'vertical' : 'horizontal'}
          size="small"
          style={{ marginBottom: 16 }}
          items={[
            { title: 'claim-email', content: '领取邮箱，带租约' },
            { title: '触发发送', content: '在目标网站使用该邮箱' },
            { title: 'wait_code', content: '服务端等待新验证码' },
            { title: 'complete / release', content: '成功标记已用，失败归还' },
          ]}
        />
        <CodeBlock code={RECOMMENDED_FLOW(baseUrl)} />
      </Card>

      <Card title="通用约定" style={{ marginBottom: 16 }}>
        <SectionTitle>认证</SectionTitle>
        <Table
          dataSource={AUTH_METHODS}
          columns={[
            { title: '方式', dataIndex: 'method', key: 'method' },
            { title: '示例', dataIndex: 'example', key: 'example', render: (t: string) => <Text code copyable>{t}</Text> },
            { title: '说明', dataIndex: 'description', key: 'description' },
          ]}
          pagination={false}
          size="small"
          rowKey="method"
          scroll={{ x: 'max-content' }}
        />

        <SectionTitle>请求格式</SectionTitle>
        <ul style={{ paddingInlineStart: 20, margin: 0 }}>
          <li>所有接口都接受 GET 和 POST：GET 时参数放在 URL 查询串，POST 时放在 JSON body。</li>
          <li>POST 必须带 <Text code>Content-Type: application/json</Text>，否则 body 不会被解析。</li>
          <li>GET 参数里有正则等特殊字符时需要 URL 编码，curl 可用 <Text code>-G --data-urlencode</Text>。</li>
          <li>API Key 的「可用分组 / 可用邮箱」会限制所有接口能访问的邮箱范围。</li>
          <li>分组策略为「Graph 优先 / IMAP 优先」时，两条路径都失败会合并成一个错误：<Text code>error.code</Text> 优先取账号层面的原因（如 <Text code>REFRESH_TOKEN_INVALID</Text>），<Text code>error.details.attempts</Text> 按顺序列出每条路径各自的错误。</li>
        </ul>

        <SectionTitle>响应格式</SectionTitle>
        <Paragraph style={{ marginBottom: 8 }}>
          除 <Text code>mail_text</Text> 和 <Text code>wait_code?format=text</Text> 外都返回 JSON。
          认证、权限和限流错误在进入接口前判断，始终返回 JSON。
        </Paragraph>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div>
            <Text strong style={{ color: '#52c41a' }}>成功</Text>
            <div style={{ marginTop: 6 }}><CodeBlock code={SUCCESS_SHAPE} /></div>
          </div>
          <div>
            <Text strong style={{ color: '#ff4d4f' }}>失败</Text>
            <div style={{ marginTop: 6 }}><CodeBlock code={ERROR_SHAPE} /></div>
          </div>
        </div>

        <SectionTitle>限流与权限</SectionTitle>
        <ul style={{ paddingInlineStart: 20, margin: 0 }}>
          <li>按 API Key 限流，每分钟最多调用该 Key 设置的次数（默认 60），不受全局 IP 限流影响。</li>
          <li>Key 未设置权限时可调用全部接口；设置了权限时只能调用勾选的接口，权限键见接口总览。</li>
        </ul>

        <SectionTitle>通用错误码</SectionTitle>
        <Table
          dataSource={COMMON_ERRORS}
          columns={errorColumns}
          pagination={false}
          size="small"
          rowKey="code"
          scroll={{ x: 'max-content' }}
        />

        <SectionTitle>健康检查</SectionTitle>
        <Text code copyable>{`${baseUrl}/health`}</Text>
      </Card>

      <Card title="接口总览" style={{ marginBottom: 16 }}>
        <Table
          dataSource={API_ENDPOINTS}
          columns={overviewColumns}
          pagination={false}
          size="small"
          rowKey="path"
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Card
        title="接口详情"
        style={{ marginBottom: 16 }}
        extra={
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            placeholder="搜索接口"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: isMobile ? 140 : 200 }}
          />
        }
      >
        {(Object.keys(CATEGORY_META) as ApiCategory[]).map((category) => {
          const items = filteredEndpoints.filter((api) => api.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} style={{ marginBottom: 16 }}>
              <Title level={5} style={{ marginBottom: 2 }}>{CATEGORY_META[category].title}</Title>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                {CATEGORY_META[category].desc}
              </Text>
              <Collapse
                activeKey={activeKeys}
                onChange={(keys) => setActiveKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
                items={items.map((api) => ({
                  key: api.path,
                  label: (
                    <span id={`api-${api.path}`} style={{ scrollMarginTop: 72 }}>
                      <Tag color="blue" style={{ marginInlineEnd: 8 }}>GET/POST</Tag>
                      <Text code>{api.path}</Text>
                      {!isMobile && <Text style={{ marginInlineStart: 8 }}>{api.name}</Text>}
                    </span>
                  ),
                  children: <EndpointDetail api={api} baseUrl={baseUrl} />,
                }))}
              />
            </div>
          );
        })}
        {filteredEndpoints.length === 0 && <Text type="secondary">没有匹配的接口</Text>}
      </Card>

      <Card title="Resend 兼容接口（Graph 账号池发信）" style={{ marginBottom: 16 }} id="resend">
        <Paragraph style={{ marginBottom: 8 }}>
          与 Resend 发信接口保持一致：请求字段、响应结构和错误格式都相同，现有 Resend SDK 或代码只需把接口地址改成
          <Text code copyable>{`${baseUrl}/resend`}</Text>，密钥换成本系统的 API Key。邮件实际由分组发信池中的 Outlook 账号通过 Microsoft Graph 发出。
        </Paragraph>
        <ul style={{ paddingInlineStart: 20, margin: '0 0 12px' }}>
          <li>认证：<Text code>Authorization: Bearer sk_your_api_key</Text></li>
          <li>权限：发信需要 <Text code>send_mail</Text>，查询需要 <Text code>send_read</Text>。这两项必须在 API Key 中单独勾选，未配置权限的 Key 也不能调用。</li>
          <li>准备：在「邮箱管理 → 邮箱分组」开启分组的发信，并在邮箱列表中检测账号的发信权限（令牌需带 Mail.Send）。</li>
          <li>错误格式：<Text code>{'{"statusCode": 422, "name": "validation_error", "message": "..."}'}</Text></li>
        </ul>

        <SectionTitle>接口</SectionTitle>
        <Table
          dataSource={RESEND_ENDPOINTS}
          columns={[
            { title: '接口', key: 'path', render: (_: unknown, item: ResendEndpoint) => <Space size={4}><Tag color="blue">{item.method}</Tag><Text code>{item.path}</Text></Space> },
            { title: '对应 Resend', dataIndex: 'resend', key: 'resend', render: (v: string) => <Text type="secondary">{v}</Text> },
            { title: '权限键', dataIndex: 'permission', key: 'permission', render: (v: string) => <Text code>{v}</Text> },
            { title: '说明', dataIndex: 'desc', key: 'desc' },
          ]}
          pagination={false}
          size="small"
          rowKey="path"
          scroll={{ x: 'max-content' }}
        />

        <SectionTitle>SDK 示例</SectionTitle>
        <CodeBlock code={RESEND_EXAMPLE(baseUrl)} />
        <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          其它语言的 Resend SDK 同样把接口地址（base URL）改为上面的地址即可，具体设置方式以各 SDK 文档为准。
        </Paragraph>

        <SectionTitle>curl 示例</SectionTitle>
        <CodeBlock code={RESEND_CURL(baseUrl)} />

        <SectionTitle>与 Resend 的差异（由 Graph 发信决定）</SectionTitle>
        <Table
          dataSource={RESEND_DIFFERENCES}
          columns={[
            { title: '项目', dataIndex: 'item', key: 'item', width: 140, render: (v: string) => <Text code>{v}</Text> },
            { title: '说明', dataIndex: 'desc', key: 'desc' },
          ]}
          pagination={false}
          size="small"
          rowKey="key"
          scroll={{ x: 'max-content' }}
        />

        <SectionTitle>错误</SectionTitle>
        <Table
          dataSource={RESEND_ERRORS}
          columns={[
            { title: 'HTTP', dataIndex: 'status', key: 'status', width: 70 },
            { title: 'name', dataIndex: 'name', key: 'name', render: (v: string) => <Text code>{v}</Text> },
            { title: '说明', dataIndex: 'desc', key: 'desc' },
          ]}
          pagination={false}
          size="small"
          rowKey="key"
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Card title="操作日志 Action / 权限键">
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          每次调用都会按 action 记录到「操作日志」，API Key 的权限也使用同一套值。
        </Paragraph>
        <Table
          dataSource={actionRows}
          columns={[
            { title: 'Action / 权限键', dataIndex: 'action', key: 'action', render: (v: string) => <Text code>{v}</Text> },
            { title: '含义', dataIndex: 'label', key: 'label' },
            { title: '对应接口', dataIndex: 'path', key: 'path', render: (v: string) => <Text code>{v}</Text> },
          ]}
          pagination={false}
          size="small"
          rowKey="action"
          scroll={{ x: 'max-content' }}
        />
      </Card>
    </div>
  );
};

export default ApiDocsPage;
