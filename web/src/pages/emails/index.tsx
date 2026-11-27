import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { isSuperAdmin } from '../../utils/auth';
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
    Checkbox,
    Dropdown,
    Empty,
    Pagination,
    Segmented,
    Switch,
    InputNumber,
    Divider,
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
    SyncOutlined,
    MoreOutlined,
    ReloadOutlined,
    CopyOutlined,
    SendOutlined,
    SafetyCertificateOutlined,
} from '@ant-design/icons';
import { emailApi, groupApi, sendApi, type OAuthTenantValue, type SendStrategyValue } from '../../api';
import {
    SEND_TRANSPORT_LABELS,
    SEND_TRANSPORT_OPTIONS,
    effectiveSendCapability,
    type SendTransportValue,
} from '../../constants/sendTransport';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';
import { useIsMobile } from '../../hooks/useIsMobile';
import { buildMailPreview, extractVerificationCode } from '../../utils/mail';

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;
const MAIL_FETCH_STRATEGY_OPTIONS = [
    { value: 'GRAPH_FIRST', label: 'Graph 优先（失败回退 IMAP）' },
    { value: 'IMAP_FIRST', label: 'IMAP 优先（失败回退 Graph）' },
    { value: 'GRAPH_ONLY', label: '仅 Graph' },
    { value: 'IMAP_ONLY', label: '仅 IMAP' },
] as const;

type MailFetchStrategy = (typeof MAIL_FETCH_STRATEGY_OPTIONS)[number]['value'];

type EmailStatus = 'ACTIVE' | 'ERROR' | 'DISABLED';
type SendCapability = 'UNKNOWN' | 'ALLOWED' | 'DENIED';

const SEND_STRATEGY_OPTIONS: Array<{ value: SendStrategyValue; label: string }> = [
    { value: 'LEAST_USED', label: '最少使用优先（24 小时内发得最少）' },
    { value: 'ROUND_ROBIN', label: '轮流（最久没发信的优先）' },
    { value: 'RANDOM', label: '随机' },
];

const OAUTH_TENANT_OPTIONS: Array<{ value: OAuthTenantValue; label: string }> = [
    { value: 'CONSUMERS', label: '个人账号（/consumers，outlook.com / hotmail.com 等）' },
    { value: 'ORGANIZATIONS', label: '工作或学校账号（/organizations）' },
    { value: 'COMMON', label: '两种都支持（/common）' },
];

const OAUTH_TENANT_LABELS: Record<OAuthTenantValue, string> = {
    CONSUMERS: '个人账号',
    ORGANIZATIONS: '工作/学校',
    COMMON: '通用',
};

const SEND_STRATEGY_LABELS: Record<SendStrategyValue, string> = {
    LEAST_USED: '最少使用',
    ROUND_ROBIN: '轮流',
    RANDOM: '随机',
};

const SEND_GROUP_DEFAULTS = {
    sendEnabled: false,
    sendStrategy: 'LEAST_USED' as SendStrategyValue,
    sendDailyLimit: 30,
    sendIntervalSeconds: 60,
    sendMaxRecipients: 10,
    sendTransport: 'AUTO' as SendTransportValue,
};

const CAPABILITY_TEXT: Record<SendCapability, string> = {
    ALLOWED: '可用',
    DENIED: '不可用',
    UNKNOWN: '未检测',
};

/** 账号在所在分组发信通道下的有效发信能力（未分组按自动） */
const accountSendCapability = (record: Pick<EmailAccount, 'sendCapability' | 'smtpCapability' | 'group'>): SendCapability =>
    effectiveSendCapability(record.group?.sendTransport ?? 'AUTO', record.sendCapability, record.smtpCapability);

const renderSendCapability = (record: Pick<EmailAccount, 'sendCapability' | 'smtpCapability' | 'group' | 'sendCooldownUntil' | 'sendErrorMessage'>) => {
    const coolingUntil = record.sendCooldownUntil && dayjs(record.sendCooldownUntil).isAfter(dayjs())
        ? dayjs(record.sendCooldownUntil)
        : null;
    const meta: Record<SendCapability, { color: string; label: string }> = {
        ALLOWED: { color: 'green', label: '可发信' },
        DENIED: { color: 'red', label: '无发信权限' },
        UNKNOWN: { color: 'default', label: '未检测' },
    };
    const capability = accountSendCapability(record);
    const tag = <Tag color={meta[capability].color} style={{ marginInlineEnd: 0 }}>{meta[capability].label}</Tag>;
    const tooltip = [
        `Graph：${CAPABILITY_TEXT[record.sendCapability || 'UNKNOWN']}；SMTP：${CAPABILITY_TEXT[record.smtpCapability || 'UNKNOWN']}（分组发信通道：${SEND_TRANSPORT_LABELS[record.group?.sendTransport ?? 'AUTO']}）`,
        coolingUntil ? `冷却至 ${coolingUntil.format('MM-DD HH:mm')}` : null,
        record.sendErrorMessage,
    ].filter(Boolean).join('；');
    return (
        <Space size={4} wrap>
            {tooltip ? <Tooltip title={tooltip}>{tag}</Tooltip> : tag}
            {coolingUntil && <Tag color="orange" style={{ marginInlineEnd: 0 }}>冷却中</Tag>}
        </Space>
    );
};

const EMAIL_STATUS_META: Record<EmailStatus, { color: string; label: string }> = {
    ACTIVE: { color: 'green', label: '正常' },
    ERROR: { color: 'red', label: '异常' },
    DISABLED: { color: 'default', label: '禁用' },
};

const EMAIL_STATUS_OPTIONS = (Object.keys(EMAIL_STATUS_META) as EmailStatus[]).map((value) => ({
    value,
    label: EMAIL_STATUS_META[value].label,
}));

const formatDateTime = (val: string | null | undefined) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-');

const MAIL_FETCH_STRATEGY_LABELS: Record<MailFetchStrategy, string> = {
    GRAPH_FIRST: 'Graph 优先',
    IMAP_FIRST: 'IMAP 优先',
    GRAPH_ONLY: '仅 Graph',
    IMAP_ONLY: '仅 IMAP',
};

interface EmailGroup {
    id: number;
    name: string;
    description: string | null;
    fetchStrategy: MailFetchStrategy;
    oauthTenant?: OAuthTenantValue;
    sendTransport?: SendTransportValue;
    sendEnabled: boolean;
    sendStrategy: SendStrategyValue;
    sendDailyLimit: number;
    sendIntervalSeconds: number;
    sendMaxRecipients: number;
    emailCount: number;
    createdAt: string;
    updatedAt: string;
}

interface EmailAccount {
    id: number;
    email: string;
    clientId: string;
    status: EmailStatus;
    groupId: number | null;
    group: { id: number; name: string; sendTransport?: SendTransportValue } | null;
    lastCheckAt: string | null;
    tokenRefreshedAt: string | null;
    errorMessage: string | null;
    sendCapability?: SendCapability;
    smtpCapability?: SendCapability;
    sendCheckedAt?: string | null;
    lastSentAt?: string | null;
    sendCooldownUntil?: string | null;
    sendErrorMessage?: string | null;
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

interface MailViewItem extends MailItem {
    preview: string;
    code: string | null;
}

const renderEmailStatusTag = (record: Pick<EmailAccount, 'status' | 'errorMessage'>) => {
    const meta = EMAIL_STATUS_META[record.status] ?? { color: 'default', label: record.status };
    const tag = <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.label}</Tag>;
    if (record.status === 'ERROR' && record.errorMessage) {
        return <Tooltip title={record.errorMessage}>{tag}</Tooltip>;
    }
    return tag;
};

interface EmailDetailsResult extends EmailAccount {
    refreshToken: string;
}

const EmailsPage: React.FC = () => {
    const { admin } = useAuthStore();
    const isMobile = useIsMobile();
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
    const [filterStatus, setFilterStatus] = useState<EmailStatus | undefined>(undefined);
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
    const [emailDetailItem, setEmailDetailItem] = useState<MailViewItem | null>(null);
    const [emailEditLoading, setEmailEditLoading] = useState(false);
    const [form] = Form.useForm();

    // Group-related state
    const [groups, setGroups] = useState<EmailGroup[]>([]);
    const [groupModalVisible, setGroupModalVisible] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
    const [groupForm] = Form.useForm();
    const [assignGroupModalVisible, setAssignGroupModalVisible] = useState(false);
    const [assignTargetGroupId, setAssignTargetGroupId] = useState<number | undefined>(undefined);
    const [refreshingTokenIds, setRefreshingTokenIds] = useState<Set<number>>(new Set());
    const [batchRefreshing, setBatchRefreshing] = useState(false);
    const [batchCheckingSend, setBatchCheckingSend] = useState(false);
    const [testSendTarget, setTestSendTarget] = useState<EmailAccount | null>(null);
    const [testSending, setTestSending] = useState(false);
    const [testSendForm] = Form.useForm();
    const latestListRequestIdRef = useRef(0);

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
        const currentRequestId = ++latestListRequestIdRef.current;
        setLoading(true);
        const params: { page: number; pageSize: number; keyword: string; groupId?: number; status?: EmailStatus } = { page, pageSize, keyword: debouncedKeyword };
        if (filterGroupId !== undefined) params.groupId = filterGroupId;
        if (filterStatus !== undefined) params.status = filterStatus;

        const result = await requestData<EmailListResult>(
            () => emailApi.getList(params),
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
    }, [debouncedKeyword, filterGroupId, filterStatus, page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchGroups();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchGroups]);

    useEffect(() => {
        const next = keyword.trim();
        if (next === debouncedKeyword) {
            return;
        }
        const timer = window.setTimeout(() => {
            // 关键词变化时回到第一页，避免停留在超出结果范围的页码
            setDebouncedKeyword(next);
            setPage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword, debouncedKeyword]);

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
            fetchData();
            if (showSuccessToast) {
                message.success('刷新成功');
            }
        }
        setMailLoading(false);
    }, [fetchData]);

    const handleViewMails = useCallback(async (record: EmailAccount, mailbox: string) => {
        setCurrentEmail(record.email);
        setCurrentEmailId(record.id);
        setCurrentMailbox(mailbox);
        setMailModalVisible(true);
        await loadMails(record.id, mailbox);
    }, [loadMails]);

    const handleSwitchMailbox = async (mailbox: string) => {
        if (!currentEmailId || mailbox === currentMailbox) return;
        setCurrentMailbox(mailbox);
        setMailList([]);
        await loadMails(currentEmailId, mailbox);
    };

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
                fetchData();
            } else {
                message.error(res.message || '清空失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '清空失败'));
        }
    };

    // ========================================
    // Token refresh handlers
    // ========================================
    const handleRefreshToken = useCallback(async (record: EmailAccount) => {
        setRefreshingTokenIds(prev => new Set(prev).add(record.id));
        try {
            const res = await emailApi.refreshSingleToken(record.id);
            if (res.code === 200 && res.data?.success) {
                message.success(`${record.email} Token 刷新成功`);
                fetchData();
            } else {
                message.error(res.data?.message || 'Token 刷新失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, 'Token 刷新失败'));
        } finally {
            setRefreshingTokenIds(prev => {
                const next = new Set(prev);
                next.delete(record.id);
                return next;
            });
        }
    }, [fetchData]);

    const handleBatchRefreshTokens = async () => {
        setBatchRefreshing(true);
        try {
            const res = await emailApi.refreshTokens(filterGroupId);
            if (res.code === 200) {
                message.success('批量 Token 刷新任务已启动，请稍后刷新页面查看结果');
            } else {
                message.error(res.message || '启动失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '启动失败'));
        } finally {
            setBatchRefreshing(false);
        }
    };

    const handleViewEmailDetail = (record: MailViewItem) => {
        setEmailDetailItem(record);
        setEmailDetailSubject(record.subject || '无主题');
        setEmailDetailContent(record.html || record.text || '无内容');
        setEmailDetailVisible(true);
    };

    // ========================================
    // Group CRUD handlers
    // ========================================
    // ========================================
    // 发信权限检测 / 测试发信
    // ========================================
    const handleCheckSend = useCallback(async (record: EmailAccount) => {
        const hide = message.loading(`正在检测 ${record.email} 的发信权限...`, 0);
        try {
            const res = await sendApi.checkSend(record.id);
            const result = res.data;
            const detail = `Graph ${CAPABILITY_TEXT[result.graph ?? 'UNKNOWN']}，SMTP ${CAPABILITY_TEXT[result.smtp ?? 'UNKNOWN']}`;
            if (result.capability === 'ALLOWED') {
                message.success(`${record.email} 可以发信（${detail}）`);
            } else if (result.capability === 'DENIED') {
                message.warning(`${record.email} 在所在分组的发信通道下不能发信（${detail}）：${result.message}`);
            } else {
                message.error(`检测失败：${result.message}`);
            }
            fetchData();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '检测失败'));
        } finally {
            hide();
        }
    }, [fetchData]);

    const handleBatchCheckSend = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        setBatchCheckingSend(true);
        try {
            const res = await sendApi.checkSendBatch(selectedRowKeys as number[]);
            const { allowed, denied, failed } = res.data;
            message.success(`检测完成：可发信 ${allowed}，无权限 ${denied}，失败 ${failed}`);
            fetchData();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '检测失败'));
        } finally {
            setBatchCheckingSend(false);
        }
    };

    const openTestSend = useCallback((record: EmailAccount) => {
        setTestSendTarget(record);
        testSendForm.resetFields();
    }, [testSendForm]);

    const handleTestSend = async () => {
        if (!testSendTarget) return;
        try {
            const values = await testSendForm.validateFields();
            setTestSending(true);
            const res = await sendApi.testSend(testSendTarget.id, {
                to: values.to,
                subject: values.subject || undefined,
                text: values.text || undefined,
            });
            if (res.data.sent) {
                message.success(`${res.data.transport === 'SMTP' ? 'Outlook SMTP' : 'Microsoft Graph'} 已接收这封邮件（是否送达以收件方为准）`);
                setTestSendTarget(null);
            } else {
                message.error(`发送失败：${res.data.message}`);
            }
            fetchData();
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'errorFields' in err) return;
            message.error(getErrorMessage(err, '发送失败'));
        } finally {
            setTestSending(false);
        }
    };

    const handleCreateGroup = () => {
        setEditingGroupId(null);
        groupForm.resetFields();
        groupForm.setFieldsValue({ fetchStrategy: 'GRAPH_FIRST', oauthTenant: 'CONSUMERS', ...SEND_GROUP_DEFAULTS });
        setGroupModalVisible(true);
    };

    const handleEditGroup = useCallback((group: EmailGroup) => {
        setEditingGroupId(group.id);
        groupForm.setFieldsValue({
            name: group.name,
            description: group.description,
            fetchStrategy: group.fetchStrategy,
            oauthTenant: group.oauthTenant ?? 'CONSUMERS',
            sendEnabled: group.sendEnabled ?? SEND_GROUP_DEFAULTS.sendEnabled,
            sendStrategy: group.sendStrategy ?? SEND_GROUP_DEFAULTS.sendStrategy,
            sendDailyLimit: group.sendDailyLimit ?? SEND_GROUP_DEFAULTS.sendDailyLimit,
            sendIntervalSeconds: group.sendIntervalSeconds ?? SEND_GROUP_DEFAULTS.sendIntervalSeconds,
            sendMaxRecipients: group.sendMaxRecipients ?? SEND_GROUP_DEFAULTS.sendMaxRecipients,
            sendTransport: group.sendTransport ?? SEND_GROUP_DEFAULTS.sendTransport,
        });
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
            width: 260,
            ellipsis: true,
            render: (email: string) => (
                <Text copyable={{ text: email, tooltips: ['复制邮箱', '已复制'] }} ellipsis style={{ maxWidth: '100%' }}>
                    {email}
                </Text>
            ),
        },
        {
            title: '客户端 ID',
            dataIndex: 'clientId',
            key: 'clientId',
            width: 200,
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
            render: (_: EmailStatus, record: EmailAccount) => renderEmailStatusTag(record),
        },
        {
            title: '最后检查',
            dataIndex: 'lastCheckAt',
            key: 'lastCheckAt',
            width: 160,
            render: formatDateTime,
        },
        {
            title: 'Token 刷新',
            dataIndex: 'tokenRefreshedAt',
            key: 'tokenRefreshedAt',
            width: 160,
            render: formatDateTime,
        },
        {
            title: '发信',
            dataIndex: 'sendCapability',
            key: 'sendCapability',
            width: 170,
            render: (_: unknown, record: EmailAccount) => renderSendCapability(record),
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
            width: 280,
            fixed: 'right',
            render: (_: unknown, record: EmailAccount) => (
                <Space size={0}>
                    <Tooltip title="检测发信权限">
                        <Button
                            type="text"
                            icon={<SafetyCertificateOutlined />}
                            onClick={() => handleCheckSend(record)}
                        />
                    </Tooltip>
                    <Tooltip title="测试发信">
                        <Button
                            type="text"
                            icon={<SendOutlined />}
                            onClick={() => openTestSend(record)}
                            disabled={accountSendCapability(record) === 'DENIED'}
                        />
                    </Tooltip>
                    <Tooltip title="刷新 Token">
                        <Button
                            type="text"
                            icon={<SyncOutlined spin={refreshingTokenIds.has(record.id)} />}
                            onClick={() => handleRefreshToken(record)}
                            disabled={refreshingTokenIds.has(record.id) || record.status === 'DISABLED'}
                        />
                    </Tooltip>
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
    ], [handleCheckSend, handleDelete, handleEdit, handleRefreshToken, handleViewMails, openTestSend, refreshingTokenIds]);

    const rowSelection = useMemo(
        () => ({
            selectedRowKeys,
            onChange: setSelectedRowKeys,
        }),
        [selectedRowKeys]
    );

    const tablePagination = useMemo(
        () => ({
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count: number) => `共 ${count} 条`,
            onChange: (currentPage: number, currentPageSize: number) => {
                setPage(currentPage);
                setPageSize(currentPageSize);
            },
        }),
        [page, pageSize, total]
    );

    const emailDetailSrcDoc = useMemo(
        () => `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
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
                                body { word-break: break-word; overflow-wrap: anywhere; }
                                img, table { max-width: 100% !important; height: auto; }
                                pre { white-space: pre-wrap; }
                                a { color: #1890ff; }
                            </style>
                        </head>
                        <body>${emailDetailContent}</body>
                        </html>
                    `,
        [emailDetailContent]
    );

    const groupFilterOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: `${group.name} (${group.emailCount})`,
            })),
        [groups]
    );

    const groupOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: group.name,
            })),
        [groups]
    );

    const mailViewList: MailViewItem[] = useMemo(
        () =>
            mailList.map((item) => ({
                ...item,
                preview: buildMailPreview(item.text, item.html),
                code: extractVerificationCode(item.subject, item.text, item.html),
            })),
        [mailList]
    );

    // ========================================
    // Mobile list helpers
    // ========================================
    const pageIds = useMemo(() => data.map((item) => item.id), [data]);
    const selectedOnPage = pageIds.filter((id) => selectedRowKeys.includes(id)).length;

    const toggleRowSelection = (id: number, checked: boolean) => {
        setSelectedRowKeys((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((key) => key !== id)));
    };

    const togglePageSelection = (checked: boolean) => {
        setSelectedRowKeys((prev) =>
            checked
                ? [...new Set([...prev, ...pageIds])]
                : prev.filter((key) => !pageIds.includes(key as number))
        );
    };

    const handleMobileMoreAction = (record: EmailAccount, key: string) => {
        if (key === 'refresh') {
            void handleRefreshToken(record);
        } else if (key === 'check-send') {
            void handleCheckSend(record);
        } else if (key === 'test-send') {
            openTestSend(record);
        } else if (key === 'edit') {
            void handleEdit(record);
        } else if (key === 'delete') {
            Modal.confirm({
                title: '确定要删除此邮箱吗？',
                content: record.email,
                okText: '删除',
                cancelText: '取消',
                okButtonProps: { danger: true },
                onOk: () => handleDelete(record.id),
            });
        }
    };

    const mobileEmailList = (
        <Spin spinning={loading}>
            {data.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无邮箱" style={{ padding: '24px 0' }} />
            ) : (
                <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <Checkbox
                            checked={selectedOnPage > 0 && selectedOnPage === pageIds.length}
                            indeterminate={selectedOnPage > 0 && selectedOnPage < pageIds.length}
                            onChange={(e) => togglePageSelection(e.target.checked)}
                        >
                            全选本页
                        </Checkbox>
                        <Text type="secondary">共 {total} 条</Text>
                    </div>
                    {data.map((record) => {
                        const selected = selectedRowKeys.includes(record.id);
                        const refreshing = refreshingTokenIds.has(record.id);
                        return (
                            <div key={record.id} className={`gx-mobile-card${selected ? ' is-selected' : ''}`}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                    <Checkbox
                                        checked={selected}
                                        onChange={(e) => toggleRowSelection(record.id, e.target.checked)}
                                        style={{ marginTop: 2 }}
                                        aria-label={`选择 ${record.email}`}
                                    />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <Text
                                            strong
                                            copyable={{ text: record.email, tooltips: ['复制邮箱', '已复制'] }}
                                            ellipsis
                                            style={{ maxWidth: '100%' }}
                                        >
                                            {record.email}
                                        </Text>
                                        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                            {renderEmailStatusTag(record)}
                                            {accountSendCapability(record) !== 'UNKNOWN' && renderSendCapability(record)}
                                            {record.group ? (
                                                <Tag color="blue" style={{ marginInlineEnd: 0 }}>{record.group.name}</Tag>
                                            ) : (
                                                <Tag style={{ marginInlineEnd: 0 }}>未分组</Tag>
                                            )}
                                        </div>
                                        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                                            检查 {formatDateTime(record.lastCheckAt)} · Token {formatDateTime(record.tokenRefreshedAt)}
                                        </Text>
                                        {record.status === 'ERROR' && record.errorMessage && (
                                            <Text
                                                type="danger"
                                                style={{ fontSize: 12, display: 'block', maxWidth: '100%' }}
                                                ellipsis={{ tooltip: record.errorMessage }}
                                            >
                                                {record.errorMessage}
                                            </Text>
                                        )}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                                    <Button
                                        size="small"
                                        icon={<MailOutlined />}
                                        style={{ flex: 1 }}
                                        onClick={() => handleViewMails(record, 'INBOX')}
                                    >
                                        收件箱
                                    </Button>
                                    <Button
                                        size="small"
                                        icon={<DeleteOutlined style={{ color: '#faad14' }} />}
                                        style={{ flex: 1 }}
                                        onClick={() => handleViewMails(record, 'Junk')}
                                    >
                                        垃圾箱
                                    </Button>
                                    <Dropdown
                                        trigger={['click']}
                                        placement="bottomRight"
                                        menu={{
                                            items: [
                                                {
                                                    key: 'refresh',
                                                    icon: <SyncOutlined spin={refreshing} />,
                                                    label: '刷新 Token',
                                                    disabled: refreshing || record.status === 'DISABLED',
                                                },
                                                { key: 'check-send', icon: <SafetyCertificateOutlined />, label: '检测发信权限' },
                                                {
                                                    key: 'test-send',
                                                    icon: <SendOutlined />,
                                                    label: '测试发信',
                                                    disabled: accountSendCapability(record) === 'DENIED',
                                                },
                                                { key: 'edit', icon: <EditOutlined />, label: '编辑' },
                                                { type: 'divider' },
                                                { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
                                            ],
                                            onClick: ({ key }) => handleMobileMoreAction(record, key),
                                        }}
                                    >
                                        <Button size="small" icon={<MoreOutlined />} aria-label="更多操作" />
                                    </Dropdown>
                                </div>
                            </div>
                        );
                    })}
                    <Pagination
                        align="center"
                        size="small"
                        current={page}
                        pageSize={pageSize}
                        total={total}
                        showSizeChanger={false}
                        onChange={(currentPage) => setPage(currentPage)}
                        style={{ marginTop: 12 }}
                    />
                </>
            )}
        </Spin>
    );

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
            title: '拉取策略',
            dataIndex: 'fetchStrategy',
            key: 'fetchStrategy',
            width: 190,
            render: (value: MailFetchStrategy) => <Tag color="purple">{MAIL_FETCH_STRATEGY_LABELS[value]}</Tag>,
        },
        {
            title: '登录端点',
            dataIndex: 'oauthTenant',
            key: 'oauthTenant',
            width: 120,
            render: (value: OAuthTenantValue | undefined) => {
                const tenant = value ?? 'CONSUMERS';
                return (
                    <Tooltip title={`/${tenant.toLowerCase()}`}>
                        <Tag color={tenant === 'CONSUMERS' ? 'blue' : 'gold'}>{OAUTH_TENANT_LABELS[tenant]}</Tag>
                    </Tooltip>
                );
            },
        },
        {
            title: '发信',
            dataIndex: 'sendEnabled',
            key: 'sendEnabled',
            width: 230,
            render: (_: unknown, record: EmailGroup) => (record.sendEnabled ? (
                <Tooltip title={`发信通道：${SEND_TRANSPORT_LABELS[record.sendTransport ?? 'AUTO']}；每账号 24 小时 ${record.sendDailyLimit} 封，间隔 ${record.sendIntervalSeconds} 秒，每封最多 ${record.sendMaxRecipients} 个收件人`}>
                    <Space size={4} wrap>
                        <Tag color="green" style={{ marginInlineEnd: 0 }}>已开启</Tag>
                        <Tag color={(record.sendTransport ?? 'AUTO') === 'GRAPH' ? 'default' : 'cyan'} style={{ marginInlineEnd: 0 }}>
                            {SEND_TRANSPORT_LABELS[record.sendTransport ?? 'AUTO']}
                        </Tag>
                        <Tag style={{ marginInlineEnd: 0 }}>{SEND_STRATEGY_LABELS[record.sendStrategy] ?? record.sendStrategy}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>{record.sendDailyLimit} 封/天</Text>
                    </Space>
                </Tooltip>
            ) : <Tag style={{ marginInlineEnd: 0 }}>关闭</Tag>),
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
                animated={false}
                destroyOnHidden
                items={[
                    {
                        key: 'emails',
                        label: '邮箱列表',
                        children: (
                            <>
                                <div className="gx-toolbar">
                                    <div className="gx-toolbar-filters">
                                        <Input
                                            placeholder="搜索邮箱"
                                            prefix={<SearchOutlined />}
                                            value={keyword}
                                            onChange={(e) => setKeyword(e.target.value)}
                                            style={{ width: 220 }}
                                            allowClear
                                            inputMode="email"
                                        />
                                        <Select
                                            placeholder="按分组筛选"
                                            allowClear
                                            style={{ width: 160 }}
                                            value={filterGroupId}
                                            options={groupFilterOptions}
                                            onChange={(val: number | string | undefined) => {
                                                setFilterGroupId(toOptionalNumber(val));
                                                setPage(1);
                                            }}
                                        />
                                        <Select
                                            placeholder="按状态筛选"
                                            allowClear
                                            style={{ width: 130 }}
                                            value={filterStatus}
                                            options={EMAIL_STATUS_OPTIONS}
                                            onChange={(val: EmailStatus | undefined) => {
                                                setFilterStatus(val);
                                                setPage(1);
                                            }}
                                        />
                                        <Tooltip title="刷新列表">
                                            <Button icon={<ReloadOutlined />} onClick={() => void fetchData()} loading={loading} aria-label="刷新列表" />
                                        </Tooltip>
                                    </div>
                                    <div className="gx-toolbar-actions">
                                        <Button
                                            icon={<SyncOutlined spin={batchRefreshing} />}
                                            onClick={handleBatchRefreshTokens}
                                            loading={batchRefreshing}
                                        >
                                            刷新全部 Token
                                        </Button>
                                        <Button icon={<UploadOutlined />} onClick={() => setImportModalVisible(true)}>
                                            导入
                                        </Button>
                                        {isSuperAdmin(admin?.role) && (
                                            <Button icon={<DownloadOutlined />} onClick={handleExport}>
                                                导出
                                            </Button>
                                        )}
                                        {selectedRowKeys.length > 0 && (
                                            <>
                                                <Button icon={<GroupOutlined />} onClick={() => setAssignGroupModalVisible(true)}>
                                                    分配分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Button onClick={handleBatchRemoveGroup}>
                                                    移出分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Button
                                                    icon={<SafetyCertificateOutlined />}
                                                    loading={batchCheckingSend}
                                                    onClick={handleBatchCheckSend}
                                                    disabled={selectedRowKeys.length > 200}
                                                >
                                                    检测发信权限 ({selectedRowKeys.length})
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
                                    </div>
                                </div>

                                {isMobile ? mobileEmailList : (
                                    <Table
                                        columns={columns}
                                        dataSource={data}
                                        rowKey="id"
                                        loading={loading}
                                        rowSelection={rowSelection}
                                        pagination={tablePagination}
                                        virtual
                                        scroll={{ y: 560, x: 1460 }}
                                    />
                                )}
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
                                    scroll={{ x: 'max-content' }}
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
                destroyOnHidden
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
                        <Select placeholder="可选：选择分组" allowClear options={groupOptions} />
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
                destroyOnHidden
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
                        options={groupOptions}
                        onChange={(value: number | string | undefined) => setImportGroupId(toOptionalNumber(value))}
                        style={{ width: 260 }}
                    />
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
            {mailModalVisible && (
                <Modal
                    title={
                        <Text ellipsis style={{ maxWidth: '90%' }}>
                            {currentEmail}
                        </Text>
                    }
                    open={mailModalVisible}
                    onCancel={() => setMailModalVisible(false)}
                    footer={null}
                    destroyOnHidden
                    width={1000}
                >
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <Segmented
                            value={currentMailbox}
                            options={[
                                { label: '收件箱', value: 'INBOX' },
                                { label: '垃圾箱', value: 'Junk' },
                            ]}
                            onChange={(value) => void handleSwitchMailbox(String(value))}
                            disabled={mailLoading}
                        />
                        <Button type="primary" icon={<SyncOutlined spin={mailLoading} />} onClick={handleRefreshMails} loading={mailLoading}>
                            收取新邮件
                        </Button>
                        <Popconfirm
                            title={`确定要清空${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}的所有邮件吗？`}
                            onConfirm={handleClearMailbox}
                        >
                            <Button danger>清空</Button>
                        </Popconfirm>
                        <Text type="secondary" style={{ marginInlineStart: 'auto' }}>
                            共 {mailList.length} 封
                        </Text>
                    </div>
                    <List
                        loading={mailLoading}
                        dataSource={mailViewList}
                        itemLayout="horizontal"
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无邮件" /> }}
                        pagination={mailViewList.length > 10 ? {
                            pageSize: 10,
                            size: 'small',
                            align: 'center',
                            showSizeChanger: !isMobile,
                            showTotal: isMobile ? undefined : (count: number) => `共 ${count} 条`,
                            style: { marginTop: 12 },
                        } : false}
                        style={isMobile ? undefined : { maxHeight: 480, overflow: 'auto' }}
                        renderItem={(item: MailViewItem) => (
                            <List.Item
                                key={item.id}
                                onClick={() => handleViewEmailDetail(item)}
                                style={{ cursor: 'pointer', alignItems: 'flex-start', paddingInline: 4 }}
                                actions={isMobile ? undefined : [
                                    <Button
                                        key="view"
                                        type="link"
                                        size="small"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleViewEmailDetail(item);
                                        }}
                                    >
                                        查看
                                    </Button>,
                                ]}
                            >
                                <List.Item.Meta
                                    title={
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                            <Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
                                                {item.subject || '(无主题)'}
                                            </Text>
                                            {item.code && (
                                                <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                                                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                                        <Text
                                                            copyable={{ text: item.code, icon: <CopyOutlined />, tooltips: ['复制验证码', '已复制'] }}
                                                            style={{ fontFamily: 'monospace', fontWeight: 600 }}
                                                        >
                                                            {item.code}
                                                        </Text>
                                                    </Tag>
                                                </span>
                                            )}
                                        </div>
                                    }
                                    description={
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, fontSize: 12 }}>
                                                <Text type="secondary" ellipsis style={{ maxWidth: '100%', color: '#1677ff' }}>
                                                    {item.from || '未知发件人'}
                                                </Text>
                                                <Text type="secondary" style={{ fontSize: 12 }}>
                                                    {formatDateTime(item.date)}
                                                </Text>
                                            </div>
                                            {item.preview && (
                                                <Text type="secondary" ellipsis style={{ display: 'block', maxWidth: '100%', marginTop: 2 }}>
                                                    {item.preview}
                                                </Text>
                                            )}
                                        </div>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                </Modal>
            )}

            {/* 邮件详情 Modal */}
            {emailDetailVisible && (
                <Modal
                    title={emailDetailSubject}
                    open={emailDetailVisible}
                    onCancel={() => setEmailDetailVisible(false)}
                    footer={null}
                    destroyOnHidden
                    width={900}
                >
                    {emailDetailItem && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                            <Text type="secondary" ellipsis style={{ maxWidth: '100%' }}>
                                {emailDetailItem.from || '未知发件人'} · {formatDateTime(emailDetailItem.date)}
                            </Text>
                            {emailDetailItem.code && (
                                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                    验证码：
                                    <Text
                                        copyable={{ text: emailDetailItem.code, tooltips: ['复制验证码', '已复制'] }}
                                        style={{ fontFamily: 'monospace', fontWeight: 600 }}
                                    >
                                        {emailDetailItem.code}
                                    </Text>
                                </Tag>
                            )}
                        </div>
                    )}
                    <iframe
                        title="email-content"
                        sandbox=""
                        srcDoc={emailDetailSrcDoc}
                        referrerPolicy="no-referrer"
                        style={{
                            width: '100%',
                            height: isMobile ? 'calc(100vh - 240px)' : 'calc(100vh - 320px)',
                            minHeight: 320,
                            border: '1px solid #eee',
                            borderRadius: '8px',
                            backgroundColor: '#fafafa',
                        }}
                    />
                </Modal>
            )}

            {/* 创建/编辑分组 Modal */}
            <Modal
                title={editingGroupId ? '编辑分组' : '创建分组'}
                open={groupModalVisible}
                onOk={handleGroupSubmit}
                onCancel={() => setGroupModalVisible(false)}
                destroyOnHidden
                width={460}
            >
                <Form form={groupForm} layout="vertical">
                    <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
                        <Input placeholder="例如：aws、discord" />
                    </Form.Item>
                    <Form.Item name="description" label="描述">
                        <Input placeholder="可选描述" />
                    </Form.Item>
                    <Form.Item
                        name="fetchStrategy"
                        label="邮件拉取策略"
                        rules={[{ required: true, message: '请选择拉取策略' }]}
                    >
                        <Select options={MAIL_FETCH_STRATEGY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
                    </Form.Item>
                    <Form.Item
                        name="oauthTenant"
                        label="微软登录端点"
                        rules={[{ required: true, message: '请选择登录端点' }]}
                        extra="收信、发信和 Token 刷新换取令牌时使用。要与客户端 ID 在微软注册时支持的账号类型一致：只支持个人账号的应用只能用 /consumers，用 /common 会报 AADSTS9002331"
                    >
                        <Select options={OAUTH_TENANT_OPTIONS} />
                    </Form.Item>

                    <Divider titlePlacement="start" style={{ margin: '8px 0 16px' }}>发信设置</Divider>
                    <Form.Item
                        name="sendEnabled"
                        label="参与发信池"
                        valuePropName="checked"
                        extra="开启后，组内能发信的账号会被 Resend 兼容接口轮换使用"
                    >
                        <Switch />
                    </Form.Item>
                    <Form.Item
                        name="sendTransport"
                        label="发信通道"
                        rules={[{ required: true, message: '请选择发信通道' }]}
                        extra="Graph 会忽略自定义发件人名称（改用账号资料里的名字）；SMTP 会保留名称，但要求令牌含 SMTP.Send 权限且邮箱没有禁用 SMTP 认证。在线发信、测试发信和 Resend 接口都按此设置"
                    >
                        <Select options={SEND_TRANSPORT_OPTIONS} />
                    </Form.Item>
                    <Form.Item noStyle shouldUpdate={(prev, next) => prev.sendEnabled !== next.sendEnabled}>
                        {({ getFieldValue }) => getFieldValue('sendEnabled') ? (
                            <>
                                <Form.Item name="sendStrategy" label="挑选账号方式" rules={[{ required: true }]}>
                                    <Select options={SEND_STRATEGY_OPTIONS} />
                                </Form.Item>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', columnGap: 12 }}>
                                    <Form.Item name="sendDailyLimit" label="每账号 24 小时上限" rules={[{ required: true }]}>
                                        <InputNumber min={1} max={10000} precision={0} style={{ width: '100%' }} addonAfter="封" />
                                    </Form.Item>
                                    <Form.Item name="sendIntervalSeconds" label="同账号发信间隔" rules={[{ required: true }]}>
                                        <InputNumber min={0} max={86400} precision={0} style={{ width: '100%' }} addonAfter="秒" />
                                    </Form.Item>
                                    <Form.Item name="sendMaxRecipients" label="每封收件人上限" rules={[{ required: true }]}>
                                        <InputNumber min={1} max={150} precision={0} style={{ width: '100%' }} addonAfter="个" />
                                    </Form.Item>
                                </div>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                    个人 Outlook 账号的发信量受微软限制，新账号尤其严格，建议从较低的上限开始。
                                </Text>
                            </>
                        ) : null}
                    </Form.Item>
                </Form>
            </Modal>

            {/* 测试发信 Modal */}
            <Modal
                title={testSendTarget ? `测试发信 - ${testSendTarget.email}` : '测试发信'}
                open={!!testSendTarget}
                onOk={handleTestSend}
                onCancel={() => setTestSendTarget(null)}
                okText="发送"
                confirmLoading={testSending}
                destroyOnHidden
                width={480}
            >
                <Form form={testSendForm} layout="vertical">
                    <Form.Item
                        name="to"
                        label="收件人"
                        rules={[{ required: true, message: '请输入收件人' }, { type: 'email', message: '请输入有效的邮箱地址' }]}
                    >
                        <Input placeholder="you@example.com" inputMode="email" />
                    </Form.Item>
                    <Form.Item name="subject" label="主题">
                        <Input placeholder="默认：GongXi Mail 测试发信" maxLength={200} />
                    </Form.Item>
                    <Form.Item name="text" label="正文">
                        <TextArea rows={4} placeholder="默认：一段说明发件账号的测试文本" maxLength={5000} />
                    </Form.Item>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        测试发信不受分组开关、间隔和额度限制，但会计入该账号的 24 小时发信量，并出现在发信记录中。
                    </Text>
                </Form>
            </Modal>

            {/* 批量分配分组 Modal */}
            <Modal
                title="分配邮箱到分组"
                open={assignGroupModalVisible}
                onOk={handleBatchAssignGroup}
                onCancel={() => setAssignGroupModalVisible(false)}
                destroyOnHidden
                width={400}
            >
                <p>已选择 {selectedRowKeys.length} 个邮箱</p>
                <Select
                    placeholder="选择目标分组"
                    style={{ width: '100%' }}
                    value={assignTargetGroupId}
                    options={groupOptions}
                    onChange={setAssignTargetGroupId}
                />
            </Modal>
        </div>
    );
};

export default EmailsPage;
