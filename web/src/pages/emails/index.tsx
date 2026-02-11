import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
    Upload,
    Tooltip,
    List,
    Tabs,
    Spin,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    PlusOutlined,
    EditOutlined,
    DeleteOutlined,
    UploadOutlined,
    DownloadOutlined,
    InboxOutlined,
    SearchOutlined,
    MailOutlined,
    GroupOutlined,
} from '@ant-design/icons';
import { emailApi, groupApi } from '../../api';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;

interface EmailGroup {
    id: number;
    name: string;
    description: string | null;
    emailCount: number;
    createdAt: string;
    updatedAt: string;
}

interface EmailAccount {
    id: number;
    email: string;
    clientId: string;
    status: 'ACTIVE' | 'ERROR' | 'DISABLED';
    groupId: number | null;
    group: { id: number; name: string } | null;
    lastCheckAt: string | null;
    errorMessage: string | null;
    createdAt: string;
}

interface EmailListResult {
    list: EmailAccount[];
    total: number;
}

interface MailItem {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface EmailDetailsResult extends EmailAccount {
    refreshToken: string;
}

const EmailsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<EmailAccount[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    const [modalVisible, setModalVisible] = useState(false);
    const [importModalVisible, setImportModalVisible] = useState(false);
    const [mailModalVisible, setMailModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [keyword, setKeyword] = useState('');
    const [debouncedKeyword, setDebouncedKeyword] = useState('');
    const [filterGroupId, setFilterGroupId] = useState<number | undefined>(undefined);
    const [importContent, setImportContent] = useState('');
    const [separator, setSeparator] = useState('----');
    const [importGroupId, setImportGroupId] = useState<number | undefined>(undefined);
    const [mailList, setMailList] = useState<MailItem[]>([]);
    const [mailLoading, setMailLoading] = useState(false);
    const [currentEmail, setCurrentEmail] = useState<string>('');
    const [currentEmailId, setCurrentEmailId] = useState<number | null>(null);
    const [currentMailbox, setCurrentMailbox] = useState<string>('INBOX');
    const [emailDetailVisible, setEmailDetailVisible] = useState(false);
    const [emailDetailContent, setEmailDetailContent] = useState<string>('');
    const [emailDetailSubject, setEmailDetailSubject] = useState<string>('');
    const [emailEditLoading, setEmailEditLoading] = useState(false);
    const [renderEmailDetailFrame, setRenderEmailDetailFrame] = useState(false);
    const [form] = Form.useForm();

    // Group-related state
    const [groups, setGroups] = useState<EmailGroup[]>([]);
    const [groupModalVisible, setGroupModalVisible] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
    const [groupForm] = Form.useForm();
    const [assignGroupModalVisible, setAssignGroupModalVisible] = useState(false);
    const [assignTargetGroupId, setAssignTargetGroupId] = useState<number | undefined>(undefined);

    const toOptionalNumber = (value: unknown): number | undefined => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

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

    const fetchData = useCallback(async () => {
        setLoading(true);
        const params: { page: number; pageSize: number; keyword: string; groupId?: number } = { page, pageSize, keyword: debouncedKeyword };
        if (filterGroupId !== undefined) params.groupId = filterGroupId;

        const result = await requestData<EmailListResult>(
            () => emailApi.getList(params),
            '获取数据失败'
        );
        if (result) {
            setData(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [debouncedKeyword, filterGroupId, page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchGroups();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchGroups]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedKeyword(keyword.trim());
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchData();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchData]);

    const handleCreate = () => {
        setEditingId(null);
        setEmailEditLoading(false);
        form.resetFields();
        setModalVisible(true);
    };

    const handleEdit = useCallback(async (record: EmailAccount) => {
        setEditingId(record.id);
        setEmailEditLoading(true);
        form.resetFields();
        setModalVisible(true);
        try {
            const res = await emailApi.getById<EmailDetailsResult>(record.id, true);
            if (res.code === 200) {
                const details = res.data;
                form.setFieldsValue({
                    email: details.email,
                    clientId: details.clientId,
                    refreshToken: details.refreshToken,
                    status: details.status,
                    groupId: details.groupId,
                });
            }
        } catch {
            message.error('获取详情失败');
        } finally {
            setEmailEditLoading(false);
        }
    }, [form]);

    const handleDelete = useCallback(async (id: number) => {
        try {
            const res = await emailApi.delete(id);
            if (res.code === 200) {
                message.success('删除成功');
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleBatchDelete = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请选择要删除的邮箱');
            return;
        }

        try {
            const res = await emailApi.batchDelete(selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`成功删除 ${res.data.deleted} 个邮箱`);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    };

    const handleSubmit = async () => {
        try {
            const values = await form.validateFields();
            const normalizedGroupId =
                values.groupId === null ? null : toOptionalNumber(values.groupId);

            if (editingId) {
                const submitData = {
                    ...values,
                    groupId: normalizedGroupId ?? null,
                };
                const res = await emailApi.update(editingId, submitData);
                if (res.code === 200) {
                    message.success('更新成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            } else {
                const submitData = {
                    ...values,
                    groupId: toOptionalNumber(values.groupId),
                };
                const res = await emailApi.create(submitData);
                if (res.code === 200) {
                    message.success('创建成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '保存失败'));
        }
    };

    const handleImport = async () => {
        if (!importContent.trim()) {
            message.warning('请输入或粘贴邮箱数据');
            return;
        }

        try {
            const res = await emailApi.import(
                importContent,
                separator,
                toOptionalNumber(importGroupId)
            );
            if (res.code === 200) {
                message.success(res.message);
                setImportModalVisible(false);
                setImportContent('');
                setImportGroupId(undefined);
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导入失败'));
        }
    };

    const handleExport = async () => {
        try {
            const ids = selectedRowKeys.length > 0 ? selectedRowKeys as number[] : undefined;
            const groupId = ids ? undefined : toOptionalNumber(filterGroupId);
            const res = await emailApi.export(ids, separator, groupId);
            if (res.code !== 200) {
                message.error(res.message || '导出失败');
                return;
            }
            const content = res.data?.content || '';

            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'email_accounts.txt';
            a.click();
            URL.revokeObjectURL(url);

            message.success('导出成功');
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导出失败'));
        }
    };

    const loadMails = useCallback(async (emailId: number, mailbox: string, showSuccessToast: boolean = false) => {
        setMailLoading(true);
        const result = await requestData<{ messages: MailItem[] }>(
            () => emailApi.viewMails(emailId, mailbox),
            '获取邮件失败'
        );
        if (result) {
            setMailList(result.messages || []);
            if (showSuccessToast) {
                message.success('刷新成功');
            }
        }
        setMailLoading(false);
    }, []);

    const handleViewMails = useCallback(async (record: EmailAccount, mailbox: string) => {
        setCurrentEmail(record.email);
        setCurrentEmailId(record.id);
        setCurrentMailbox(mailbox);
        setMailModalVisible(true);
        await loadMails(record.id, mailbox);
    }, [loadMails]);

    const handleRefreshMails = async () => {
        if (!currentEmailId) return;
        await loadMails(currentEmailId, currentMailbox, true);
    };

    const handleClearMailbox = async () => {
        if (!currentEmailId) return;
        try {
            const res = await emailApi.clearMailbox(currentEmailId, currentMailbox);
            if (res.code === 200) {
                message.success(`已清空 ${res.data?.deletedCount || 0} 封邮件`);
                setMailList([]);
            } else {
                message.error(res.message || '清空失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '清空失败'));
        }
    };

    const handleViewEmailDetail = (record: MailItem) => {
        setEmailDetailSubject(record.subject || '无主题');
        setEmailDetailContent(record.html || record.text || '无内容');
        setEmailDetailVisible(true);
    };

    // ========================================
    // Group CRUD handlers
    // ========================================
    const handleCreateGroup = () => {
        setEditingGroupId(null);
        groupForm.resetFields();
        setGroupModalVisible(true);
    };

    const handleEditGroup = useCallback((group: EmailGroup) => {
        setEditingGroupId(group.id);
        groupForm.setFieldsValue({ name: group.name, description: group.description });
        setGroupModalVisible(true);
    }, [groupForm]);

    const handleDeleteGroup = useCallback(async (id: number) => {
        try {
            const res = await groupApi.delete(id);
            if (res.code === 200) {
                message.success('分组已删除');
                fetchGroups();
                fetchData();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleGroupSubmit = async () => {
        try {
            const values = await groupForm.validateFields();
            if (editingGroupId) {
                const res = await groupApi.update(editingGroupId, values);
                if (res.code === 200) {
                    message.success('分组已更新');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            } else {
                const res = await groupApi.create(values);
                if (res.code === 200) {
                    message.success('分组已创建');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分组保存失败'));
        }
    };

    const handleBatchAssignGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        if (!assignTargetGroupId) {
            message.warning('请选择目标分组');
            return;
        }
        try {
            const res = await groupApi.assignEmails(assignTargetGroupId, selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`已将 ${res.data.count} 个邮箱分配到分组`);
                setAssignGroupModalVisible(false);
                setAssignTargetGroupId(undefined);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分配失败'));
        }
    };

    const handleBatchRemoveGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        // Find the groupIds of selected emails, remove from each group
        const selectedEmails = data.filter((e: EmailAccount) => selectedRowKeys.includes(e.id));
        const groupIds = [...new Set(selectedEmails.map((e: EmailAccount) => e.groupId).filter(Boolean))] as number[];

        try {
            for (const gid of groupIds) {
                const emailIds = selectedEmails.filter((e: EmailAccount) => e.groupId === gid).map((e: EmailAccount) => e.id);
                await groupApi.removeEmails(gid, emailIds);
            }
            message.success('已将选中邮箱移出分组');
            setSelectedRowKeys([]);
            fetchData();
            fetchGroups();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '移出失败'));
        }
    };

    // ========================================
    // Email table columns
    // ========================================
    const columns: ColumnsType<EmailAccount> = useMemo(() => [
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            ellipsis: true,
        },
        {
            title: '客户端 ID',
            dataIndex: 'clientId',
            key: 'clientId',
            ellipsis: true,
        },
        {
            title: '分组',
            dataIndex: 'group',
            key: 'group',
            width: 120,
            render: (group: EmailAccount['group']) =>
                group ? <Tag color="blue">{group.name}</Tag> : <Tag>未分组</Tag>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100,
            render: (status: string) => {
                const colors: Record<string, string> = {
                    ACTIVE: 'green',
                    ERROR: 'red',
                    DISABLED: 'default',
                };
                const labels: Record<string, string> = {
                    ACTIVE: '正常',
                    ERROR: '异常',
                    DISABLED: '禁用',
                };
                return <Tag color={colors[status]}>{labels[status]}</Tag>;
            },
        },
        {
            title: '最后检查',
            dataIndex: 'lastCheckAt',
            key: 'lastCheckAt',
            width: 160,
            render: (val: string | null) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-'),
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 160,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 240,
            render: (_: unknown, record: EmailAccount) => (
                <Space>
                    <Tooltip title="收件箱">
                        <Button
                            type="text"
                            icon={<MailOutlined />}
                            onClick={() => handleViewMails(record, 'INBOX')}
                        />
                    </Tooltip>
                    <Tooltip title="垃圾箱">
                        <Button
                            type="text"
                            icon={<DeleteOutlined style={{ color: '#faad14' }} />}
                            onClick={() => handleViewMails(record, 'Junk')}
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
                            title="确定要删除此邮箱吗？"
                            onConfirm={() => handleDelete(record.id)}
                        >
                            <Button type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                    </Tooltip>
                </Space>
            ),
        },
    ], [handleDelete, handleEdit, handleViewMails]);

    // ========================================
    // Group table columns
    // ========================================
    const groupColumns: ColumnsType<EmailGroup> = useMemo(() => [
        {
            title: '分组名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => <Tag color="blue">{name}</Tag>,
        },
        {
            title: '描述',
            dataIndex: 'description',
            key: 'description',
            render: (val: string | null) => val || '-',
        },
        {
            title: '邮箱数',
            dataIndex: 'emailCount',
            key: 'emailCount',
            width: 100,
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 180,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 160,
            render: (_: unknown, record: EmailGroup) => (
                <Space>
                    <Button
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => handleEditGroup(record)}
                    />
                    <Popconfirm
                        title="删除分组后，组内邮箱将变为「未分组」。确认？"
                        onConfirm={() => handleDeleteGroup(record.id)}
                    >
                        <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ], [handleDeleteGroup, handleEditGroup]);

    // ========================================
    // Render
    // ========================================
    return (
        <div>
            <Title level={4} style={{ margin: '0 0 16px' }}>邮箱管理</Title>
            <Tabs
                defaultActiveKey="emails"
                items={[
                    {
                        key: 'emails',
                        label: '邮箱列表',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                                    <Space wrap>
                                        <Input
                                            placeholder="搜索邮箱"
                                            prefix={<SearchOutlined />}
                                            value={keyword}
                                            onChange={(e) => setKeyword(e.target.value)}
                                            style={{ width: 200 }}
                                            allowClear
                                        />
                                        <Select
                                            placeholder="按分组筛选"
                                            allowClear
                                            style={{ width: 160 }}
                                            value={filterGroupId}
                                            onChange={(val: number | string | undefined) => {
                                                setFilterGroupId(toOptionalNumber(val));
                                                setPage(1);
                                            }}
                                        >
                                            {groups.map((g: EmailGroup) => (
                                                <Select.Option key={g.id} value={g.id}>{g.name} ({g.emailCount})</Select.Option>
                                            ))}
                                        </Select>
                                    </Space>
                                    <Space wrap>
                                        <Button icon={<UploadOutlined />} onClick={() => setImportModalVisible(true)}>
                                            导入
                                        </Button>
                                        <Button icon={<DownloadOutlined />} onClick={handleExport}>
                                            导出
                                        </Button>
                                        {selectedRowKeys.length > 0 && (
                                            <>
                                                <Button icon={<GroupOutlined />} onClick={() => setAssignGroupModalVisible(true)}>
                                                    分配分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Button onClick={handleBatchRemoveGroup}>
                                                    移出分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Popconfirm
                                                    title={`确定要删除选中的 ${selectedRowKeys.length} 个邮箱吗？`}
                                                    onConfirm={handleBatchDelete}
                                                >
                                                    <Button danger>批量删除 ({selectedRowKeys.length})</Button>
                                                </Popconfirm>
                                            </>
                                        )}
                                        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                                            添加邮箱
                                        </Button>
                                    </Space>
                                </div>

                                <Table
                                    columns={columns}
                                    dataSource={data}
                                    rowKey="id"
                                    loading={loading}
                                    rowSelection={{
                                        selectedRowKeys,
                                        onChange: setSelectedRowKeys,
                                    }}
                                    pagination={{
                                        current: page,
                                        pageSize,
                                        total,
                                        showSizeChanger: true,
                                        showTotal: (total: number) => `共 ${total} 条`,
                                        onChange: (p: number, ps: number) => {
                                            setPage(p);
                                            setPageSize(ps);
                                        },
                                    }}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'groups',
                        label: '邮箱分组',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateGroup}>
                                        创建分组
                                    </Button>
                                </div>
                                <Table
                                    columns={groupColumns}
                                    dataSource={groups}
                                    rowKey="id"
                                    pagination={false}
                                />
                            </>
                        ),
                    },
                ]}
            />

            {/* 添加/编辑邮箱 Modal */}
            <Modal
                title={editingId ? '编辑邮箱' : '添加邮箱'}
                open={modalVisible}
                onOk={handleSubmit}
                onCancel={() => setModalVisible(false)}
                destroyOnClose
                width={600}
            >
                <Spin spinning={emailEditLoading}>
                    <Form form={form} layout="vertical">
                    <Form.Item name="email" label="邮箱地址" rules={[{ required: true, message: '请输入邮箱地址' }, { type: 'email', message: '请输入有效的邮箱地址' }]}>
                        <Input placeholder="example@outlook.com" />
                    </Form.Item>
                    <Form.Item name="password" label="密码">
                        <Input.Password placeholder="可选" />
                    </Form.Item>

                    <Form.Item
                        name="clientId"
                        label="客户端 ID"
                        rules={[{ required: true, message: '请输入客户端 ID' }]}
                    >
                        <Input placeholder="Azure AD 应用程序 ID" />
                    </Form.Item>
                    <Form.Item
                        name="refreshToken"
                        label="刷新令牌"
                        rules={[{ required: !editingId, message: '请输入刷新令牌' }]}
                    >
                        <TextArea rows={4} placeholder="OAuth2 Refresh Token" />
                    </Form.Item>
                    <Form.Item name="groupId" label="所属分组">
                        <Select placeholder="可选：选择分组" allowClear>
                            {groups.map((group: EmailGroup) => (
                                <Select.Option key={group.id} value={group.id}>
                                    {group.name}
                                </Select.Option>
                            ))}
                        </Select>
                    </Form.Item>
                    <Form.Item name="status" label="状态" initialValue="ACTIVE">
                        <Select>
                            <Select.Option value="ACTIVE">正常</Select.Option>
                            <Select.Option value="DISABLED">禁用</Select.Option>
                        </Select>
                    </Form.Item>
                    </Form>
                </Spin>
            </Modal>

            {/* 批量导入 Modal */}
            <Modal
                title="批量导入邮箱"
                open={importModalVisible}
                onOk={handleImport}
                onCancel={() => setImportModalVisible(false)}
                destroyOnClose
                width={700}
            >
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <div>
                        <Text type="secondary">
                            上传文件或粘贴内容。支持多种格式，将尝试自动解析。
                            <br />
                            推荐格式：邮箱{separator}密码{separator}客户端ID{separator}刷新令牌
                        </Text>
                    </div>
                    <Input
                        addonBefore="分隔符"
                        value={separator}
                        onChange={(e) => setSeparator(e.target.value)}
                        style={{ width: 200 }}
                    />
                    <Select
                        placeholder="导入到分组（可选）"
                        allowClear
                        value={importGroupId}
                        onChange={(value: number | string | undefined) => setImportGroupId(toOptionalNumber(value))}
                        style={{ width: 260 }}
                    >
                        {groups.map((group: EmailGroup) => (
                            <Select.Option key={group.id} value={group.id}>
                                {group.name}
                            </Select.Option>
                        ))}
                    </Select>
                    <Dragger
                        beforeUpload={(file) => {
                            const reader = new FileReader();
                            reader.onload = (e) => {
                                const fileContent = e.target?.result as string;
                                if (fileContent) {
                                    const lines = fileContent.split(/\r?\n/).filter((line: string) => line.trim());
                                    const processedLines = lines.map((line: string) => {
                                        const parts = line.split(separator);
                                        if (parts.length >= 5) {
                                            return `${parts[0]}${separator}${parts[1]}${separator}${parts[4]}`;
                                        }
                                        return line;
                                    });

                                    setImportContent(processedLines.join('\n'));
                                    message.success(`文件读取成功，已解析 ${lines.length} 行数据`);
                                }
                            };
                            reader.readAsText(file);
                            return false;
                        }}
                        showUploadList={false}
                        maxCount={1}
                        accept=".txt,.csv"
                    >
                        <p className="ant-upload-drag-icon">
                            <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">点击或拖拽文件到此区域</p>
                        <p className="ant-upload-hint">支持 .txt 或 .csv 文件</p>
                    </Dragger>
                    <TextArea
                        rows={12}
                        value={importContent}
                        onChange={(e) => setImportContent(e.target.value)}
                        placeholder={`example@outlook.com${separator}client_id${separator}refresh_token`}
                    />
                </Space>
            </Modal>

            {/* 邮件列表 Modal */}
            <Modal
                title={`${currentEmail} 的${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}`}
                open={mailModalVisible}
                onCancel={() => setMailModalVisible(false)}
                footer={null}
                destroyOnClose
                width={1000}
                styles={{ body: { padding: '16px 24px' } }}
            >
                <Space style={{ marginBottom: 16 }}>
                    <Button type="primary" onClick={handleRefreshMails} loading={mailLoading}>
                        收取新邮件
                    </Button>
                    <Popconfirm
                        title={`确定要清空${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}的所有邮件吗？`}
                        onConfirm={handleClearMailbox}
                    >
                        <Button danger>清空</Button>
                    </Popconfirm>
                    <span style={{ marginLeft: 16, color: '#888' }}>
                        共 {mailList.length} 封邮件
                    </span>
                </Space>
                <List
                    loading={mailLoading}
                    dataSource={mailList}
                    itemLayout="horizontal"
                    pagination={{
                        pageSize: 10,
                        showSizeChanger: true,
                        showQuickJumper: true,
                        showTotal: (total: number) => `共 ${total} 条`,
                        style: { marginTop: 16 },
                    }}
                    style={{ maxHeight: 450, overflow: 'auto' }}
                    renderItem={(item: MailItem) => (
                        <List.Item
                            key={item.id}
                            actions={[
                                <Button
                                    type="primary"
                                    size="small"
                                    onClick={() => handleViewEmailDetail(item)}
                                >
                                    查看
                                </Button>
                            ]}
                        >
                            <List.Item.Meta
                                title={
                                    <Typography.Text ellipsis style={{ maxWidth: 600 }}>
                                        {item.subject || '(无主题)'}
                                    </Typography.Text>
                                }
                                description={
                                    <Space size="large">
                                        <span style={{ color: '#1890ff' }}>{item.from || '未知发件人'}</span>
                                        <span style={{ color: '#999' }}>
                                            {item.date ? dayjs(item.date).format('YYYY-MM-DD HH:mm') : '-'}
                                        </span>
                                    </Space>
                                }
                            />
                        </List.Item>
                    )}
                />
            </Modal>

            {/* 邮件详情 Modal */}
            <Modal
                title={emailDetailSubject}
                open={emailDetailVisible}
                onCancel={() => setEmailDetailVisible(false)}
                footer={null}
                destroyOnClose
                afterOpenChange={(open: boolean) => setRenderEmailDetailFrame(open)}
                width={900}
                styles={{ body: { padding: '16px 24px' } }}
            >
                {renderEmailDetailFrame ? (
                    <iframe
                    title="email-content"
                    sandbox="allow-same-origin"
                    srcDoc={`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <style>
                                body { 
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                                    font-size: 14px;
                                    line-height: 1.6;
                                    color: #333;
                                    margin: 0;
                                    padding: 16px;
                                    background: #fafafa;
                                }
                                img { max-width: 100%; height: auto; }
                                a { color: #1890ff; }
                            </style>
                        </head>
                        <body>${emailDetailContent}</body>
                        </html>
                    `}
                    style={{
                        width: '100%',
                        height: 'calc(100vh - 300px)',
                        border: '1px solid #eee',
                        borderRadius: '8px',
                        backgroundColor: '#fafafa',
                    }}
                    />
                ) : (
                    <div style={{ height: 'calc(100vh - 300px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Spin />
                    </div>
                )}
            </Modal>

            {/* 创建/编辑分组 Modal */}
            <Modal
                title={editingGroupId ? '编辑分组' : '创建分组'}
                open={groupModalVisible}
                onOk={handleGroupSubmit}
                onCancel={() => setGroupModalVisible(false)}
                destroyOnClose
                width={400}
            >
                <Form form={groupForm} layout="vertical">
                    <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
                        <Input placeholder="例如：aws、discord" />
                    </Form.Item>
                    <Form.Item name="description" label="描述">
                        <Input placeholder="可选描述" />
                    </Form.Item>
                </Form>
            </Modal>

            {/* 批量分配分组 Modal */}
            <Modal
                title="分配邮箱到分组"
                open={assignGroupModalVisible}
                onOk={handleBatchAssignGroup}
                onCancel={() => setAssignGroupModalVisible(false)}
                destroyOnClose
                width={400}
            >
                <p>已选择 {selectedRowKeys.length} 个邮箱</p>
                <Select
                    placeholder="选择目标分组"
                    style={{ width: '100%' }}
                    value={assignTargetGroupId}
                    onChange={setAssignTargetGroupId}
                >
                    {groups.map((g: EmailGroup) => (
                        <Select.Option key={g.id} value={g.id}>{g.name}</Select.Option>
                    ))}
                </Select>
            </Modal>
        </div>
    );
};

export default EmailsPage;
