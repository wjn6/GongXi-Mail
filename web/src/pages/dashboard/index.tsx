import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Row, Col, Card, Table, Tag, Typography, Spin } from 'antd';
import { Link } from 'react-router-dom';
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
    const [coreLoading, setCoreLoading] = useState(true);
    const [trendLoading, setTrendLoading] = useState(true);
    const [chartsReady, setChartsReady] = useState(false);
    const [chartsInView, setChartsInView] = useState(false);
    const [trendRequested, setTrendRequested] = useState(false);
    const [stats, setStats] = useState<Stats | null>(null);
    const [recentEmails, setRecentEmails] = useState<DashboardEmailItem[]>([]);
    const [recentApiKeys, setRecentApiKeys] = useState<DashboardApiKeyItem[]>([]);
    const [apiTrend, setApiTrend] = useState<ApiTrendItem[]>([]);
    const chartsSectionRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let disposed = false;
        let idleId: number | null = null;
        let timerId: number | null = null;
        const idleWindow = window as Window & {
            requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
            cancelIdleCallback?: (handle: number) => void;
        };

        const loadCore = async () => {
            try {
                const [statsRes, emailsRes, apiKeysRes] = await Promise.all([
                    dashboardApi.getStats<Stats>(),
                    emailApi.getList<DashboardEmailItem>({ page: 1, pageSize: 5 }),
                    apiKeyApi.getList<DashboardApiKeyItem>({ page: 1, pageSize: 5 }),
                ]);

                if (disposed) return;

                if (statsRes.code === 200) {
                    setStats(statsRes.data);
                }
                if (emailsRes.code === 200) {
                    setRecentEmails(emailsRes.data.list);
                }
                if (apiKeysRes.code === 200) {
                    setRecentApiKeys(apiKeysRes.data.list);
                }
            } catch (err) {
                console.error('Failed to fetch core dashboard data:', err);
            } finally {
                if (!disposed) {
                    setCoreLoading(false);
                }
            }
        };

        void loadCore();

        if (typeof idleWindow.requestIdleCallback === 'function') {
            idleId = idleWindow.requestIdleCallback(() => {
                if (disposed) return;
                setChartsReady(true);
            }, { timeout: 1200 });
        } else {
            timerId = window.setTimeout(() => {
                if (disposed) return;
                setChartsReady(true);
            }, 350);
        }

        return () => {
            disposed = true;
            if (idleId !== null && typeof idleWindow.cancelIdleCallback === 'function') {
                idleWindow.cancelIdleCallback(idleId);
            }
            if (timerId !== null) {
                window.clearTimeout(timerId);
            }
        };
    }, []);

    useEffect(() => {
        const target = chartsSectionRef.current;
        if (!target) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setChartsInView(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '120px 0px' }
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!chartsReady || !chartsInView || trendRequested) {
            return;
        }
        setTrendRequested(true);
        let cancelled = false;

        const loadTrend = async () => {
            try {
                const trendRes = await dashboardApi.getApiTrend<ApiTrendItem>(7);
                if (!cancelled && trendRes.code === 200) {
                    setApiTrend(trendRes.data);
                }
            } catch (err) {
                console.error('Failed to fetch dashboard trend:', err);
            } finally {
                if (!cancelled) {
                    setTrendLoading(false);
                }
            }
        };

        void loadTrend();
        return () => {
            cancelled = true;
        };
    }, [chartsInView, chartsReady, trendRequested]);

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

    const statsData: Stats = stats || {
        apiKeys: { total: 0, active: 0, totalUsage: 0, todayActive: 0 },
        emails: { total: 0, active: 0, error: 0 },
    };

    return (
        <div>
            <PageHeader title="数据概览" subtitle="实时监控系统运行状态" />

            {/* 统计卡片 */}
            <Row gutter={[16, 16]}>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="邮箱总数"
                        value={statsData.emails.total}
                        icon={<MailOutlined />}
                        iconBgColor="#1890ff"
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="正常邮箱"
                        value={statsData.emails.active}
                        icon={<CheckCircleOutlined />}
                        iconBgColor="#52c41a"
                        suffix={`/ ${statsData.emails.total}`}
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="API 调用总数"
                        value={statsData.apiKeys.totalUsage}
                        icon={<ApiOutlined />}
                        iconBgColor="#722ed1"
                    />
                </Col>
                <Col xs={12} sm={12} md={6}>
                    <StatCard
                        title="活跃 API Key"
                        value={statsData.apiKeys.active}
                        icon={<KeyOutlined />}
                        iconBgColor="#fa8c16"
                        suffix={`/ ${statsData.apiKeys.total}`}
                    />
                </Col>
            </Row>

            {/* 图表区域 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }} ref={chartsSectionRef}>
                <Col xs={24} md={16}>
                    <Card title="API 调用趋势（近7天）" bordered={false}>
                        {!chartsReady || !chartsInView || trendLoading ? (
                            <div style={{ textAlign: 'center', padding: 40, minHeight: 280 }}><Spin /></div>
                        ) : (
                            <Suspense fallback={<div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}>
                                <LineChart {...lineConfig} />
                            </Suspense>
                        )}
                    </Card>
                </Col>
                <Col xs={24} md={8}>
                    <Card title="邮箱状态分布" bordered={false}>
                        {coreLoading || !chartsReady || !chartsInView ? (
                            <div style={{ textAlign: 'center', padding: 40, minHeight: 280 }}><Spin /></div>
                        ) : pieData.length > 0 ? (
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
                        extra={<Link to="/emails">查看全部</Link>}
                    >
                        <Table
                            dataSource={recentEmails}
                            columns={emailColumns}
                            rowKey="id"
                            loading={coreLoading}
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
                        extra={<Link to="/api-keys">查看全部</Link>}
                    >
                        <Table
                            dataSource={recentApiKeys}
                            columns={apiKeyColumns}
                            rowKey="id"
                            loading={coreLoading}
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
