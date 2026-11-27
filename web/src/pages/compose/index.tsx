import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Alert,
    Button,
    Card,
    Empty,
    Form,
    Input,
    Modal,
    Popconfirm,
    Progress,
    Segmented,
    Select,
    Space,
    Tabs,
    Tag,
    Tooltip,
    Typography,
    Upload,
    message,
} from 'antd';
import {
    ClearOutlined,
    DeleteOutlined,
    HistoryOutlined,
    InboxOutlined,
    PaperClipOutlined,
    PlusOutlined,
    SendOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { PageHeader } from '../../components';
import { sendApi, type ComposeRequest, type ComposeResult } from '../../api';
import { requestData } from '../../utils/request';
import { getErrorMessage } from '../../utils/error';
import { useIsMobile } from '../../hooks/useIsMobile';

const { Text } = Typography;
const { TextArea } = Input;

/** Graph 单次 sendMail 请求内联附件总大小上限 */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const DRAFT_KEY = 'gx.compose.draft.v1';
const ADDRESS_SEPARATORS = [',', ';', '\n', '，', '；'];

type Mode = 'POOL' | 'ACCOUNT';
type BodyType = 'HTML' | 'TEXT';

interface ComposeFormValues {
    mode: Mode;
    groupId?: number;
    accountId?: number;
    fromName?: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    subject: string;
    bodyType: BodyType;
    html: string;
    text: string;
}

interface Draft extends Partial<ComposeFormValues> {
    accountEmail?: string;
}

interface SenderItem {
    id: number;
    email: string;
    sendCapability: 'UNKNOWN' | 'ALLOWED' | 'DENIED';
    sendCooldownUntil: string | null;
    lastSentAt: string | null;
    sendErrorMessage: string | null;
    groupId: number | null;
    groupName: string | null;
    sendEnabled: boolean | null;
    sendDailyLimit: number | null;
    sent24h: number;
}

interface PoolGroup {
    id: number;
    name: string;
    sendEnabled: boolean;
    sendDailyLimit: number;
    sendMaxRecipients: number;
    allowed: number;
    unknown: number;
    denied: number;
    cooling: number;
    remaining: number;
}

interface AttachmentItem {
    uid: string;
    name: string;
    size: number;
    type: string;
    content: string;
}

const EMPTY_VALUES: ComposeFormValues = {
    mode: 'POOL',
    groupId: undefined,
    accountId: undefined,
    fromName: '',
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: '',
    bodyType: 'HTML',
    html: '',
    text: '',
};

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** 支持 a@b.com 与 Name <a@b.com> */
function extractAddress(value: string): string {
    const raw = value.trim();
    const match = /^(.*)<([^<>]+)>\s*$/.exec(raw);
    return (match ? match[2] : raw).trim();
}

function isValidAddress(value: string): boolean {
    const address = extractAddress(value);
    return address.length <= 254 && EMAIL_RE.test(address);
}

function dedupeAddresses(list: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of list) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const key = extractAddress(trimmed).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(trimmed);
    }
    return result;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function readDraft(): Draft | null {
    try {
        const raw = window.localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Draft;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeDraft(draft: Draft) {
    try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
        // 存储满或隐私模式：忽略
    }
}

function clearDraft() {
    try {
        window.localStorage.removeItem(DRAFT_KEY);
    } catch {
        // ignore
    }
}

function hasDraftContent(draft: Draft | null): boolean {
    if (!draft) return false;
    return !!(draft.to?.length || draft.subject?.trim() || draft.html?.trim() || draft.text?.trim());
}

const addressRule = (required: boolean, label: string) => ({
    validator: (_: unknown, value?: string[]) => {
        const list = value || [];
        if (required && list.length === 0) {
            return Promise.reject(new Error(`请填写${label}`));
        }
        const invalid = list.filter((item) => !isValidAddress(item));
        if (invalid.length > 0) {
            return Promise.reject(new Error(`邮箱格式不正确：${invalid.slice(0, 3).join('、')}`));
        }
        return Promise.resolve();
    },
});

interface AddressInputProps {
    value?: string[];
    onChange?: (value: string[]) => void;
    placeholder?: string;
}

/** 多个地址输入：回车、逗号、分号或换行确认；格式错误的地址标红 */
const AddressInput: React.FC<AddressInputProps> = ({ value, onChange, placeholder }) => (
    <Select
        mode="tags"
        value={value}
        onChange={(next: string[]) => onChange?.(dedupeAddresses(next))}
        tokenSeparators={ADDRESS_SEPARATORS}
        placeholder={placeholder}
        suffixIcon={null}
        notFoundContent={null}
        options={[]}
        // 只当作标签输入框使用，不弹出下拉列表
        open={false}
        style={{ width: '100%' }}
        tagRender={({ label, value: tagValue, closable, onClose }) => {
            const invalid = !isValidAddress(String(tagValue));
            return (
                <Tag
                    color={invalid ? 'red' : undefined}
                    closable={closable}
                    onClose={onClose}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    style={{ marginInlineEnd: 4, marginBlock: 2 }}
                >
                    {label}
                </Tag>
            );
        }}
    />
);

const ComposePage: React.FC = () => {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const [form] = Form.useForm<ComposeFormValues>();
    const [initialDraft] = useState<Draft | null>(() => readDraft());
    const [restoredDraft, setRestoredDraft] = useState(() => hasDraftContent(initialDraft));
    const [showCc, setShowCc] = useState(() => !!initialDraft?.cc?.length);
    const [showBcc, setShowBcc] = useState(() => !!initialDraft?.bcc?.length);
    const [showReplyTo, setShowReplyTo] = useState(() => !!initialDraft?.replyTo?.length);
    const [accountEmail, setAccountEmail] = useState<string | undefined>(initialDraft?.accountEmail);
    const [senders, setSenders] = useState<SenderItem[]>([]);
    const [sendersLoading, setSendersLoading] = useState(false);
    const [poolGroups, setPoolGroups] = useState<PoolGroup[] | null>(null);
    const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
    const [sending, setSending] = useState(false);
    const [lastResult, setLastResult] = useState<ComposeResult | null>(null);
    const [bodyTab, setBodyTab] = useState<'edit' | 'preview'>('edit');

    const reservedBytesRef = useRef(0);
    const reservedCountRef = useRef(0);
    const searchTimerRef = useRef<number | undefined>(undefined);
    const draftTimerRef = useRef<number | undefined>(undefined);

    const mode = (Form.useWatch('mode', { form, preserve: true }) ?? initialDraft?.mode ?? 'POOL') as Mode;
    const groupId = Form.useWatch('groupId', { form, preserve: true }) as number | undefined;
    const accountId = Form.useWatch('accountId', { form, preserve: true }) as number | undefined;
    const fromName = Form.useWatch('fromName', { form, preserve: true }) as string | undefined;
    const to = Form.useWatch('to', { form, preserve: true }) as string[] | undefined;
    const cc = Form.useWatch('cc', { form, preserve: true }) as string[] | undefined;
    const bcc = Form.useWatch('bcc', { form, preserve: true }) as string[] | undefined;
    const bodyType = (Form.useWatch('bodyType', { form, preserve: true }) ?? 'HTML') as BodyType;
    const html = (Form.useWatch('html', { form, preserve: true }) as string | undefined) ?? '';
    const text = (Form.useWatch('text', { form, preserve: true }) as string | undefined) ?? '';

    // ---------------- 数据 ----------------
    const loadPoolGroups = useCallback(async () => {
        const result = await requestData<{ groups: PoolGroup[] }>(() => sendApi.getStats(), '获取发信池失败', { silent: true });
        setPoolGroups(result ? result.groups.filter((item) => item.sendEnabled) : []);
    }, []);

    const loadSenders = useCallback(async (keyword: string) => {
        setSendersLoading(true);
        const result = await requestData<SenderItem[]>(
            () => sendApi.getSenders({ keyword: keyword || undefined, limit: 50 }),
            '获取发件账号失败',
            { silent: true }
        );
        if (result) setSenders(result);
        setSendersLoading(false);
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void loadPoolGroups();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [loadPoolGroups]);

    useEffect(() => {
        if (mode !== 'ACCOUNT') return undefined;
        const timer = window.setTimeout(() => {
            void loadSenders('');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [mode, loadSenders]);

    useEffect(() => () => {
        window.clearTimeout(searchTimerRef.current);
        window.clearTimeout(draftTimerRef.current);
    }, []);

    const handleSenderSearch = (keyword: string) => {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = window.setTimeout(() => {
            void loadSenders(keyword.trim());
        }, 300);
    };

    // ---------------- 草稿 ----------------
    const scheduleDraftSave = (email: string | undefined = accountEmail) => {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = window.setTimeout(() => {
            // 读取全部字段（包括当前隐藏的抄送 / 另一种正文）
            writeDraft({ ...(form.getFieldsValue(true) as Partial<ComposeFormValues>), accountEmail: email });
        }, 400);
    };

    const handleClear = () => {
        window.clearTimeout(draftTimerRef.current);
        form.setFieldsValue({ ...EMPTY_VALUES, mode, groupId, accountId, fromName });
        setAttachments([]);
        reservedBytesRef.current = 0;
        reservedCountRef.current = 0;
        setShowCc(false);
        setShowBcc(false);
        setShowReplyTo(false);
        setLastResult(null);
        setRestoredDraft(false);
        clearDraft();
        writeDraft({ mode, groupId, accountId, fromName, accountEmail });
    };

    // ---------------- 附件 ----------------
    const addFile = (file: File) => {
        if (file.size === 0) {
            message.error(`${file.name} 是空文件`);
            return;
        }
        if (reservedCountRef.current >= MAX_ATTACHMENTS) {
            message.error(`最多 ${MAX_ATTACHMENTS} 个附件`);
            return;
        }
        if (reservedBytesRef.current + file.size > MAX_ATTACHMENT_BYTES) {
            message.error(`附件合计不能超过 3 MB（${file.name} 为 ${formatBytes(file.size)}）`);
            return;
        }
        reservedBytesRef.current += file.size;
        reservedCountRef.current += 1;

        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const content = result.slice(result.indexOf(',') + 1);
            setAttachments((prev) => [...prev, {
                uid: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                name: file.name,
                size: file.size,
                type: file.type,
                content,
            }]);
        };
        reader.onerror = () => {
            reservedBytesRef.current -= file.size;
            reservedCountRef.current -= 1;
            message.error(`读取 ${file.name} 失败`);
        };
        reader.readAsDataURL(file);
    };

    const removeAttachment = (uid: string) => {
        setAttachments((prev) => {
            const target = prev.find((item) => item.uid === uid);
            if (target) {
                reservedBytesRef.current -= target.size;
                reservedCountRef.current -= 1;
            }
            return prev.filter((item) => item.uid !== uid);
        });
    };

    const attachmentBytes = attachments.reduce((sum, item) => sum + item.size, 0);

    // ---------------- 派生信息 ----------------
    const selectedGroup = useMemo(
        () => (poolGroups || []).find((item) => item.id === groupId),
        [groupId, poolGroups]
    );
    const recipientCount = useMemo(
        () => dedupeAddresses([...(to ?? []), ...(showCc ? cc ?? [] : []), ...(showBcc ? bcc ?? [] : [])]).length,
        [bcc, cc, showBcc, showCc, to]
    );
    const recipientLimit = useMemo(() => {
        if (mode !== 'POOL') return 150;
        if (selectedGroup) return selectedGroup.sendMaxRecipients;
        const limits = (poolGroups || []).map((item) => item.sendMaxRecipients);
        return limits.length > 0 ? Math.max(...limits) : 0;
    }, [mode, poolGroups, selectedGroup]);
    const overRecipientLimit = recipientLimit > 0 && recipientCount > recipientLimit;

    const senderOptions = useMemo(() => {
        const options = senders.map((item) => ({ value: item.id, label: item.email, sender: item }));
        if (accountId && accountEmail && !senders.some((item) => item.id === accountId)) {
            options.unshift({ value: accountId, label: accountEmail, sender: undefined as unknown as SenderItem });
        }
        return options;
    }, [accountEmail, accountId, senders]);

    const groupOptions = useMemo(
        () => (poolGroups || []).map((item) => ({
            value: item.id,
            label: `${item.name}（可发 ${item.allowed + item.unknown} 个账号，剩余 ${item.remaining} 封）`,
        })),
        [poolGroups]
    );

    const previewDoc = useMemo(() => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#333;margin:0;padding:16px;word-break:break-word}img,table{max-width:100%!important;height:auto}</style>
</head><body>${html || '<p style="color:#999">（正文为空）</p>'}</body></html>`, [html]);

    const senderSummary = mode === 'POOL'
        ? `发信池 · ${selectedGroup ? selectedGroup.name : '全部开启发信的分组'}`
        : accountEmail || '未选择账号';

    // ---------------- 发送 ----------------
    const submit = async (values: ComposeFormValues) => {
        setSending(true);
        setLastResult(null);
        try {
            const payload: ComposeRequest = {
                mode: values.mode,
                groupId: values.mode === 'POOL' ? values.groupId : undefined,
                accountId: values.mode === 'ACCOUNT' ? values.accountId : undefined,
                fromName: values.fromName?.trim() || undefined,
                to: dedupeAddresses(values.to || []),
                cc: showCc && values.cc?.length ? dedupeAddresses(values.cc) : undefined,
                bcc: showBcc && values.bcc?.length ? dedupeAddresses(values.bcc) : undefined,
                replyTo: showReplyTo && values.replyTo?.length ? dedupeAddresses(values.replyTo) : undefined,
                subject: values.subject.trim(),
                html: values.bodyType === 'HTML' ? values.html : undefined,
                text: values.bodyType === 'TEXT' ? values.text : undefined,
                attachments: attachments.length > 0
                    ? attachments.map((item) => ({ filename: item.name, content: item.content, contentType: item.type || undefined }))
                    : undefined,
            };
            const res = await sendApi.compose(payload);
            const result = res.data;
            setLastResult(result);
            if (result.sent) {
                message.success(`已由 ${result.fromAddress} 发出`);
                window.clearTimeout(draftTimerRef.current);
                form.setFieldsValue({ to: [], cc: [], bcc: [], replyTo: [], subject: '', html: '', text: '' });
                setAttachments([]);
                reservedBytesRef.current = 0;
                reservedCountRef.current = 0;
                setRestoredDraft(false);
                clearDraft();
                writeDraft({
                    mode: values.mode,
                    groupId: values.groupId,
                    accountId: values.accountId,
                    fromName: values.fromName,
                    bodyType: values.bodyType,
                    accountEmail,
                });
            } else {
                message.error(result.message);
            }
            void loadPoolGroups();
            if (values.mode === 'ACCOUNT') void loadSenders('');
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '发送失败'));
        } finally {
            setSending(false);
        }
    };

    const handleSend = async () => {
        if (sending) return;
        let values: ComposeFormValues;
        try {
            const validated = await form.validateFields();
            // 合并未挂载字段（例如切换到预览页时的 HTML 编辑框）
            values = { ...(form.getFieldsValue(true) as ComposeFormValues), ...validated };
        } catch {
            message.warning('请检查标红的内容');
            return;
        }
        const body = values.bodyType === 'HTML' ? values.html : values.text;
        if (!body || !body.trim()) {
            message.warning('请填写正文');
            return;
        }
        if (values.mode === 'POOL' && poolGroups && poolGroups.length === 0) {
            message.warning('还没有分组开启发信');
            return;
        }
        if (overRecipientLimit) {
            message.warning(`收件人超过上限：每封最多 ${recipientLimit} 个（收件人 + 抄送 + 密送）`);
            return;
        }

        Modal.confirm({
            title: '确认发送这封邮件？',
            icon: <SendOutlined style={{ color: '#1677ff' }} />,
            okText: '发送',
            cancelText: '再看看',
            content: (
                <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                    <Text>发件：{senderSummary}{values.fromName ? `（显示名 ${values.fromName}）` : ''}</Text>
                    <Text>收件人：{recipientCount} 个</Text>
                    <Text ellipsis>主题：{values.subject}</Text>
                    {attachments.length > 0 && <Text>附件：{attachments.length} 个，{formatBytes(attachmentBytes)}</Text>}
                </div>
            ),
            onOk: () => submit(values),
        });
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            void handleSend();
        }
    };

    // ---------------- 渲染 ----------------
    const renderSenderOption = (sender: SenderItem | undefined) => {
        if (!sender) return null;
        const cooling = sender.sendCooldownUntil && dayjs(sender.sendCooldownUntil).isAfter(dayjs());
        return (
            <Space size={4} wrap>
                {sender.groupName ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{sender.groupName}</Tag> : <Tag style={{ marginInlineEnd: 0 }}>未分组</Tag>}
                {sender.sendCapability === 'ALLOWED'
                    ? <Tag color="green" style={{ marginInlineEnd: 0 }}>可发信</Tag>
                    : <Tag style={{ marginInlineEnd: 0 }}>未检测</Tag>}
                {cooling && <Tag color="orange" style={{ marginInlineEnd: 0 }}>冷却中</Tag>}
                <Text type="secondary" style={{ fontSize: 12 }}>
                    24h 已发 {sender.sent24h}{sender.sendDailyLimit ? ` / ${sender.sendDailyLimit}` : ''}
                </Text>
            </Space>
        );
    };

    const resultAlert = lastResult && (
        <Alert
            showIcon
            closable
            onClose={() => setLastResult(null)}
            type={lastResult.sent ? 'success' : 'error'}
            style={{ marginBottom: 16 }}
            message={lastResult.sent ? `已由 ${lastResult.fromAddress} 发出` : '发送失败'}
            description={lastResult.sent
                ? `Microsoft Graph 已接收这封邮件，是否送达以收件方为准${lastResult.attempts > 1 ? `（尝试了 ${lastResult.attempts} 个账号）` : ''}。`
                : lastResult.message}
            action={lastResult.logId ? (
                <Button size="small" onClick={() => navigate(`/send-logs?id=${lastResult.logId}`)}>查看记录</Button>
            ) : undefined}
        />
    );

    const poolEmpty = poolGroups !== null && poolGroups.length === 0;

    const summaryCard = (
        <Card size="small" title="发送摘要">
            <div style={{ display: 'grid', gap: 10 }}>
                <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>发件</Text>
                    <div><Text strong ellipsis style={{ maxWidth: '100%' }}>{senderSummary}</Text></div>
                    {fromName?.trim() && <Text type="secondary" style={{ fontSize: 12 }}>显示名：{fromName.trim()}</Text>}
                    {mode === 'POOL' && selectedGroup && (
                        <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                            剩余额度 {selectedGroup.remaining} 封{selectedGroup.cooling > 0 ? ` · ${selectedGroup.cooling} 个账号冷却中` : ''}
                        </Text>
                    )}
                </div>
                <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>收件人</Text>
                    <div>
                        <Text strong type={overRecipientLimit ? 'danger' : undefined}>{recipientCount} 个</Text>
                        {recipientLimit > 0 && <Text type="secondary" style={{ fontSize: 12 }}>（每封上限 {recipientLimit}）</Text>}
                    </div>
                </div>
                <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>附件</Text>
                    <div><Text>{attachments.length} 个 · {formatBytes(attachmentBytes)} / 3 MB</Text></div>
                    <Progress
                        percent={Math.min(100, Math.round((attachmentBytes / MAX_ATTACHMENT_BYTES) * 100))}
                        size="small"
                        showInfo={false}
                        status={attachmentBytes > MAX_ATTACHMENT_BYTES * 0.9 ? 'exception' : 'normal'}
                    />
                </div>
                <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>正文</Text>
                    <div><Text>{bodyType === 'HTML' ? 'HTML' : '纯文本'} · {(bodyType === 'HTML' ? html : text).length} 字符</Text></div>
                </div>
                <Button
                    type="primary"
                    icon={<SendOutlined />}
                    block
                    size="large"
                    loading={sending}
                    disabled={mode === 'POOL' && poolEmpty}
                    onClick={() => void handleSend()}
                >
                    发送
                </Button>
                <Popconfirm title="清空收件人、主题、正文和附件？" onConfirm={handleClear} okText="清空" cancelText="取消">
                    <Button icon={<ClearOutlined />} block>清空</Button>
                </Popconfirm>
                {!isMobile && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        Ctrl + Enter 快速发送。草稿（不含附件）自动保存在本浏览器。
                    </Text>
                )}
            </div>
        </Card>
    );

    return (
        <div onKeyDown={handleKeyDown}>
            <PageHeader
                title="在线发信"
                subtitle="从分组发信池轮换账号，或指定账号，通过 Microsoft Graph 发送邮件"
                extra={<Button icon={<HistoryOutlined />} onClick={() => navigate('/send-logs')}>发信记录</Button>}
            />

            {resultAlert}
            {restoredDraft && !lastResult && (
                <Alert
                    type="info"
                    showIcon
                    closable
                    onClose={() => setRestoredDraft(false)}
                    style={{ marginBottom: 16 }}
                    message="已恢复上次未发送的草稿"
                    action={<Button size="small" onClick={handleClear}>清空草稿</Button>}
                />
            )}

            <div className="gx-compose-grid">
                <Card>
                    <Form<ComposeFormValues>
                        form={form}
                        layout="vertical"
                        initialValues={{ ...EMPTY_VALUES, ...initialDraft }}
                        onValuesChange={() => scheduleDraftSave()}
                    >
                        <Form.Item name="mode" label="发件方式">
                            <Segmented
                                options={[
                                    { label: '发信池轮换', value: 'POOL' },
                                    { label: '指定账号', value: 'ACCOUNT' },
                                ]}
                            />
                        </Form.Item>

                        {mode === 'POOL' ? (
                            poolEmpty ? (
                                <Alert
                                    type="warning"
                                    showIcon
                                    style={{ marginBottom: 16 }}
                                    message="还没有分组开启发信"
                                    description="在「邮箱管理 → 邮箱分组」编辑分组并开启「参与发信池」，或改用「指定账号」发送。"
                                    action={<Button size="small" onClick={() => navigate('/emails')}>去设置</Button>}
                                />
                            ) : (
                                <Form.Item
                                    name="groupId"
                                    label="发信分组"
                                    extra="按分组的挑号方式、24 小时上限和发信间隔自动选择账号，失败会换号重试"
                                >
                                    <Select
                                        allowClear
                                        placeholder="全部开启发信的分组"
                                        options={groupOptions}
                                        loading={poolGroups === null}
                                    />
                                </Form.Item>
                            )
                        ) : (
                            <Form.Item
                                name="accountId"
                                label="发件账号"
                                rules={[{ required: true, message: '请选择发件账号' }]}
                                extra="指定账号发送不受分组开关、间隔和额度限制，但计入该账号的 24 小时发信量"
                            >
                                <Select
                                    showSearch
                                    filterOption={false}
                                    onSearch={handleSenderSearch}
                                    loading={sendersLoading}
                                    placeholder="搜索邮箱地址"
                                    options={senderOptions}
                                    notFoundContent={sendersLoading ? '加载中...' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可发信的账号" />}
                                    onChange={(_value: number, option) => {
                                        const label = Array.isArray(option) ? undefined : (option?.label as string | undefined);
                                        setAccountEmail(label);
                                        scheduleDraftSave(label);
                                    }}
                                    optionRender={(option) => (
                                        <div style={{ padding: '2px 0' }}>
                                            <div><Text>{option.label}</Text></div>
                                            {renderSenderOption((option.data as { sender?: SenderItem }).sender)}
                                        </div>
                                    )}
                                />
                            </Form.Item>
                        )}

                        <Form.Item name="fromName" label="发件人显示名" extra="收件人看到的名称；发件地址始终是实际发信的账号">
                            <Input placeholder="例如：Acme 团队（可选）" maxLength={100} allowClear />
                        </Form.Item>

                        <Form.Item
                            name="to"
                            label="收件人"
                            rules={[addressRule(true, '收件人')]}
                            extra="回车、逗号或分号确认，可直接粘贴多个地址；支持 Name <a@b.com>"
                        >
                            <AddressInput placeholder="user@example.com" />
                        </Form.Item>

                        {showCc && (
                            <Form.Item name="cc" label="抄送" rules={[addressRule(false, '抄送')]}>
                                <AddressInput placeholder="抄送地址" />
                            </Form.Item>
                        )}
                        {showBcc && (
                            <Form.Item name="bcc" label="密送" rules={[addressRule(false, '密送')]}>
                                <AddressInput placeholder="密送地址" />
                            </Form.Item>
                        )}
                        {showReplyTo && (
                            <Form.Item name="replyTo" label="回复地址" rules={[addressRule(false, '回复地址')]}>
                                <AddressInput placeholder="收件人点「回复」时使用的地址" />
                            </Form.Item>
                        )}
                        {(!showCc || !showBcc || !showReplyTo) && (
                            <Space wrap size={8} style={{ marginBottom: 16 }}>
                                {!showCc && <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setShowCc(true)}>抄送</Button>}
                                {!showBcc && <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setShowBcc(true)}>密送</Button>}
                                {!showReplyTo && <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setShowReplyTo(true)}>回复地址</Button>}
                            </Space>
                        )}

                        <Form.Item
                            name="subject"
                            label="主题"
                            rules={[{ required: true, whitespace: true, message: '请填写主题' }]}
                        >
                            <Input placeholder="邮件主题" maxLength={998} />
                        </Form.Item>

                        <Form.Item label="正文" required style={{ marginBottom: 8 }}>
                            <Space wrap style={{ marginBottom: 8 }}>
                                <Form.Item name="bodyType" noStyle>
                                    <Segmented
                                        size="small"
                                        options={[
                                            { label: 'HTML', value: 'HTML' },
                                            { label: '纯文本', value: 'TEXT' },
                                        ]}
                                    />
                                </Form.Item>
                                <Text type="secondary" style={{ fontSize: 12 }}>Graph 每封只发送一种正文</Text>
                            </Space>
                            {bodyType === 'HTML' ? (
                                <Tabs
                                    size="small"
                                    activeKey={bodyTab}
                                    onChange={(key) => setBodyTab(key as 'edit' | 'preview')}
                                    items={[
                                        {
                                            key: 'edit',
                                            label: '编辑',
                                            children: (
                                                <Form.Item name="html" noStyle>
                                                    <TextArea
                                                        autoSize={{ minRows: 12, maxRows: 30 }}
                                                        placeholder="<p>你好，</p>"
                                                        spellCheck={false}
                                                        style={{ fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace", fontSize: 13 }}
                                                    />
                                                </Form.Item>
                                            ),
                                        },
                                        {
                                            key: 'preview',
                                            label: '预览',
                                            children: (
                                                <iframe
                                                    title="compose-preview"
                                                    sandbox=""
                                                    srcDoc={previewDoc}
                                                    referrerPolicy="no-referrer"
                                                    style={{ width: '100%', height: 360, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fff' }}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            ) : (
                                <Form.Item name="text" noStyle>
                                    <TextArea autoSize={{ minRows: 12, maxRows: 30 }} placeholder="正文内容" />
                                </Form.Item>
                            )}
                        </Form.Item>

                        <Form.Item
                            label={<Space size={4}><PaperClipOutlined />附件</Space>}
                            extra={`合计不超过 3 MB、最多 ${MAX_ATTACHMENTS} 个（Microsoft Graph 单次发信的上限）`}
                            style={{ marginTop: 16, marginBottom: 0 }}
                        >
                            <Upload.Dragger
                                multiple
                                showUploadList={false}
                                beforeUpload={(file) => {
                                    addFile(file);
                                    return Upload.LIST_IGNORE;
                                }}
                                style={{ padding: isMobile ? 0 : undefined }}
                            >
                                <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}><InboxOutlined /></p>
                                <p className="ant-upload-text" style={{ fontSize: 14 }}>点击或拖拽文件到这里</p>
                            </Upload.Dragger>
                            {attachments.length > 0 && (
                                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                                    {attachments.map((item) => (
                                        <div
                                            key={item.uid}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '6px 10px',
                                                border: '1px solid #f0f0f0',
                                                borderRadius: 8,
                                            }}
                                        >
                                            <PaperClipOutlined style={{ color: '#8c8c8c' }} />
                                            <Text ellipsis style={{ flex: 1, minWidth: 0 }}>{item.name}</Text>
                                            <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{formatBytes(item.size)}</Text>
                                            <Tooltip title="移除">
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    danger
                                                    icon={<DeleteOutlined />}
                                                    aria-label={`移除 ${item.name}`}
                                                    onClick={() => removeAttachment(item.uid)}
                                                />
                                            </Tooltip>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Form.Item>
                    </Form>
                </Card>

                <div className="gx-compose-side">
                    {summaryCard}
                </div>
            </div>

            {/* 窄屏：底部固定发送栏 */}
            <div className="gx-compose-bar">
                <Text type={overRecipientLimit ? 'danger' : 'secondary'} style={{ fontSize: 12, minWidth: 0 }} ellipsis>
                    收件人 {recipientCount}{attachments.length > 0 ? ` · 附件 ${attachments.length}` : ''}
                </Text>
                <Button
                    type="primary"
                    icon={<SendOutlined />}
                    loading={sending}
                    disabled={mode === 'POOL' && poolEmpty}
                    onClick={() => void handleSend()}
                >
                    发送
                </Button>
            </div>
        </div>
    );
};

export default ComposePage;
