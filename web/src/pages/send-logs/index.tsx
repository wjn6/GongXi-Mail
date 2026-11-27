import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Table,
    Tag,
    Space,
    Card,
    Select,
    Button,
    Typography,
    Input,
    Drawer,
    Descriptions,
    Empty,
    Spin,
    Pagination,
    Tooltip,
    Statistic,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { PageHeader } from '../../components';
import { groupApi, sendApi } from '../../api';
import { requestData } from '../../utils/request';
import { useIsMobile } from '../../hooks/useIsMobile';

const { Text, Paragraph } = Typography;

type SendStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';
type SendSource = 'RESEND' | 'ADMIN';

interface MailAddress {
    address: string;
    name?: string;
}

interface SendLogItem {
    id: string;
    source: SendSource;
    status: SendStatus;
    requestedFrom: string;
    fromName: string | null;
    fromAddress: string | null;
    toAddresses: MailAddress[];
    subject: string;
    recipientCount: number;
    attachmentCount: number;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    batchId: string | null;
    createdAt: string;
    sentAt: string | null;
    nextAttemptAt: string | null;
    apiKey: { id: number; name: string } | null;
    group: { id: number; name: string } | null;
    emailAccount: { id: number; email: string } | null;
}

interface SendLogDetail extends SendLogItem {
    ccAddresses: MailAddress[] | null;
    bccAddresses: MailAddress[] | null;
    replyTo: MailAddress[] | null;
    html: string | null;
    text: string | null;
    tags: Array<{ name: string; value: string }> | null;
    headers: Array<{ name: string; value: string }> | null;
    attachmentBytes: number;
    requestIp: string | null;
}

interface GroupStats {
    id: number;
    name: string;
    sendEnabled: boolean;
    sendStrategy: string;
    sendDailyLimit: number;
    sendIntervalSeconds: number;
    sendMaxRecipients: number;
    active: number;
    allowed: number;
    denied: number;
    unknown: number;
    cooling: number;
    remaining: number;
    sent24h: number;
}

interface SendStats {
    totals: { sent24h: number; failed24h: number; queued: number };
    groups: GroupStats[];
}

const STATUS_META: Record<SendStatus, { color: string; label: string }> = {
    QUEUED: { color: 'default', label: '排队中' },
    SENDING: { color: 'processing', label: '发送中' },
    SENT: { color: 'green', label: '已提交' },
    FAILED: { color: 'red', label: '失败' },
};

const SOURCE_LABELS: Record<SendSource, string> = {
    RESEND: 'Resend 接口',
    ADMIN: '后台测试',
};

const formatTime = (val: string | null | undefined) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-');
const formatAddresses = (list: MailAddress[] | null | undefined) =>
    (list || []).map((item) => (item.name ? `${item.name} <${item.address}>` : item.address)).join(', ') || '-';

const renderStatus = (record: Pick<SendLogItem, 'status' | 'errorCode' | 'errorMessage' | 'nextAttemptAt'>) => {
    const meta = STATUS_META[record.status];
    const tag = <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>;
    const tips = [
        record.errorCode && record.errorMessage ? `${record.errorCode}: ${record.errorMessage}` : record.errorMessage,
        record.status === 'QUEUED' && record.nextAttemptAt ? `下次尝试 ${dayjs(record.nextAttemptAt).format('HH:mm:ss')}` : null,
    ].filter(Boolean).join('；');
    return tips ? <Tooltip title={tips}>{tag}</Tooltip> : tag;
};

const SendLogsPage: React.FC = () => {
    const isMobile = useIsMobile();
    const [loading, setLoading] = useState(false);
    const [logs, setLogs] = useState<SendLogItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [status, setStatus] = useState<SendStatus | undefined>();
    const [source, setSource] = useState<SendSource | undefined>();
    const [groupId, setGroupId] = useState<number | undefined>();
    const [keywordInput, setKeywordInput] = useState('');
    const [keyword, setKeyword] = useState('');
    const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
    const [stats, setStats] = useState<SendStats | null>(null);
    const [detail, setDetail] = useState<SendLogDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        const result = await requestData<{ list: SendLogItem[]; total: number }>(
            () => sendApi.getLogs({ page, pageSize, status, source, groupId, keyword: keyword || undefined }),
            '获取发信记录失败'
        );
        if (result) {
            setLogs(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [groupId, keyword, page, pageSize, source, status]);

    const fetchStats = useCallback(async () => {
        const result = await requestData<SendStats>(() => sendApi.getStats(), '获取发信池统计失败', { silent: true });
        if (result) setStats(result);
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchLogs();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchLogs]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchStats();
            void requestData<Array<{ id: number; name: string }>>(() => groupApi.getList(), '获取分组失败', { silent: true })
                .then((result) => result && setGroups(result));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchStats]);

    const openDetail = async (id: string) => {
        setDetailLoading(true);
        setDetail({ id } as SendLogDetail);
        const result = await requestData<SendLogDetail>(() => sendApi.getLog(id), '获取详情失败');
        setDetail(result);
        setDetailLoading(false);
    };

    const handleRefresh = () => {
        void fetchLogs();
        void fetchStats();
    };

    const enabledGroups = useMemo(() => (stats?.groups || []).filter((item) => item.sendEnabled), [stats]);

    const groupStatsColumns: ColumnsType<GroupStats> = [
        { title: '分组', dataIndex: 'name', key: 'name', render: (name: string) => <Tag color="blue">{name}</Tag> },
        {
            title: '账号',
            key: 'accounts',
            render: (_: unknown, record) => (
                <Space size={4} wrap>
                    <Tag color="green" style={{ marginInlineEnd: 0 }}>可发 {record.allowed}</Tag>
                    {record.unknown > 0 && <Tag style={{ marginInlineEnd: 0 }}>未检测 {record.unknown}</Tag>}
                    {record.denied > 0 && <Tag color="red" style={{ marginInlineEnd: 0 }}>无权限 {record.denied}</Tag>}
                    {record.cooling > 0 && <Tag color="orange" style={{ marginInlineEnd: 0 }}>冷却 {record.cooling}</Tag>}
                </Space>
            ),
        },
        { title: '24 小时已发', dataIndex: 'sent24h', key: 'sent24h', width: 110 },
        {
            title: '剩余额度',
            dataIndex: 'remaining',
            key: 'remaining',
            width: 110,
            render: (val: number) => <Text type={val === 0 ? 'danger' : undefined}>{val}</Text>,
        },
        {
            title: '规则',
            key: 'rule',
            render: (_: unknown, record) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                    每账号 {record.sendDailyLimit} 封/24h · 间隔 {record.sendIntervalSeconds}s · 收件人 ≤ {record.sendMaxRecipients}
                </Text>
            ),
        },
    ];

    const columns: ColumnsType<SendLogItem> = [
        { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 170, render: formatTime },
        { title: '状态', key: 'status', width: 90, render: (_: unknown, record) => renderStatus(record) },
        {
            title: '主题',
            dataIndex: 'subject',
            key: 'subject',
            ellipsis: true,
            render: (subject: string, record) => (
                <a onClick={() => void openDetail(record.id)}>{subject}</a>
            ),
        },
        {
            title: '收件人',
            key: 'to',
            width: 220,
            ellipsis: true,
            render: (_: unknown, record) => (
                <Text ellipsis style={{ maxWidth: 200 }}>
                    {formatAddresses(record.toAddresses)}
                    {record.recipientCount > record.toAddresses.length ? ` 等 ${record.recipientCount} 人` : ''}
                </Text>
            ),
        },
        {
            title: '发件账号',
            key: 'from',
            width: 220,
            ellipsis: true,
            render: (_: unknown, record) => record.emailAccount?.email || record.fromAddress || <Text type="secondary">未分配</Text>,
        },
        { title: '分组', key: 'group', width: 110, render: (_: unknown, record) => record.group ? <Tag color="blue">{record.group.name}</Tag> : '-' },
        {
            title: '来源',
            key: 'source',
            width: 150,
            render: (_: unknown, record) => (
                <Space size={4} direction="vertical">
                    <Text>{SOURCE_LABELS[record.source]}</Text>
                    {record.apiKey && <Text type="secondary" style={{ fontSize: 12 }}>{record.apiKey.name}</Text>}
                </Space>
            ),
        },
        { title: '尝试', dataIndex: 'attempts', key: 'attempts', width: 70 },
    ];

    const mobileList = (
        <Spin spinning={loading}>
            {logs.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无发信记录" style={{ padding: '24px 0' }} />
            ) : (
                <>
                    {logs.map((record) => (
                        <div key={record.id} className="gx-mobile-card" onClick={() => void openDetail(record.id)} style={{ cursor: 'pointer' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>{record.subject}</Text>
                                {renderStatus(record)}
                            </div>
                            <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                                收件人：{formatAddresses(record.toAddresses)}
                            </Text>
                            <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                                发件：{record.emailAccount?.email || record.fromAddress || '未分配'}
                                {record.group ? ` · ${record.group.name}` : ''}
                            </Text>
                            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                                {formatTime(record.createdAt)} · {SOURCE_LABELS[record.source]}
                            </Text>
                        </div>
                    ))}
                    <Pagination
                        align="center"
                        size="small"
                        current={page}
                        pageSize={pageSize}
                        total={total}
                        showSizeChanger={false}
                        onChange={(p) => setPage(p)}
                        style={{ marginTop: 12 }}
                    />
                </>
            )}
        </Spin>
    );

    const detailSrcDoc = useMemo(() => {
        if (!detail?.html) return '';
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#333;margin:0;padding:12px;word-break:break-word}img,table{max-width:100%!important;height:auto}</style>
</head><body>${detail.html}</body></html>`;
    }, [detail]);

    return (
        <div>
            <PageHeader
                title="发信记录"
                subtitle="Resend 兼容接口与后台测试发信的记录；「已提交」表示 Microsoft Graph 已接收，是否送达以收件方为准"
                extra={<Button icon={<ReloadOutlined />} onClick={handleRefresh}>刷新</Button>}
            />

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(3, minmax(0, 220px))', gap: 12, marginBottom: 16 }}>
                <Card size="small"><Statistic title="24 小时已提交" value={stats?.totals.sent24h ?? 0} styles={{ content: { color: '#52c41a' } }} /></Card>
                <Card size="small"><Statistic title="24 小时失败" value={stats?.totals.failed24h ?? 0} styles={{ content: { color: (stats?.totals.failed24h ?? 0) > 0 ? '#ff4d4f' : undefined } }} /></Card>
                <Card size="small"><Statistic title="排队 / 发送中" value={stats?.totals.queued ?? 0} /></Card>
            </div>

            <Card title="发信池" size="small" style={{ marginBottom: 16 }}>
                {enabledGroups.length > 0 ? (
                    <Table
                        dataSource={enabledGroups}
                        columns={groupStatsColumns}
                        rowKey="id"
                        pagination={false}
                        size="small"
                        scroll={{ x: 'max-content' }}
                    />
                ) : (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="还没有分组开启发信。在「邮箱管理 → 邮箱分组」编辑分组即可开启。"
                    />
                )}
            </Card>

            <Card variant="borderless">
                <div className="gx-toolbar">
                    <div className="gx-toolbar-filters">
                        <Select
                            placeholder="状态"
                            allowClear
                            style={{ width: 120 }}
                            value={status}
                            options={(Object.keys(STATUS_META) as SendStatus[]).map((value) => ({ value, label: STATUS_META[value].label }))}
                            onChange={(val) => { setStatus(val); setPage(1); }}
                        />
                        <Select
                            placeholder="来源"
                            allowClear
                            style={{ width: 130 }}
                            value={source}
                            options={(Object.keys(SOURCE_LABELS) as SendSource[]).map((value) => ({ value, label: SOURCE_LABELS[value] }))}
                            onChange={(val) => { setSource(val); setPage(1); }}
                        />
                        <Select
                            placeholder="分组"
                            allowClear
                            style={{ width: 140 }}
                            value={groupId}
                            options={groups.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(val) => { setGroupId(val); setPage(1); }}
                        />
                        <Input
                            placeholder="搜索主题或发件地址"
                            prefix={<SearchOutlined />}
                            allowClear
                            value={keywordInput}
                            onChange={(e) => {
                                setKeywordInput(e.target.value);
                                if (!e.target.value) { setKeyword(''); setPage(1); }
                            }}
                            onPressEnter={() => { setKeyword(keywordInput.trim()); setPage(1); }}
                            style={{ width: 220 }}
                        />
                    </div>
                </div>

                {isMobile ? mobileList : (
                    <Table
                        dataSource={logs}
                        columns={columns}
                        rowKey="id"
                        loading={loading}
                        scroll={{ x: 'max-content' }}
                        locale={{ emptyText: '暂无发信记录' }}
                        pagination={{
                            current: page,
                            pageSize,
                            total,
                            showSizeChanger: true,
                            showTotal: (t) => `共 ${t} 条`,
                            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
                        }}
                    />
                )}
            </Card>

            <Drawer
                title="发信详情"
                open={!!detail}
                onClose={() => setDetail(null)}
                size={isMobile ? window.innerWidth : 640}
                destroyOnHidden
            >
                <Spin spinning={detailLoading}>
                    {detail && detail.subject !== undefined && (
                        <>
                            <Descriptions column={1} size="small" bordered>
                                <Descriptions.Item label="邮件 ID"><Text copyable>{detail.id}</Text></Descriptions.Item>
                                <Descriptions.Item label="状态">{renderStatus(detail)}</Descriptions.Item>
                                {detail.errorMessage && (
                                    <Descriptions.Item label="错误">
                                        <Text type="danger">{detail.errorCode ? `${detail.errorCode}: ` : ''}{detail.errorMessage}</Text>
                                    </Descriptions.Item>
                                )}
                                <Descriptions.Item label="主题">{detail.subject}</Descriptions.Item>
                                <Descriptions.Item label="请求的发件人">{detail.requestedFrom}</Descriptions.Item>
                                <Descriptions.Item label="实际发件账号">{detail.emailAccount?.email || detail.fromAddress || '未分配'}</Descriptions.Item>
                                <Descriptions.Item label="收件人">{formatAddresses(detail.toAddresses)}</Descriptions.Item>
                                {detail.ccAddresses && <Descriptions.Item label="抄送">{formatAddresses(detail.ccAddresses)}</Descriptions.Item>}
                                {detail.bccAddresses && <Descriptions.Item label="密送">{formatAddresses(detail.bccAddresses)}</Descriptions.Item>}
                                {detail.replyTo && <Descriptions.Item label="回复地址">{formatAddresses(detail.replyTo)}</Descriptions.Item>}
                                <Descriptions.Item label="分组">{detail.group?.name || '-'}</Descriptions.Item>
                                <Descriptions.Item label="来源">
                                    {SOURCE_LABELS[detail.source]}{detail.apiKey ? ` · ${detail.apiKey.name}` : ''}
                                </Descriptions.Item>
                                <Descriptions.Item label="附件">
                                    {detail.attachmentCount > 0 ? `${detail.attachmentCount} 个，${Math.ceil(detail.attachmentBytes / 1024)} KB（内容不保存）` : '无'}
                                </Descriptions.Item>
                                {detail.tags && detail.tags.length > 0 && (
                                    <Descriptions.Item label="Tags">
                                        <Space size={4} wrap>
                                            {detail.tags.map((tag) => <Tag key={`${tag.name}:${tag.value}`}>{tag.name}={tag.value}</Tag>)}
                                        </Space>
                                    </Descriptions.Item>
                                )}
                                <Descriptions.Item label="创建时间">{formatTime(detail.createdAt)}</Descriptions.Item>
                                <Descriptions.Item label="提交时间">{formatTime(detail.sentAt)}</Descriptions.Item>
                                <Descriptions.Item label="尝试账号数">{detail.attempts}</Descriptions.Item>
                                {detail.batchId && <Descriptions.Item label="批次">{detail.batchId}</Descriptions.Item>}
                            </Descriptions>
                            <Typography.Title level={5} style={{ marginTop: 16 }}>正文</Typography.Title>
                            {detail.html ? (
                                <iframe
                                    title="send-log-content"
                                    sandbox=""
                                    srcDoc={detailSrcDoc}
                                    referrerPolicy="no-referrer"
                                    style={{ width: '100%', height: 360, border: '1px solid #eee', borderRadius: 8, background: '#fff' }}
                                />
                            ) : (
                                <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 12, borderRadius: 8 }}>
                                    {detail.text || '-'}
                                </Paragraph>
                            )}
                        </>
                    )}
                </Spin>
            </Drawer>
        </div>
    );
};

export default SendLogsPage;
