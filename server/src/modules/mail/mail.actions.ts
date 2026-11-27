export const MAIL_LOG_ACTIONS = {
    GET_EMAIL: 'get_email',
    MAIL_NEW: 'mail_new',
    MAIL_TEXT: 'mail_text',
    MAIL_ALL: 'mail_all',
    PROCESS_MAILBOX: 'process_mailbox',
    LIST_EMAILS: 'list_emails',
    POOL_STATS: 'pool_stats',
    POOL_RESET: 'pool_reset',
    WAIT_CODE: 'wait_code',
    CLAIM_EMAIL: 'claim_email',
    COMPLETE_EMAIL: 'complete_email',
    RELEASE_EMAIL: 'release_email',
    SEND_MAIL: 'send_mail',
    SEND_READ: 'send_read',
} as const;

/**
 * 必须在 API Key 权限中显式勾选才可调用的 action（未配置权限的 Key 也不允许）。
 * 发信风险高于收信，因此不跟随"未配置即全部允许"的规则。
 */
export const EXPLICIT_PERMISSION_ACTIONS: ReadonlySet<string> = new Set([
    MAIL_LOG_ACTIONS.SEND_MAIL,
    MAIL_LOG_ACTIONS.SEND_READ,
]);

export type MailLogAction = typeof MAIL_LOG_ACTIONS[keyof typeof MAIL_LOG_ACTIONS];

