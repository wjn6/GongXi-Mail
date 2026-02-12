import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Row, Col, Card, Table, Tag, Typography, Spin } from 'antd';
import {
    MailOutlined,
    KeyOutlined,
    CheckCircleOutlined,
    ApiOutlined,
} from '@ant-design/icons';
import { StatCard, PageHeader } from '../../components';
import { dashboardApi, emailApi, apiKeyApi } from '../../api';
import dayjs from 'dayjs';

const { Text } = Typography;

const LineChart = lazy(async () => {
    const mod = await import('@ant-design/charts');
    return { default: mod.Line as React.ComponentType<Record<string, unknown>> };
});

const PieChart = lazy(async () => {
    const mod = await import('@ant-design/charts');
    return { default: mod.Pie as React.ComponentType<Record<string, unknown>> };
});

interface Stats {
    apiKeys: {
        total: number;
        active: number;
        totalUsage: number;
        todayActive: number;
    };
    emails: {
        total: number;
        active: number;
        error: number;
    };
}

interface DashboardEmailItem {
    id: number;
    email: string;
    status: 'ACTIVE' | 'ERROR' | 'DISABLED';
    createdAt: string;
}

interface DashboardApiKeyItem {
    id: number;
    name: string;
    usageCount: number;
    status: 'ACTIVE' | 'DISABLED';
}

interface ApiTrendItem {
    date: string;
    count: number;
}

const DashboardPage: React.FC = () => {
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState<Stats | null>(null);
    const [recentEmails, setRecentEmails] = useState<DashboardEmailItem[]>([]);
    const [recentApiKeys, setRecentApiKeys] = useState<DashboardApiKeyItem[]>([]);
    const [apiTrend, setApiTrend] = useState<ApiTrendItem[]>([]);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            const [statsRes, emailsRes, apiKeysRes, trendRes] = await Promise.all([
                dashboardApi.getStats<Stats>(),
                emailApi.getList<DashboardEmailItem>({ page: 1, pageSize: 5 }),
                apiKeyApi.getList<DashboardApiKeyItem>({ page: 1, pageSize: 5 }),
                dashboardApi.getApiTrend<ApiTrendItem>(7),
            ]);

            if (statsRes.code === 200) {
                setStats(statsRes.data);
            }
            if (emailsRes.code === 200) {
                setRecentEmails(emailsRes.data.list);
            }
            if (apiKeysRes.code === 200) {
                setRecentApiKeys(apiKeysRes.data.list);
            }
            if (trendRes.code === 200) {
                setApiTrend(trendRes.data);
            }
        } catch (err) {
            console.error('Failed to fetch data:', err);
        } finally {
            setLoading(false);
        }
    };

    const emailColumns = [
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            ellipsis: true,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 80,
            render: (status: string) => {
                const config: Record<string, { color: string; text: string }> = {
                    ACTIVE: { color: 'success', text: '正常' },
                    ERROR: { color: 'error', text: '异常' },
                    DISABLED: { color: 'default', text: '禁用' },
                };
                return <Tag color={config[status]?.color}>{config[status]?.text}</Tag>;
            },
        },
        {
            title: '添加时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 120,
            render: (val: string) => dayjs(val).format('MM-DD HH:mm'),
        },
    ];

    const apiKeyColumns = [
        {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
            ellipsis: true,
        },
        {
            title: '使用次数',
            dataIndex: 'usageCount',
            key: 'usageCount',
            width: 100,
            render: (val: number) => <Text strong>{(val || 0).toLocaleString()}</Text>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 80,
            render: (status: string) => (
                <Tag color={status === 'ACTIVE' ? 'success' : 'default'}>
                    {status === 'ACTIVE' ? '启用' : '禁用'}
                </Tag>
            ),
        },
    ];

    // 图表配置
    const lineConfig = useMemo(() => ({
        data: apiTrend,
        xField: 'date',
        yField: 'count',
        smooth: true,
        height: 280,
        point: { size: 4, shape: 'circle' },
        color: '#1890ff',
        areaStyle: {
            fill: 'l(270) 0:#ffffff 1:#1890ff20',
        },
        xAxis: {
            label: {
                formatter: (v: string) => dayjs(v).format('MM-DD'),
            },
        },
    }), [apiTrend]);

    const pieData = useMemo(() => (stats ? [
        { type: '正常', value: stats.emails.active },
        { type: '异常', value: stats.emails.error },
        { type: '禁用', value: Math.max(0, stats.emails.total - stats.emails.active - stats.emails.error) },
    ].filter(d => d.value > 0) : []), [stats]);

    const pieConfig = useMemo(() => ({
        data: pieData,
        angleField: 'value',
        colorField: 'type',
        height: 280,
        radius: 0.8,
        innerRadius: 0.6,
        color: ['#52c41a', '#ff4d4f', '#d9d9d9'],
        label: {
            type: 'inner',
            offset: '-50%',
            content: '{value}',
            style: { textAlign: 'center', fontSize: 14 },
        },
        statistic: {
            title: { content: '邮箱' },
            content: { content: stats?.emails.total?.toString() || '0' },
        },
    }), [pieData, stats]);

    if (loading) {
        return (
            <div style={{ textAlign: 'center', padding: 100 }}>
                <Spin size="large" />
            </div>
        );
    }

    return (
        <div>
            <PageHeader title="数据概览" subtitle="实时监控系统运行状态" />

            {/* 统计卡片 */}
            <Row gutter={[16, 16]}>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="邮箱总数"
                        value={stats?.emails.total || 0}
                        icon={<MailOutlined />}
                        iconBgColor="#1890ff"
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="正常邮箱"
                        value={stats?.emails.active || 0}
                        icon={<CheckCircleOutlined />}
                        iconBgColor="#52c41a"
                        suffix={`/ ${stats?.emails.total || 0}`}
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="API 调用总数"
                        value={stats?.apiKeys.totalUsage || 0}
                        icon={<ApiOutlined />}
                        iconBgColor="#722ed1"
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="活跃 API Key"
                        value={stats?.apiKeys.active || 0}
                        icon={<KeyOutlined />}
                        iconBgColor="#fa8c16"
                        suffix={`/ ${stats?.apiKeys.total || 0}`}
                    />
                </Col>
            </Row>

            {/* 图表区域 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                <Col xs={24} md={16}>
                    <Card title="API 调用趋势（近7天）" bordered={false}>
                        <Suspense fallback={<div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}>
                            <LineChart {...lineConfig} />
                        </Suspense>
                    </Card>
                </Col>
                <Col xs={24} md={8}>
                    <Card title="邮箱状态分布" bordered={false}>
                        {pieData.length > 0 ? (
                            <Suspense fallback={<div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}>
                                <PieChart {...pieConfig} />
                            </Suspense>
                        ) : (
                            <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Text type="secondary">暂无数据</Text>
                            </div>
                        )}
                    </Card>
                </Col>
            </Row>

            {/* 列表区域 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                <Col xs={24} md={12}>
                    <Card
                        title="最近添加的邮箱"
                        bordered={false}
                        bodyStyle={{ padding: 0 }}
                        extra={<a href="/emails">查看全部</a>}
                    >
                        <Table
                            dataSource={recentEmails}
                            columns={emailColumns}
                            rowKey="id"
                            pagination={false}
                            size="small"
                            locale={{ emptyText: '暂无数据' }}
                        />
                    </Card>
                </Col>
                <Col xs={24} md={12}>
                    <Card
                        title="API Key 使用排行"
                        bordered={false}
                        bodyStyle={{ padding: 0 }}
                        extra={<a href="/api-keys">查看全部</a>}
                    >
                        <Table
                            dataSource={recentApiKeys}
                            columns={apiKeyColumns}
                            rowKey="id"
                            pagination={false}
                            size="small"
                            locale={{ emptyText: '暂无数据' }}
                        />
                    </Card>
                </Col>
            </Row>
        </div>
    );
};

export default DashboardPage;
