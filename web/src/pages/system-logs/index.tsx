import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { PageHeader } from '../../components';
import { logsApi } from '../../api';
import { requestData } from '../../utils/request';

const { Text } = Typography;

type SystemLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface SystemLogItem {
    id: string;
    time: string;
    level: SystemLogLevel;
    action: string | null;
    actorUsername: string | null;
    message: string;
    requestId: string | null;
    trigger: string | null;
    raw: string;
    context: Record<string, unknown>;
}

const levelOptions = [
    { label: '全部级别', value: '' },
    { label: 'TRACE', value: 'trace' },
    { label: 'DEBUG', value: 'debug' },
    { label: 'INFO', value: 'info' },
    { label: 'WARN', value: 'warn' },
    { label: 'ERROR', value: 'error' },
    { label: 'FATAL', value: 'fatal' },
];

const lineOptions = [
    { label: '最近 100 条', value: 100 },
    { label: '最近 200 条', value: 200 },
    { label: '最近 500 条', value: 500 },
    { label: '最近 1000 条', value: 1000 },
];

function getLevelColor(level: SystemLogLevel) {
    switch (level) {
        case 'trace':
            return 'default';
        case 'debug':
            return 'blue';
        case 'info':
            return 'success';
        case 'warn':
            return 'warning';
        case 'error':
        case 'fatal':
            return 'error';
        default:
            return 'default';
    }
}

const SystemLogsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [logs, setLogs] = useState<SystemLogItem[]>([]);
    const [filePath, setFilePath] = useState('');
    const [levelFilter, setLevelFilter] = useState<SystemLogLevel | undefined>();
    const [keyword, setKeyword] = useState('');
    const [keywordInput, setKeywordInput] = useState('');
    const [lines, setLines] = useState(200);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        const result = await requestData<{ filePath: string; lines: number; list: SystemLogItem[] }>(
            () => logsApi.getSystemLogs({
                level: levelFilter,
                keyword: keyword || undefined,
                lines,
            }),
            '获取系统日志失败'
        );
        if (result) {
            setLogs(result.list);
            setFilePath(result.filePath);
        }
        setLoading(false);
    }, [keyword, levelFilter, lines]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchLogs();
        }, 0);

        return () => window.clearTimeout(timer);
    }, [fetchLogs]);

    const columns = [
        {
            title: '时间',
            dataIndex: 'time',
            key: 'time',
            width: 180,
            render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
        },
        {
            title: '级别',
            dataIndex: 'level',
            key: 'level',
            width: 100,
            render: (level: SystemLogLevel) => <Tag color={getLevelColor(level)}>{level.toUpperCase()}</Tag>,
        },
        {
            title: '操作',
            dataIndex: 'action',
            key: 'action',
            width: 220,
            render: (action: string | null) => action ? <Text code>{action}</Text> : <Text type="secondary">-</Text>,
        },
        {
            title: '操作者',
            dataIndex: 'actorUsername',
            key: 'actorUsername',
            width: 140,
            render: (value: string | null) => value || <Text type="secondary">系统</Text>,
        },
        {
            title: '触发',
            dataIndex: 'trigger',
            key: 'trigger',
            width: 100,
            render: (trigger: string | null) => trigger
                ? <Tag color={trigger === 'AUTO' ? 'blue' : 'gold'}>{trigger}</Tag>
                : <Text type="secondary">-</Text>,
        },
        {
            title: '消息',
            dataIndex: 'message',
            key: 'message',
            ellipsis: true,
        },
    ];

    return (
        <div>
            <PageHeader
                title="系统日志"
                subtitle="查看后台业务事件日志，例如新增、修改、删除、刷新和系统任务"
                extra={(
                    <Button icon={<ReloadOutlined />} onClick={() => void fetchLogs()}>
                        刷新
                    </Button>
                )}
            />

            <Card variant="borderless">
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Alert
                        type="info"
                        showIcon
                        message="日志文件"
                        description={filePath || '当前还没有生成日志文件'}
                    />

                    <Space wrap>
                        <Select
                            value={levelFilter || ''}
                            options={levelOptions}
                            style={{ width: 150 }}
                            onChange={(value) => setLevelFilter((value || undefined) as SystemLogLevel | undefined)}
                        />
                        <Select
                            value={lines}
                            options={lineOptions}
                            style={{ width: 140 }}
                            onChange={setLines}
                        />
                        <Input.Search
                            placeholder="搜索日志关键字"
                            value={keywordInput}
                            onChange={(event) => setKeywordInput(event.target.value)}
                            onSearch={(value) => setKeyword(value.trim())}
                            allowClear
                            style={{ width: 260 }}
                        />
                    </Space>

                    <Table
                        scroll={{ x: 'max-content' }}
                        rowKey="id"
                        dataSource={logs}
                        columns={columns}
                        loading={loading}
                        pagination={false}
                        locale={{ emptyText: '暂无系统日志' }}
                        expandable={{
                            expandedRowRender: (record: SystemLogItem) => (
                                <div style={{ display: 'grid', gap: 12 }}>
                                    {record.requestId ? (
                                        <div>
                                            <Text strong>Request ID</Text>
                                            <div style={{ marginTop: 8 }}>
                                                <Text copyable>{record.requestId}</Text>
                                            </div>
                                        </div>
                                    ) : null}
                                    <div>
                                        <Text strong>上下文</Text>
                                        <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                            {JSON.stringify(record.context, null, 2) || '{}'}
                                        </pre>
                                    </div>
                                    <div>
                                        <Text strong>原始日志</Text>
                                        <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                            {record.raw}
                                        </pre>
                                    </div>
                                </div>
                            ),
                        }}
                    />
                </Space>
            </Card>
        </div>
    );
};

export default SystemLogsPage;
