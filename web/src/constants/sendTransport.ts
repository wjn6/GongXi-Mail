/**
 * 发信通道（分组设置）与发信记录中的实际通道。与 server/src/lib/smtp-send.ts 对应。
 */
export type SendTransportValue = 'AUTO' | 'GRAPH' | 'SMTP';
export type SendCapabilityValue = 'UNKNOWN' | 'ALLOWED' | 'DENIED';

export const SEND_TRANSPORT_OPTIONS: Array<{ value: SendTransportValue; label: string }> = [
    { value: 'AUTO', label: '自动（填了发件人名称走 SMTP，否则走 Graph，互为备用）' },
    { value: 'GRAPH', label: '仅 Graph（发件人名称会被微软忽略）' },
    { value: 'SMTP', label: '仅 SMTP（需要 SMTP.Send 权限且邮箱开启 SMTP 认证）' },
];

export const SEND_TRANSPORT_LABELS: Record<SendTransportValue, string> = {
    AUTO: '自动',
    GRAPH: '仅 Graph',
    SMTP: '仅 SMTP',
};

/** 发信记录 transport 字段 */
export const TRANSPORT_USED_META: Record<string, { label: string; color: string; tip: string }> = {
    GRAPH: { label: 'Graph', color: 'blue', tip: '通过 Microsoft Graph 发出；自定义发件人名称不生效' },
    SMTP: { label: 'SMTP', color: 'cyan', tip: '通过 Outlook SMTP 发出；保留发件人名称' },
    GRAPH_FALLBACK: { label: 'Graph（备用）', color: 'orange', tip: 'SMTP 不可用，已改用 Graph 发出；发件人名称不会生效' },
};

/** 账号在分组发信通道下的有效发信能力：AUTO 下任一通道可用即可用 */
export function effectiveSendCapability(
    mode: SendTransportValue | null | undefined,
    graph: SendCapabilityValue | null | undefined,
    smtp: SendCapabilityValue | null | undefined
): SendCapabilityValue {
    const g = graph ?? 'UNKNOWN';
    const s = smtp ?? 'UNKNOWN';
    if (mode === 'GRAPH') return g;
    if (mode === 'SMTP') return s;
    if (g === 'ALLOWED' || s === 'ALLOWED') return 'ALLOWED';
    if (g === 'DENIED' && s === 'DENIED') return 'DENIED';
    return 'UNKNOWN';
}
