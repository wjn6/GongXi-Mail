import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Table,
    Button,
    Space,
    Modal,
    Form,
    Input,
    Select,
    message,
    Popconfirm,
    Tag,
    Typography,
    Card,
    Tooltip,
    InputNumber,
    Progress,
    Statistic,
    Row,
    Col,
    Badge,
    Divider,
    DatePicker,
    Checkbox,
    Spin,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    PlusOutlined,
    EditOutlined,
    DeleteOutlined,
    ReloadOutlined,
    DatabaseOutlined,
    ThunderboltOutlined,
    SearchOutlined,
} from '@ant-design/icons';
import { apiKeyApi, groupApi, emailApi } from '../../api';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import { LOG_ACTION_OPTIONS } from '../../constants/logActions';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;

interface EmailGroup {
    id: number;
    name: string;
    description: string | null;
    emailCount: number;
}

interface ApiKey {
    id: number;
    name: string;
    keyPrefix: string;
    rateLimit: number;
    status: 'ACTIVE' | 'DISABLED';
    expiresAt: string | null;
    lastUsedAt: string | null;
    usageCount: number;
    createdAt: string;
    createdByName: string;
}

interface ApiKeyDetail extends ApiKey {
    permissions?: Record<string, boolean> | null;
    allowedGroupIds?: number[] | null;
    allowedEmailIds?: number[] | null;
}

interface EmailOptionItem {
    id: number;
    email: string;
    groupId: number | null;
    group: { id: number; name: string } | null;
}

interface PoolStats {
    total: number;
    used: number;
    remaining: number;
}

interface PoolEmailItem {
    id: number;
    email: string;
    used: boolean;
    groupId: number | null;
    groupName: string | null;
}

interface ApiKeyListResult {
    list: ApiKey[];
    total: number;
}

const ApiKeysPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<ApiKey[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [modalVisible, setModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [newKeyModalVisible, setNewKeyModalVisible] = useState(false);
    const [newKey, setNewKey] = useState('');
    const [poolModalVisible, setPoolModalVisible] = useState(false);
    const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
    const [poolLoading, setPoolLoading] = useState(false);
    const [currentApiKey, setCurrentApiKey] = useState<ApiKey | null>(null);
    const [emailList, setEmailList] = useState<PoolEmailItem[]>([]);
    const [selectedEmails, setSelectedEmails] = useState<number[]>([]);
    const [emailKeyword, setEmailKeyword] = useState('');
    const [emailModalVisible, setEmailModalVisible] = useState(false);
    const [emailLoading, setEmailLoading] = useState(false);
    const [savingEmails, setSavingEmails] = useState(false);
    const [apiKeyDetailLoading, setApiKeyDetailLoading] = useState(false);
    const [groups, setGroups] = useState<EmailGroup[]>([]);
    const [allEmailOptions, setAllEmailOptions] = useState<EmailOptionItem[]>([]);
    const [poolGroupName, setPoolGroupName] = useState<string | undefined>(undefined);
    const [emailGroupId, setEmailGroupId] = useState<number | undefined>(undefined);
    const latestListRequestIdRef = useRef(0);
    const [form] = Form.useForm();
    const selectedAllowedGroupIds = Form.useWatch('allowedGroupIds', form) as number[] | undefined;

    const permissionActionOptions = useMemo(
        () =>
            LOG_ACTION_OPTIONS.map((item) => ({
                value: item.value,
                label: item.label,
            })),
        []
    );
    const allPermissionActions = useMemo(
        () => permissionActionOptions.map((item) => item.value),
        [permissionActionOptions]
    );

    const extractUsedEmailIds = useCallback(
        (emails: PoolEmailItem[]) => emails.filter((item) => item.used).map((item) => item.id),
        []
    );

    const fetchGroups = useCallback(async () => {
        const result = await requestData<EmailGroup[]>(
            () => groupApi.getList(),
            '获取分组失败',
            { silent: true }
        );
        if (result) {
            setGroups(result);
        }
    }, []);

    const fetchAllEmailOptions = useCallback(async () => {
        const result = await requestData<{ list: EmailOptionItem[]; total: number }>(
            () => emailApi.getList<EmailOptionItem>({ page: 1, pageSize: 1000, status: 'ACTIVE' }),
            '获取邮箱选项失败',
            { silent: true }
        );
        if (result) {
            setAllEmailOptions(result.list);
        }
    }, []);

    const fetchData = useCallback(async () => {
        const currentRequestId = ++latestListRequestIdRef.current;
        setLoading(true);
        const result = await requestData<ApiKeyListResult>(
            () => apiKeyApi.getList({ page, pageSize }),
            '获取数据失败'
        );
        if (currentRequestId !== latestListRequestIdRef.current) {
            return;
        }
        if (result) {
            setData(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [page, pageSize]);

    useEffect(() => {
        fetchGroups();
    }, [fetchGroups]);

    useEffect(() => {
        fetchAllEmailOptions();
    }, [fetchAllEmailOptions]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleCreate = () => {
        setEditingId(null);
        setApiKeyDetailLoading(false);
        form.resetFields();
        form.setFieldsValue({
            permissions: allPermissionActions,
            allowedGroupIds: [],
            allowedEmailIds: [],
        });
        setModalVisible(true);
    };

    const handleEdit = useCallback(async (record: ApiKey) => {
        setEditingId(record.id);
        setApiKeyDetailLoading(true);
        form.setFieldsValue({
            name: record.name,
            rateLimit: record.rateLimit,
            status: record.status,
            expiresAt: record.expiresAt ? dayjs(record.expiresAt) : null,
            permissions: allPermissionActions,
        });
        setModalVisible(true);
        try {
            const detail = await requestData<ApiKeyDetail>(
                () => apiKeyApi.getById(record.id),
                '获取 API Key 详情失败'
            );
            if (detail) {
                const selectedPermissions = detail.permissions
                    ? Object.entries(detail.permissions)
                        .filter(([, allowed]) => allowed)
                        .map(([permission]) => permission.replace(/-/g, '_'))
                    : allPermissionActions;
                form.setFieldsValue({
                    name: detail.name,
                    rateLimit: detail.rateLimit,
                    status: detail.status,
                    expiresAt: detail.expiresAt ? dayjs(detail.expiresAt) : null,
                    permissions: selectedPermissions.length > 0 ? selectedPermissions : allPermissionActions,
                    allowedGroupIds: detail.allowedGroupIds || [],
                    allowedEmailIds: detail.allowedEmailIds || [],
                });
            }
        } finally {
            setApiKeyDetailLoading(false);
        }
    }, [allPermissionActions, form]);

    const handleDelete = useCallback(async (id: number) => {
        try {
            const res = await apiKeyApi.delete(id);
            if (res.code === 200) {
                message.success('删除成功');
                fetchData();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData]);

    const handleSubmit = async () => {
        try {
            const values = await form.validateFields();
            const selectedPermissions = Array.isArray(values.permissions)
                ? values.permissions as string[]
                : [];
            const allowedGroupIds = Array.isArray(values.allowedGroupIds)
                ? Array.from(new Set(values.allowedGroupIds.map((item: unknown) => Number(item)).filter((item: number) => Number.isInteger(item) && item > 0)))
                : [];
            const allowedEmailIds = Array.isArray(values.allowedEmailIds)
                ? Array.from(new Set(values.allowedEmailIds.map((item: unknown) => Number(item)).filter((item: number) => Number.isInteger(item) && item > 0)))
                : [];
            const permissions = selectedPermissions.reduce<Record<string, boolean>>((acc, action) => {
                acc[action] = true;
                return acc;
            }, {});

            if (editingId) {
                const submitData = {
                    ...values,
                    expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                    permissions,
                    allowedGroupIds,
                    allowedEmailIds,
                };
                const res = await apiKeyApi.update(editingId, submitData);
                if (res.code === 200) {
                    message.success('更新成功');
                    setModalVisible(false);
                    fetchData();
                } else {
                    message.error(res.message);
                }
            } else {
                const submitData = {
                    ...values,
                    expiresAt: values.expiresAt ? values.expiresAt.toISOString() : undefined,
                    permissions,
                    allowedGroupIds,
                    allowedEmailIds,
                };
                const res = await apiKeyApi.create(submitData);
                if (res.code === 200) {
                    setModalVisible(false);
                    setNewKey(res.data.key);
                    setNewKeyModalVisible(true);
                    fetchData();
                } else {
                    message.error(res.message);
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '保存失败'));
        }
    };

    const handleViewPool = useCallback(async (record: ApiKey) => {
        setCurrentApiKey(record);
        setPoolGroupName(undefined);
        setPoolModalVisible(true);
        setPoolLoading(true);
        try {
            const res = await apiKeyApi.getUsage(record.id);
            if (res.code === 200) {
                setPoolStats(res.data);
            }
        } catch {
            message.error('获取邮箱池数据失败');
        } finally {
            setPoolLoading(false);
        }
    }, []);

    const handlePoolGroupChange = async (groupName: string | undefined) => {
        setPoolGroupName(groupName);
        if (!currentApiKey) return;
        setPoolLoading(true);
        try {
            const res = await apiKeyApi.getUsage(currentApiKey.id, groupName);
            if (res.code === 200) {
                setPoolStats(res.data);
            }
        } catch {
            message.error('获取邮箱池数据失败');
        } finally {
            setPoolLoading(false);
        }
    };

    const handleResetPool = async () => {
        if (!currentApiKey) return;
        try {
            const res = await apiKeyApi.resetPool(currentApiKey.id, poolGroupName);
            if (res.code === 200) {
                message.success('邮箱池已重置');
                // 刷新统计
                const statsRes = await apiKeyApi.getUsage(currentApiKey.id, poolGroupName);
                if (statsRes.code === 200) {
                    setPoolStats(statsRes.data);
                }
            } else {
                message.error(res.message || '重置失败');
            }
        } catch {
            message.error('重置失败');
        }
    };

    // 打开邮箱管理弹窗
    const handleManageEmails = useCallback(async (record: ApiKey) => {
        setCurrentApiKey(record);
        setEmailGroupId(undefined);
        setEmailModalVisible(true);
        setEmailLoading(true);
        try {
            const res = await apiKeyApi.getPoolEmails<PoolEmailItem>(record.id);
            if (res.code === 200) {
                const emails = res.data;
                setEmailList(emails);
                setSelectedEmails(extractUsedEmailIds(emails));
                setEmailKeyword('');
            }
        } catch {
            message.error('获取邮箱列表失败');
        } finally {
            setEmailLoading(false);
        }
    }, [extractUsedEmailIds]);

    const handleEmailGroupChange = useCallback(async (groupId: number | undefined) => {
        setEmailGroupId(groupId);
        if (!currentApiKey) return;
        setEmailLoading(true);
        try {
            const res = await apiKeyApi.getPoolEmails<PoolEmailItem>(currentApiKey.id, groupId);
            if (res.code === 200) {
                const emails = res.data;
                setEmailList(emails);
                setSelectedEmails(extractUsedEmailIds(emails));
                setEmailKeyword('');
            }
        } catch {
            message.error('获取邮箱列表失败');
        } finally {
            setEmailLoading(false);
        }
    }, [currentApiKey, extractUsedEmailIds]);

    // 保存邮箱选择
    const handleSaveEmails = async () => {
        if (!currentApiKey) return;
        setSavingEmails(true);
        try {
            const res = await apiKeyApi.updatePoolEmails(currentApiKey.id, selectedEmails, emailGroupId);
            if (res.code === 200) {
                message.success(`已保存，共 ${res.data.count} 个邮箱`);
                setEmailModalVisible(false);
                // 刷新统计
                const statsRes = await apiKeyApi.getUsage(currentApiKey.id);
                if (statsRes.code === 200) {
                    setPoolStats(statsRes.data);
                }
            } else {
                message.error(res.message || '保存失败');
            }
        } catch {
            message.error('保存失败');
        } finally {
            setSavingEmails(false);
        }
    };

    const columns: ColumnsType<ApiKey> = useMemo(() => [
        {
            title: '名称',
            dataIndex: 'name',
            key: 'name',
            render: (name, record) => (
                <Space>
                    <Text strong>{name}</Text>
                    {record.status === 'DISABLED' && <Badge status="error" />}
                </Space>
            ),
        },
        {
            title: 'Key 前缀',
            dataIndex: 'keyPrefix',
            key: 'keyPrefix',
            width: 120,
            render: (text) => <Text code>{text}...</Text>,
        },
        {
            title: '速率限制',
            dataIndex: 'rateLimit',
            key: 'rateLimit',
            width: 100,
            render: (val) => <Tag color="blue">{val}/分钟</Tag>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 80,
            render: (status) => (
                <Tag color={status === 'ACTIVE' ? 'green' : 'red'}>
                    {status === 'ACTIVE' ? '启用' : '禁用'}
                </Tag>
            ),
        },
        {
            title: '使用次数',
            dataIndex: 'usageCount',
            key: 'usageCount',
            width: 100,
            render: (val) => <Text type="secondary">{val?.toLocaleString() || 0}</Text>,
        },
        {
            title: '过期时间',
            dataIndex: 'expiresAt',
            key: 'expiresAt',
            width: 120,
            render: (val) => {
                if (!val) return <Text type="secondary">永不过期</Text>;
                const isExpired = dayjs(val).isBefore(dayjs());
                return (
                    <Text type={isExpired ? 'danger' : undefined}>
                        {dayjs(val).format('YYYY-MM-DD')}
                    </Text>
                );
            },
        },
        {
            title: '最后使用',
            dataIndex: 'lastUsedAt',
            key: 'lastUsedAt',
            width: 140,
            render: (val) => val ? dayjs(val).format('MM-DD HH:mm') : <Text type="secondary">从未使用</Text>,
        },
        {
            title: '操作',
            key: 'action',
            width: 180,
            render: (_, record) => (
                <Space size="small">
                    <Tooltip title="邮箱池">
                        <Button
                            type="text"
                            icon={<DatabaseOutlined />}
                            onClick={() => handleViewPool(record)}
                        />
                    </Tooltip>
                    <Tooltip title="管理邮箱">
                        <Button
                            type="text"
                            icon={<ThunderboltOutlined />}
                            onClick={() => handleManageEmails(record)}
                        />
                    </Tooltip>
                    <Tooltip title="编辑">
                        <Button
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => handleEdit(record)}
                        />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Popconfirm
                            title="确定要删除此 API Key 吗？"
                            onConfirm={() => handleDelete(record.id)}
                        >
                            <Button type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                    </Tooltip>
                </Space>
            ),
        },
    ], [handleDelete, handleEdit, handleManageEmails, handleViewPool]);

    const tablePagination = useMemo(
        () => ({
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (count: number) => `共 ${count} 条`,
            onChange: (currentPage: number, currentPageSize: number) => {
                setPage(currentPage);
                setPageSize(currentPageSize);
            },
        }),
        [page, pageSize, total]
    );

    const poolGroupOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.name,
                label: `${group.name} (${group.emailCount})`,
            })),
        [groups]
    );

    const emailGroupOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: group.name,
            })),
        [groups]
    );

    const scopedAllowedEmailOptions = useMemo(() => {
        const selectedGroupSet = new Set(
            Array.isArray(selectedAllowedGroupIds)
                ? selectedAllowedGroupIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
                : []
        );

        const candidates = selectedGroupSet.size > 0
            ? allEmailOptions.filter((item) => item.groupId !== null && selectedGroupSet.has(item.groupId))
            : allEmailOptions;

        return candidates.map((item) => ({
            value: item.id,
            label: item.group?.name ? `${item.email}（${item.group.name}）` : item.email,
        }));
    }, [allEmailOptions, selectedAllowedGroupIds]);

    useEffect(() => {
        const currentValue = form.getFieldValue('allowedEmailIds');
        const selected = Array.isArray(currentValue) ? currentValue : [];
        if (selected.length === 0) {
            return;
        }

        const allowedSet = new Set(scopedAllowedEmailOptions.map((item) => item.value));
        const nextSelected = selected.filter((item: number) => allowedSet.has(item));
        if (nextSelected.length !== selected.length) {
            form.setFieldValue('allowedEmailIds', nextSelected);
        }
    }, [form, scopedAllowedEmailOptions]);

    const filteredEmailList = useMemo(() => {
        const keyword = emailKeyword.trim().toLowerCase();
        if (!keyword) {
            return emailList;
        }

        return emailList.filter((item) => {
            const emailText = item.email.toLowerCase();
            const groupText = item.groupName?.toLowerCase() || '';
            return emailText.includes(keyword) || groupText.includes(keyword);
        });
    }, [emailKeyword, emailList]);

    const filteredEmailIdSet = useMemo(
        () => new Set(filteredEmailList.map((item) => item.id)),
        [filteredEmailList]
    );

    const selectedInFilteredCount = useMemo(
        () => selectedEmails.filter((id) => filteredEmailIdSet.has(id)).length,
        [filteredEmailIdSet, selectedEmails]
    );

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <Title level={4} style={{ margin: 0 }}>
                    API Key 管理
                </Title>
                <Space>
                    <Button icon={<ReloadOutlined />} onClick={fetchData}>
                        刷新
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                        创建 API Key
                    </Button>
                </Space>
            </div>

            <Table
                columns={columns}
                dataSource={data}
                rowKey="id"
                loading={loading}
                pagination={tablePagination}
                virtual
                scroll={{ y: 560, x: 1200 }}
            />

            {/* 创建/编辑弹窗 */}
            <Modal
                title={editingId ? '编辑 API Key' : '创建 API Key'}
                open={modalVisible}
                onOk={handleSubmit}
                onCancel={() => setModalVisible(false)}
                destroyOnClose
                width={500}
            >
                <Spin spinning={apiKeyDetailLoading}>
                <Form form={form} layout="vertical">
                    <Form.Item
                        name="name"
                        label="名称"
                        rules={[{ required: true, message: '请输入名称' }]}
                    >
                        <Input placeholder="例如：生产环境、测试环境" />
                    </Form.Item>
                    <Form.Item
                        name="rateLimit"
                        label="速率限制（每分钟请求数）"
                        initialValue={60}
                    >
                        <InputNumber min={1} max={10000} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                        name="expiresAt"
                        label="过期时间（可选）"
                    >
                        <DatePicker
                            style={{ width: '100%' }}
                            placeholder="不设置则永不过期"
                            disabledDate={(current) => current && current < dayjs().startOf('day')}
                        />
                    </Form.Item>
                    {editingId && (
                        <Form.Item
                            name="status"
                            label="状态"
                        >
                            <Select>
                                <Select.Option value="ACTIVE">启用</Select.Option>
                                <Select.Option value="DISABLED">禁用</Select.Option>
                            </Select>
                        </Form.Item>
                    )}
                    <Form.Item
                        name="permissions"
                        label="可调用接口权限"
                        rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个权限' }]}
                    >
                        <Checkbox.Group
                            options={permissionActionOptions}
                            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', rowGap: 8 }}
                        />
                    </Form.Item>
                    <Form.Item
                        name="allowedGroupIds"
                        label="可用分组（可选）"
                        tooltip="不选择表示不限制分组"
                    >
                        <Select
                            mode="multiple"
                            allowClear
                            placeholder="默认：全部分组"
                            options={emailGroupOptions}
                            optionFilterProp="label"
                            maxTagCount="responsive"
                        />
                    </Form.Item>
                    <Form.Item
                        name="allowedEmailIds"
                        label="可用邮箱（可选）"
                        tooltip="不选择表示使用分组范围内全部邮箱"
                    >
                        <Select
                            mode="multiple"
                            allowClear
                            showSearch
                            placeholder="默认：分组范围内全部邮箱"
                            options={scopedAllowedEmailOptions}
                            optionFilterProp="label"
                            maxTagCount="responsive"
                        />
                    </Form.Item>
                    <Text type="secondary">
                        当前可选邮箱：{scopedAllowedEmailOptions.length}
                    </Text>
                </Form>
                </Spin>
            </Modal>

            {/* 新建 Key 显示弹窗 */}
            <Modal
                title="API Key 已创建"
                open={newKeyModalVisible}
                onOk={() => setNewKeyModalVisible(false)}
                onCancel={() => setNewKeyModalVisible(false)}
                destroyOnClose
                footer={[
                    <Button key="close" onClick={() => setNewKeyModalVisible(false)}>
                        关闭
                    </Button>,
                ]}
            >
                <Card>
                    <Text type="warning" style={{ display: 'block', marginBottom: 16 }}>
                        ⚠️ 请立即复制并妥善保存此 API Key，它不会再次显示！
                    </Text>
                    <Paragraph
                        copyable={{
                            text: newKey,
                            onCopy: () => message.success('已复制'),
                        }}
                        code
                        style={{
                            wordBreak: 'break-all',
                            background: '#f5f5f5',
                            padding: 12,
                            borderRadius: 4,
                        }}
                    >
                        {newKey}
                    </Paragraph>
                </Card>
            </Modal>

            {/* 邮箱池弹窗 */}
            {poolModalVisible && (
                <Modal
                    title={
                        <Space>
                            <DatabaseOutlined />
                            <span>邮箱池管理 - {currentApiKey?.name}</span>
                        </Space>
                    }
                    open={poolModalVisible}
                    onCancel={() => setPoolModalVisible(false)}
                    footer={null}
                    destroyOnClose
                    width={500}
                >
                    {poolLoading ? (
                        <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
                    ) : poolStats ? (
                        <div>
                            <div style={{ marginBottom: 16 }}>
                                <Text type="secondary" style={{ marginRight: 8 }}>按分组筛选：</Text>
                                <Select
                                    allowClear
                                    placeholder="全部分组"
                                    style={{ width: 200 }}
                                    value={poolGroupName}
                                    options={poolGroupOptions}
                                    onChange={(val: string | undefined) => handlePoolGroupChange(val)}
                                />
                            </div>
                            <Row gutter={16} style={{ marginBottom: 24 }}>
                                <Col span={8}>
                                    <div className="stat-blue">
                                        <Statistic
                                            title="总邮箱数"
                                            value={poolStats.total}
                                        />
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div className="stat-orange">
                                        <Statistic
                                            title="已使用"
                                            value={poolStats.used}
                                        />
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div className={poolStats.remaining > 0 ? 'stat-green' : 'stat-red'}>
                                        <Statistic
                                            title="剩余可用"
                                            value={poolStats.remaining}
                                        />
                                    </div>
                                </Col>
                            </Row>
                            <style>{`
                                .stat-blue .ant-statistic-content-value { color: #1890ff; }
                                .stat-orange .ant-statistic-content-value { color: #faad14; }
                                .stat-green .ant-statistic-content-value { color: #52c41a; }
                                .stat-red .ant-statistic-content-value { color: #ff4d4f; }
                            `}</style>

                            <div style={{ marginBottom: 24 }}>
                                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                                    使用进度
                                </Text>
                                <Progress
                                    percent={poolStats.total > 0 ? Math.round((poolStats.used / poolStats.total) * 100) : 0}
                                    status={poolStats.remaining === 0 ? 'exception' : 'active'}
                                    strokeColor={{
                                        '0%': '#108ee9',
                                        '100%': '#87d068',
                                    }}
                                />
                            </div>

                            <Divider />

                            <div style={{ textAlign: 'center' }}>
                                <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                                    重置后，此 API Key 可重新使用所有邮箱
                                </Text>
                                <Popconfirm
                                    title="确定要重置邮箱池吗？"
                                    description={poolGroupName ? `仅重置分组 "${poolGroupName}" 的使用记录` : '重置后该 API Key 可重新使用所有邮箱'}
                                    onConfirm={handleResetPool}
                                >
                                    <Button
                                        type="primary"
                                        danger
                                        icon={<ThunderboltOutlined />}
                                    >
                                        重置邮箱池
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                    ) : (
                        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                            暂无数据
                        </div>
                    )}
                </Modal>
            )}

            {/* 邮箱管理弹窗 */}
            {emailModalVisible && (
                <Modal
                    title={
                        <Space>
                            <ThunderboltOutlined />
                            <span>管理邮箱 - {currentApiKey?.name}</span>
                        </Space>
                    }
                    open={emailModalVisible}
                    onCancel={() => setEmailModalVisible(false)}
                    onOk={handleSaveEmails}
                    okText="保存"
                    cancelText="取消"
                    confirmLoading={savingEmails}
                    destroyOnClose
                    width={600}
                >
                    {emailLoading ? (
                        <div style={{ textAlign: 'center', padding: 40 }}>
                            <Spin />
                        </div>
                    ) : (
                        <div>
                            <div style={{ marginBottom: 16 }}>
                                <Space>
                                    <Text type="secondary">按分组筛选：</Text>
                                    <Select
                                        allowClear
                                        placeholder="全部分组"
                                        style={{ width: 180 }}
                                        value={emailGroupId}
                                        options={emailGroupOptions}
                                        onChange={(val: number | undefined) => handleEmailGroupChange(val)}
                                    />
                                </Space>
                            </div>
                            <div style={{ marginBottom: 16 }}>
                                <Input
                                    allowClear
                                    value={emailKeyword}
                                    onChange={(event) => setEmailKeyword(event.target.value)}
                                    prefix={<SearchOutlined />}
                                    placeholder="搜索邮箱或分组"
                                />
                            </div>
                            <div style={{ marginBottom: 16 }}>
                                <Text type="secondary">
                                    勾选的邮箱表示该 API Key 已使用过（不会再自动分配）
                                </Text>
                            </div>
                            <div style={{ marginBottom: 16 }}>
                                <Space>
                                    <Button
                                        size="small"
                                        onClick={() => {
                                            setSelectedEmails((prev) => Array.from(new Set([
                                                ...prev,
                                                ...filteredEmailList.map((item) => item.id),
                                            ])));
                                        }}
                                    >
                                        全选当前筛选
                                    </Button>
                                    <Button
                                        size="small"
                                        onClick={() => {
                                            setSelectedEmails((prev) => prev.filter((id) => !filteredEmailIdSet.has(id)));
                                        }}
                                    >
                                        清空当前筛选
                                    </Button>
                                    <Text type="secondary">
                                        已选择 {selectedEmails.length} / {emailList.length}
                                        {`（当前筛选 ${selectedInFilteredCount} / ${filteredEmailList.length}）`}
                                    </Text>
                                </Space>
                            </div>
                            <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 4, padding: 12 }}>
                                <Checkbox.Group
                                    value={selectedEmails}
                                    onChange={(vals) => setSelectedEmails(vals as number[])}
                                    style={{ width: '100%' }}
                                >
                                    <Row>
                                        {filteredEmailList.map((email: { id: number; email: string; used: boolean; groupId: number | null; groupName: string | null }) => (
                                            <Col span={12} key={email.id} style={{ marginBottom: 8 }}>
                                                <Checkbox value={email.id}>
                                                    {email.email}
                                                    {email.groupName && (
                                                        <Tag color="blue" style={{ marginLeft: 4, fontSize: 11 }}>{email.groupName}</Tag>
                                                    )}
                                                </Checkbox>
                                            </Col>
                                        ))}
                                    </Row>
                                </Checkbox.Group>
                            </div>
                        </div>
                    )}
                </Modal>
            )}
        </div>
    );
};

export default ApiKeysPage;
