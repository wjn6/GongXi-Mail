import React from 'react';
import { Typography, Card, Tabs, Tag, Table, Divider, Alert, Row, Col } from 'antd';
import { LOG_ACTION_OPTIONS } from '../../constants/logActions';

const { Title, Text, Paragraph } = Typography;

const ApiDocsPage: React.FC = () => {
  const baseUrl = window.location.origin;

  const enumRules = [
    { key: 'role', name: '管理员角色', values: 'SUPER_ADMIN / ADMIN', desc: '用于后台权限判定' },
    { key: 'status', name: '管理员/API Key 状态', values: 'ACTIVE / DISABLED', desc: '统一使用大写枚举值' },
  ];

  const logActionDescriptions: Record<string, string> = {
    get_email: '分配邮箱',
    mail_new: '获取最新邮件',
    mail_text: '获取邮件文本',
    mail_all: '获取所有邮件',
    process_mailbox: '清空邮箱',
    list_emails: '获取邮箱列表',
    pool_stats: '邮箱池统计',
    pool_reset: '重置邮箱池',
  };

  const logActionRows = LOG_ACTION_OPTIONS.map((item) => ({
    action: item.value,
    label: item.label,
    description: logActionDescriptions[item.value] || item.label,
  }));

  const authMethods = [
    {
      method: 'Header (推荐)',
      example: 'X-API-Key: sk_your_api_key',
      description: '在请求头中传递 API Key',
    },
    {
      method: 'Bearer Token',
      example: 'Authorization: Bearer sk_your_api_key',
      description: '使用 Bearer Token 格式',
    },
    {
      method: 'Query 参数',
      example: '?api_key=sk_your_api_key',
      description: 'URL 参数传递（不推荐，会被日志记录）',
    },
  ];

  const apiEndpoints = [
    {
      name: '获取邮箱地址',
      method: 'GET/POST',
      path: '/api/get-email',
      description: '从邮箱池中分配一个未使用的邮箱地址。可通过 group 参数限制仅从指定分组中分配。',
      params: [
        { name: 'group', type: 'string', required: false, desc: '分组名称，仅从该分组中分配' },
      ],
      example: `curl -X POST "${baseUrl}/api/get-email" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "id": 1
  }
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "NO_UNUSED_EMAIL",
    "message": "No unused emails available."
  }
}`,
    },
    {
      name: '获取最新邮件',
      method: 'GET/POST',
      path: '/api/mail_new',
      description: '获取指定邮箱的最新一封邮件。只要邮箱地址存在于系统中即可获取。',
      params: [
        { name: 'email', type: 'string', required: true, desc: '邮箱地址' },
        { name: 'mailbox', type: 'string', required: false, desc: '邮件文件夹，默认 inbox' },
        { name: 'socks5', type: 'string', required: false, desc: 'SOCKS5 代理地址' },
        { name: 'http', type: 'string', required: false, desc: 'HTTP 代理地址' },
      ],
      example: `curl -X POST "${baseUrl}/api/mail_new" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com"}'`,
      successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "mailbox": "inbox",
    "count": 1,
    "messages": [
      {
        "id": "AAMk...",
        "subject": "验证码邮件",
        "from": "noreply@example.com",
        "text": "您的验证码是 123456"
      }
    ],
    "method": "graph_api"
  },
  "email": "example@outlook.com"
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "EMAIL_NOT_FOUND",
    "message": "Email account not found"
  }
}`,
    },
    {
      name: '获取邮件文本 (脚本)',
      method: 'GET/POST',
      path: '/api/mail_text',
      description: '专门为脚本设计的轻量接口，返回 `text/plain` 格式的内容。支持正则表达式提取验证码。',
      params: [
        { name: 'email', type: 'string', required: true, desc: '邮箱地址' },
        { name: 'match', type: 'string', required: false, desc: '正则表达式 (例如 `\\d{6}`)' },
      ],
      example: `# 获取验证码
curl "${baseUrl}/api/mail_text?email=example@outlook.com&match=\\d{6}" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `123456`,
      errorResponse: `Error: No match found`,
    },
    {
      name: '获取所有邮件',
      method: 'GET/POST',
      path: '/api/mail_all',
      description: '获取指定邮箱的所有邮件。只要邮箱地址存在于系统中即可获取。',
      params: [
        { name: 'email', type: 'string', required: true, desc: '邮箱地址' },
        { name: 'mailbox', type: 'string', required: false, desc: '邮件文件夹，默认 inbox' },
        { name: 'socks5', type: 'string', required: false, desc: 'SOCKS5 代理地址' },
        { name: 'http', type: 'string', required: false, desc: 'HTTP 代理地址' },
      ],
      example: `curl "${baseUrl}/api/mail_all?email=example@outlook.com" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `{
  "success": true,
  "data": {
    "email": "example@outlook.com",
    "mailbox": "inbox",
    "count": 2,
    "messages": [
      { "id": "...", "subject": "邮件1" },
      { "id": "...", "subject": "邮件2" }
    ],
    "method": "imap"
  },
  "email": "example@outlook.com"
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "EMAIL_NOT_FOUND",
    "message": "Email account not found"
  }
}`,
    },
    {
      name: '清空邮箱',
      method: 'GET/POST',
      path: '/api/process-mailbox',
      description: '清空指定邮箱的所有邮件。',
      params: [
        { name: 'email', type: 'string', required: true, desc: '邮箱地址' },
        { name: 'mailbox', type: 'string', required: false, desc: '邮件文件夹，默认 inbox' },
        { name: 'socks5', type: 'string', required: false, desc: 'SOCKS5 代理地址' },
        { name: 'http', type: 'string', required: false, desc: 'HTTP 代理地址' },
      ],
      example: `curl -X POST "${baseUrl}/api/process-mailbox" \\
  -H "X-API-Key: sk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "example@outlook.com"}'`,
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
      errorResponse: `{
  "success": false,
  "error": {
    "code": "EMAIL_NOT_FOUND",
    "message": "Email account not found"
  }
}`,
    },
    {
      name: '获取可用邮箱列表',
      method: 'GET/POST',
      path: '/api/list-emails',
      description: '获取系统中所有可用的邮箱地址列表。支持按分组筛选。',
      params: [
        { name: 'group', type: 'string', required: false, desc: '分组名称，仅返回该分组内的邮箱' },
      ],
      example: `curl "${baseUrl}/api/list-emails" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `{
  "success": true,
  "data": {
    "total": 100,
    "emails": [
      { "email": "user1@outlook.com", "status": "ACTIVE" },
      { "email": "user2@outlook.com", "status": "ACTIVE" }
    ]
  }
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "API Key required"
  }
}`,
    },
    {
      name: '邮箱池统计',
      method: 'GET/POST',
      path: '/api/pool-stats',
      description: '获取当前 API Key 的分配使用情况。支持按分组筛选。',
      params: [
        { name: 'group', type: 'string', required: false, desc: '分组名称，仅统计该分组' },
      ],
      example: `curl "${baseUrl}/api/pool-stats" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `{
  "success": true,
  "data": {
    "total": 100,
    "used": 3,
    "remaining": 97
  }
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "API Key required"
  }
}`,
    },
    {
      name: '重置分配记录',
      method: 'GET/POST',
      path: '/api/reset-pool',
      description: '重置当前 API Key 的分配记录。支持按分组重置。',
      params: [
        { name: 'group', type: 'string', required: false, desc: '分组名称，仅重置该分组' },
      ],
      example: `curl -X POST "${baseUrl}/api/reset-pool" \\
  -H "X-API-Key: sk_your_api_key"`,
      successResponse: `{
  "success": true,
  "data": {
    "message": "Pool reset successfully"
  }
}`,
      errorResponse: `{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "API Key required"
  }
}`,
    },
  ];

  const paramColumns = [
    { title: '参数名', dataIndex: 'name', key: 'name', render: (t: string) => <Text code>{t}</Text> },
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '必填', dataIndex: 'required', key: 'required', render: (r: boolean) => r ? <Tag color="red">是</Tag> : <Tag>否</Tag> },
    { title: '说明', dataIndex: 'desc', key: 'desc' },
  ];

  return (
    <div>
      <Title level={4}>API 文档</Title>
      <Text type="secondary">用户邮箱自助获取与管理</Text>

      <Divider />

      <Alert
        message="接口说明"
        description={
          <div>
            <p style={{ marginBottom: 8 }}>系统提供灵活的邮箱访问方式：</p>
            <ul style={{ marginBottom: 8, paddingLeft: 20 }}>
              <li><strong>直接访问</strong>：如果您已知目标邮箱地址，可直接调用 <code>/api/mail_new</code> 或 <code>/api/mail_all</code> 获取邮件，无需任何前置分配操作。</li>
              <li><strong>自动分配</strong>：如果你需要一个新的、未使用的邮箱，请调用 <code>/api/get-email</code>。这将返回一个随机邮箱并标记为您已使用，避免重复。</li>
              <li><strong>文本提速</strong>：对于自动化脚本，推荐使用 <code>/api/mail_text</code> 配合正则匹配，直接获取验证码等核心信息。</li>
            </ul>
          </div>
        }
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card title="认证方式" style={{ marginBottom: 24 }}>
        <Alert
          message="所有 API 请求都需要携带有效的 API Key"
          description="请在「API Key」页面创建密钥，密钥只在创建时显示一次，请妥善保存。"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Table
          dataSource={authMethods}
          columns={[
            { title: '方式', dataIndex: 'method', key: 'method' },
            { title: '示例', dataIndex: 'example', key: 'example', render: (t: string) => <Text code copyable>{t}</Text> },
            { title: '说明', dataIndex: 'description', key: 'description' },
          ]}
          pagination={false}
          size="small"
          rowKey="method"
        />
      </Card>

      <Card title="健康检查与生产配置" style={{ marginBottom: 24 }}>
        <Alert
          message="健康检查"
          description={<Text code>{`${baseUrl}/health`}</Text>}
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Alert
          message="生产环境要求"
          description="JWT_SECRET、ENCRYPTION_KEY、ADMIN_PASSWORD 必须通过外部环境变量注入，不应写死在仓库或镜像中。"
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Table
          dataSource={[
            { key: 'JWT_SECRET', name: 'JWT_SECRET', requirement: '至少 32 字符，随机强密钥' },
            { key: 'ENCRYPTION_KEY', name: 'ENCRYPTION_KEY', requirement: '固定 32 字符，用于敏感字段加密' },
            { key: 'ADMIN_PASSWORD', name: 'ADMIN_PASSWORD', requirement: '强密码，不使用默认值' },
          ]}
          columns={[
            { title: '变量', dataIndex: 'name', key: 'name', render: (value: string) => <Text code>{value}</Text> },
            { title: '要求', dataIndex: 'requirement', key: 'requirement' },
          ]}
          pagination={false}
          size="small"
          rowKey="key"
        />
      </Card>

      <Card title="枚举约定" style={{ marginBottom: 24 }}>
        <Table
          dataSource={enumRules}
          columns={[
            { title: '类型', dataIndex: 'name', key: 'name' },
            { title: '枚举值', dataIndex: 'values', key: 'values', render: (value: string) => <Text code>{value}</Text> },
            { title: '说明', dataIndex: 'desc', key: 'desc' },
          ]}
          pagination={false}
          size="small"
          rowKey="key"
        />
      </Card>

      <Card title="操作日志 Action 值" style={{ marginBottom: 24 }}>
        <Alert
          message="用于 /admin/dashboard/logs 的 action 筛选"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Table
          dataSource={logActionRows}
          columns={[
            { title: 'Action', dataIndex: 'action', key: 'action', render: (value: string) => <Text code>{value}</Text> },
            { title: '中文含义', dataIndex: 'label', key: 'label' },
            { title: '说明', dataIndex: 'description', key: 'description' },
          ]}
          pagination={false}
          size="small"
          rowKey="action"
        />
      </Card>

      <Card title="接口列表">
        <Tabs
          items={apiEndpoints.map((api, index) => ({
            key: String(index),
            label: api.name,
            children: (
              <div>
                <Paragraph>
                  <Tag color="blue">{api.method}</Tag>
                  <Text code copyable style={{ marginLeft: 8 }}>{baseUrl}{api.path}</Text>
                </Paragraph>
                <Paragraph type="secondary">{api.description}</Paragraph>

                {api.params.length > 0 && (
                  <>
                    <Title level={5} style={{ marginTop: 16 }}>请求参数</Title>
                    <Table
                      dataSource={api.params}
                      columns={paramColumns}
                      pagination={false}
                      size="small"
                      rowKey="name"
                    />
                  </>
                )}

                <Title level={5} style={{ marginTop: 24 }}>调用示例</Title>
                <Card size="small" style={{ background: '#f5f5f5' }}>
                  <Text code style={{ whiteSpace: 'pre-wrap' }}>
                    {api.example}
                  </Text>
                </Card>

                <Title level={5} style={{ marginTop: 24 }}>响应示例</Title>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text strong style={{ color: '#52c41a' }}>成功响应</Text>
                    <Card size="small" style={{ background: '#f6ffed', marginTop: 8 }}>
                      <Text code style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                        {api.successResponse}
                      </Text>
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Text strong style={{ color: '#ff4d4f' }}>错误响应</Text>
                    <Card size="small" style={{ background: '#fff2f0', marginTop: 8 }}>
                      <Text code style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                        {api.errorResponse}
                      </Text>
                    </Card>
                  </Col>
                </Row>
              </div>
            ),
          }))}
        />
      </Card>
    </div>
  );
};

export default ApiDocsPage;
