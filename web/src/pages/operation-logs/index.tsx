import React, { useCallback, useEffect, useState } from 'react';
import { Table, Tag, Space, Card, Select, Button, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components';
import { logsApi } from '../../api';
import { LOG_ACTION_OPTIONS, getLogActionColor, getLogActionLabel } from '../../constants/logActions';
import type { LogAction } from '../../constants/logActions';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';

const { Text } = Typography;

interface LogItem {
    id: number;
    action: string;
    apiKeyName: string;
    email: string;
    requestIp: string;
    requestId: string | null;
    responseCode: number;
    responseTimeMs: number;
    createdAt: string;
}

const OperationLogsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [logs, setLogs] = useState<LogItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [actionFilter, setActionFilter] = useState<LogAction | undefined>();

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        const result = await requestData<{ list: LogItem[]; total: number }>(
            () => logsApi.getList({ page, pageSize, action: actionFilter }),
            '获取日志失败'
        );
        if (result) {
            setLogs(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [actionFilter, page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchLogs();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchLogs]);

    const columns = [
        {
            title: '时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 170,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm:ss'),
        },
        {
            title: 'API Key',
            dataIndex: 'apiKeyName',
            key: 'apiKeyName',
            width: 150,
            render: (name: string) => name === '-' ? <Text type="secondary">-</Text> : <Tag color="blue">{name}</Tag>,
        },
        {
            title: '操作',
            dataIndex: 'action',
            key: 'action',
            width: 140,
            render: (action: string) => {
                return <Tag color={getLogActionColor(action)}>{getLogActionLabel(action)}</Tag>;
            },
        },
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            ellipsis: true,
            render: (email: string) => email === '-' ? <Text type="secondary">-</Text> : email,
        },
        {
            title: '状态码',
            dataIndex: 'responseCode',
            key: 'responseCode',
            width: 80,
            align: 'center' as const,
            render: (code: number) => (
                <Tag color={code === 200 ? 'success' : 'error'}>{code}</Tag>
            ),
        },
        {
            title: '耗时',
            dataIndex: 'responseTimeMs',
            key: 'responseTimeMs',
            width: 100,
            align: 'right' as const,
            render: (ms: number) => `${ms} ms`,
        },
        {
            title: 'IP 地址',
            dataIndex: 'requestIp',
            key: 'requestIp',
            width: 140,
        },
        {
            title: 'Request ID',
            dataIndex: 'requestId',
            key: 'requestId',
            width: 220,
            render: (requestId: string | null) => requestId ? <Text copyable>{requestId}</Text> : <Text type="secondary">-</Text>,
        },
    ];

    return (
        <div>
            <PageHeader
                title="API 调用日志"
                subtitle="记录所有通过 API Key 的外部调用"
                extra={
                    <Button icon={<ReloadOutlined />} onClick={fetchLogs}>
                        刷新
                    </Button>
                }
            />

            <Card bordered={false}>
                <Space style={{ marginBottom: 16 }}>
                    <Select
                        placeholder="筛选操作类型"
                        style={{ width: 160 }}
                        allowClear
                        options={LOG_ACTION_OPTIONS}
                        onChange={(val) => setActionFilter(val as LogAction | undefined)}
                    />
                    <Text type="secondary">
                        提示：只有通过 API Key 调用的接口才会记录日志
                    </Text>
                </Space>

                <Table
                    dataSource={logs}
                    columns={columns}
                    rowKey="id"
                    loading={loading}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        showQuickJumper: true,
                        showTotal: (t) => `共 ${t} 条`,
                        onChange: (p, ps) => {
                            setPage(p);
                            setPageSize(ps);
                        },
                    }}
                    locale={{ emptyText: '暂无 API 调用日志' }}
                />
            </Card>
        </div>
    );
};

export default OperationLogsPage;
