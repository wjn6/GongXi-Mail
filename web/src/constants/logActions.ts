export const LOG_ACTIONS = {
    GET_EMAIL: 'get_email',
    MAIL_NEW: 'mail_new',
    MAIL_TEXT: 'mail_text',
    MAIL_ALL: 'mail_all',
    PROCESS_MAILBOX: 'process_mailbox',
    LIST_EMAILS: 'list_emails',
    POOL_STATS: 'pool_stats',
    POOL_RESET: 'pool_reset',
} as const;

export type LogAction = typeof LOG_ACTIONS[keyof typeof LOG_ACTIONS];

const LEGACY_ACTION_ALIASES: Record<string, LogAction> = {
    'process-mailbox': LOG_ACTIONS.PROCESS_MAILBOX,
    emails: LOG_ACTIONS.LIST_EMAILS,
};

export const LOG_ACTION_LABELS: Record<LogAction, string> = {
    [LOG_ACTIONS.GET_EMAIL]: '分配邮箱',
    [LOG_ACTIONS.MAIL_NEW]: '获取最新邮件',
    [LOG_ACTIONS.MAIL_TEXT]: '获取邮件文本',
    [LOG_ACTIONS.MAIL_ALL]: '获取所有邮件',
    [LOG_ACTIONS.PROCESS_MAILBOX]: '清空邮箱',
    [LOG_ACTIONS.LIST_EMAILS]: '获取邮箱列表',
    [LOG_ACTIONS.POOL_STATS]: '邮箱池统计',
    [LOG_ACTIONS.POOL_RESET]: '重置邮箱池',
};

export const LOG_ACTION_COLORS: Record<LogAction, string> = {
    [LOG_ACTIONS.GET_EMAIL]: 'cyan',
    [LOG_ACTIONS.MAIL_NEW]: 'processing',
    [LOG_ACTIONS.MAIL_TEXT]: 'geekblue',
    [LOG_ACTIONS.MAIL_ALL]: 'processing',
    [LOG_ACTIONS.PROCESS_MAILBOX]: 'error',
    [LOG_ACTIONS.LIST_EMAILS]: 'default',
    [LOG_ACTIONS.POOL_STATS]: 'default',
    [LOG_ACTIONS.POOL_RESET]: 'warning',
};

export const LOG_ACTION_OPTIONS: Array<{ value: LogAction; label: string }> = [
    { value: LOG_ACTIONS.GET_EMAIL, label: LOG_ACTION_LABELS[LOG_ACTIONS.GET_EMAIL] },
    { value: LOG_ACTIONS.MAIL_NEW, label: LOG_ACTION_LABELS[LOG_ACTIONS.MAIL_NEW] },
    { value: LOG_ACTIONS.MAIL_TEXT, label: LOG_ACTION_LABELS[LOG_ACTIONS.MAIL_TEXT] },
    { value: LOG_ACTIONS.MAIL_ALL, label: LOG_ACTION_LABELS[LOG_ACTIONS.MAIL_ALL] },
    { value: LOG_ACTIONS.PROCESS_MAILBOX, label: LOG_ACTION_LABELS[LOG_ACTIONS.PROCESS_MAILBOX] },
    { value: LOG_ACTIONS.LIST_EMAILS, label: LOG_ACTION_LABELS[LOG_ACTIONS.LIST_EMAILS] },
    { value: LOG_ACTIONS.POOL_STATS, label: LOG_ACTION_LABELS[LOG_ACTIONS.POOL_STATS] },
    { value: LOG_ACTIONS.POOL_RESET, label: LOG_ACTION_LABELS[LOG_ACTIONS.POOL_RESET] },
];

export function normalizeLogAction(action: string): LogAction | undefined {
    if (action in LOG_ACTION_LABELS) {
        return action as LogAction;
    }
    return LEGACY_ACTION_ALIASES[action];
}

export function getLogActionLabel(action: string): string {
    const normalizedAction = normalizeLogAction(action);
    if (!normalizedAction) {
        return action;
    }
    return LOG_ACTION_LABELS[normalizedAction];
}

export function getLogActionColor(action: string): string {
    const normalizedAction = normalizeLogAction(action);
    if (!normalizedAction) {
        return 'default';
    }
    return LOG_ACTION_COLORS[normalizedAction];
}

