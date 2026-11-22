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
} as const;

export type MailLogAction = typeof MAIL_LOG_ACTIONS[keyof typeof MAIL_LOG_ACTIONS];

