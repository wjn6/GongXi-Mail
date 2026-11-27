import { emailService } from '../email/email.service.js';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { setCache, getCache, deleteCache } from '../../lib/redis.js';
import { hasMailSendScope } from '../../lib/send-mail.js';
import { encrypt } from '../../lib/crypto.js';
import { exchangeRefreshToken, normalizeOAuthTenant } from '../../lib/ms-oauth.js';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { SMTP_PORT, SMTP_SEND_SCOPE, hasSmtpSendScope, smtpHostFor } from '../../lib/smtp-send.js';
import {
    combineFetchFailures,
    fetchFailureFromError,
    formatOAuthFailure,
    tokenFailureToFetchFailure,
    type FetchFailure,
    type FetchMethod,
    type OAuthFailure,
} from '../../lib/oauth-error.js';

type TokenAttempt<T> = ({ ok: true } & T) | { ok: false; failure: OAuthFailure };

function toAppError(failure: FetchFailure | ReturnType<typeof combineFetchFailures>): AppError {
    return new AppError(failure.code, failure.message, failure.statusCode, 'details' in failure ? failure.details : undefined);
}
import { proxyFetch } from '../../lib/proxy.js';
import prisma from '../../lib/prisma.js';
import Imap from 'node-imap';
import { simpleParser, type ParsedMail, type Source } from 'mailparser';

type MailFetchStrategy = 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY';

interface Credentials {
    id: number;
    email: string;
    clientId: string;
    refreshToken: string;
    autoAssigned: boolean;
    fetchStrategy?: MailFetchStrategy;
    /** 分组的微软登录端点，未设置时为 CONSUMERS */
    oauthTenant?: string | null;
    /** 单独用于 IMAP / SMTP 的凭据（已解密）；为空时使用主凭据 */
    imapClientId?: string | null;
    imapRefreshToken?: string | null;
}

type CredentialSlot = 'main' | 'imap';

/** 是否配置了与主凭据不同的 IMAP 凭据 */
export function hasSeparateImapCredentials(credentials: Pick<Credentials, 'clientId' | 'refreshToken' | 'imapClientId' | 'imapRefreshToken'>): boolean {
    return !!credentials.imapClientId && !!credentials.imapRefreshToken
        && !(credentials.imapClientId === credentials.clientId && credentials.imapRefreshToken === credentials.refreshToken);
}

function credentialPair(credentials: Credentials, slot: CredentialSlot): { clientId: string; refreshToken: string } {
    return slot === 'imap' && hasSeparateImapCredentials(credentials)
        ? { clientId: credentials.imapClientId!, refreshToken: credentials.imapRefreshToken! }
        : { clientId: credentials.clientId, refreshToken: credentials.refreshToken };
}

/**
 * 微软换取访问令牌时会轮换 refresh token：保存新的，避免旧令牌过期后整个账号失效。
 * 失败只记日志，不影响本次收信 / 发信。
 */
async function persistRotatedRefreshToken(credentials: Credentials, newToken: string | null, slot: CredentialSlot = 'main') {
    const useImap = slot === 'imap' && hasSeparateImapCredentials(credentials);
    const current = useImap ? credentials.imapRefreshToken : credentials.refreshToken;
    if (!newToken || newToken === current || !credentials.id) {
        return;
    }
    try {
        await prisma.emailAccount.update({
            where: { id: credentials.id },
            data: useImap
                ? { imapRefreshToken: encrypt(newToken), tokenRefreshedAt: new Date() }
                : { refreshToken: encrypt(newToken), tokenRefreshedAt: new Date() },
        });
        if (useImap) {
            credentials.imapRefreshToken = newToken;
        } else {
            credentials.refreshToken = newToken;
        }
    } catch (err) {
        logger.warn({ err, email: credentials.email }, 'Failed to persist rotated refresh token');
    }
}

interface EmailMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}


interface GraphMessage {
    id?: string;
    from?: {
        emailAddress?: {
            address?: string;
        };
    };
    subject?: string;
    bodyPreview?: string;
    body?: {
        content?: string;
    };
    createdDateTime?: string;
    receivedDateTime?: string;
}

interface GraphMessagesResponse {
    value?: GraphMessage[];
}

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
        return 'Unknown error';
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() ? message : 'Unknown error';
}

const IMAP_TIMEOUT_MS = 15_000;
const IMAP_HARD_TIMEOUT_MS = 60_000;
const IMAP_HOST = 'outlook.office365.com';

export const mailService = {
    /**
     * 更新邮箱状态
     */
    async updateEmailStatus(emailId: number, success: boolean, errorMessage?: string) {
        await emailService.updateStatus(
            emailId,
            success ? 'ACTIVE' : 'ERROR',
            errorMessage
        );
    },

    /**
     * 记录 API 调用
     */
    async logApiCall(
        action: string,
        apiKeyId: number | undefined,
        emailAccountId: number | undefined,
        requestIp: string,
        responseCode: number,
        responseTimeMs: number,
        requestId?: string
    ) {
        try {
            await prisma.apiLog.create({
                data: {
                    action,
                    apiKeyId,
                    emailAccountId,
                    requestIp,
                    responseCode,
                    responseTimeMs,
                    metadata: requestId ? { requestId } : undefined,
                },
            });
        } catch (err) {
            logger.error({ err }, 'Failed to log API call');
        }
    },

    /**
     * 获取 Microsoft Graph API Access Token
     */
    async getGraphAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<TokenAttempt<{ accessToken: string; hasMailRead: boolean }>> {
        const cacheKey = `graph_api_access_token_${credentials.email}`;

        // 尝试从缓存获取（缓存的 token 一定有 Mail.Read 权限）
        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached Graph API token');
            return { ok: true, accessToken: cachedToken, hasMailRead: true };
        }

        const result = await exchangeRefreshToken({
            clientId: credentials.clientId,
            refreshToken: credentials.refreshToken,
            tenant: credentials.oauthTenant,
            scope: 'https://graph.microsoft.com/.default',
            proxyConfig,
        });
        if (!result.ok) {
            logger.error({ email: credentials.email, tenant: normalizeOAuthTenant(credentials.oauthTenant), kind: result.failure.kind, aadsts: result.failure.aadsts, error: result.failure.description }, 'Graph API token request failed');
            return result;
        }
        await persistRotatedRefreshToken(credentials, result.refreshToken);

        // 检查是否有邮件读取权限
        const hasMailRead = result.scope.includes('https://graph.microsoft.com/Mail.Read');
        if (hasMailRead) {
            // 只有有 Mail.Read 权限时才缓存
            await setCache(cacheKey, result.accessToken, Math.max(result.expiresIn - 60, 60));
        } else {
            logger.warn({ email: credentials.email }, 'No Mail.Read scope in token, will fallback to IMAP');
        }

        return { ok: true, accessToken: result.accessToken, hasMailRead };
    },

    /**
     * 获取用于发信的 Graph Access Token，并返回是否包含 Mail.Send 权限。
     * 只有包含 Mail.Send 时才缓存；force 为 true 时跳过缓存（用于检测发信权限）。
     */
    async getGraphSendToken(
        credentials: Credentials,
        options: { force?: boolean; proxyConfig?: { socks5?: string; http?: string } } = {}
    ): Promise<{ accessToken: string; hasMailSend: boolean; scope: string } | { error: string }> {
        const cacheKey = `graph_send_token_${credentials.email}`;
        if (!options.force) {
            const cached = await getCache(cacheKey);
            if (cached) {
                return { accessToken: cached, hasMailSend: true, scope: 'Mail.Send' };
            }
        }

        const result = await exchangeRefreshToken({
            clientId: credentials.clientId,
            refreshToken: credentials.refreshToken,
            tenant: credentials.oauthTenant,
            scope: 'https://graph.microsoft.com/.default',
            proxyConfig: options.proxyConfig,
        });
        if (!result.ok) {
            logger.warn({ email: credentials.email, tenant: normalizeOAuthTenant(credentials.oauthTenant), kind: result.failure.kind, aadsts: result.failure.aadsts }, 'Graph send token request failed');
            return { error: formatOAuthFailure(result.failure).slice(0, 400) };
        }
        await persistRotatedRefreshToken(credentials, result.refreshToken);

        const hasMailSend = hasMailSendScope(result.scope);
        if (hasMailSend) {
            await setCache(cacheKey, result.accessToken, Math.max(result.expiresIn - 60, 60));
        }
        return { accessToken: result.accessToken, hasMailSend, scope: result.scope };
    },

    async clearGraphSendToken(email: string) {
        await deleteCache(`graph_send_token_${email}`);
    },

    /**
     * 获取用于 SMTP（XOAUTH2）发信的 Outlook 令牌，并返回是否包含 SMTP.Send 权限。
     * 只有包含 SMTP.Send 时才缓存；force 为 true 时跳过缓存。
     */
    async getSmtpSendToken(
        credentials: Credentials,
        options: { force?: boolean } = {}
    ): Promise<{ accessToken: string; hasSmtpSend: boolean; scope: string } | { error: string }> {
        const cacheKey = `smtp_send_token_${credentials.email}`;
        if (!options.force) {
            const cached = await getCache(cacheKey);
            if (cached) {
                return { accessToken: cached, hasSmtpSend: true, scope: 'SMTP.Send' };
            }
        }

        // SMTP 与 IMAP 同属 outlook.office.com：有独立 IMAP 凭据时先用它，拿不到 SMTP.Send 再试主凭据
        const slots: CredentialSlot[] = hasSeparateImapCredentials(credentials) ? ['imap', 'main'] : ['main'];
        let fallback: { accessToken: string; hasSmtpSend: boolean; scope: string } | null = null;
        let lastError = '';
        for (const slot of slots) {
            const pair = credentialPair(credentials, slot);
            const result = await exchangeRefreshToken({
                clientId: pair.clientId,
                refreshToken: pair.refreshToken,
                tenant: credentials.oauthTenant,
                scope: SMTP_SEND_SCOPE,
            });
            if (!result.ok) {
                logger.warn({ email: credentials.email, slot, tenant: normalizeOAuthTenant(credentials.oauthTenant), kind: result.failure.kind, aadsts: result.failure.aadsts }, 'SMTP send token request failed');
                lastError = formatOAuthFailure(result.failure).slice(0, 400);
                continue;
            }
            await persistRotatedRefreshToken(credentials, result.refreshToken, slot);

            const hasSmtpSend = hasSmtpSendScope(result.scope);
            if (hasSmtpSend) {
                await setCache(cacheKey, result.accessToken, Math.max(result.expiresIn - 60, 60));
                return { accessToken: result.accessToken, hasSmtpSend, scope: result.scope };
            }
            fallback = fallback ?? { accessToken: result.accessToken, hasSmtpSend, scope: result.scope };
        }
        return fallback ?? { error: lastError || 'Failed to get SMTP access token' };
    },

    async clearSmtpSendToken(email: string) {
        await deleteCache(`smtp_send_token_${email}`);
    },

    /**
     * 通过 Outlook SMTP（587 + STARTTLS + XOAUTH2）发信；verifyOnly 时只连接并认证，不发信（用于检测）。
     * 成功表示 SMTP 服务器已接收（不代表已送达）。
     */
    async sendMailViaSmtp(
        accessToken: string,
        account: { email: string; oauthTenant?: string | null },
        message: SendMailOptions | null
    ): Promise<{ ok: true; messageId: string | null } | { ok: false; error: unknown }> {
        const transporter = nodemailer.createTransport({
            host: smtpHostFor(account.oauthTenant),
            port: SMTP_PORT,
            secure: false,
            requireTLS: true,
            auth: { type: 'OAuth2', user: account.email, accessToken },
            connectionTimeout: 20_000,
            greetingTimeout: 20_000,
            socketTimeout: 60_000,
            disableFileAccess: true,
            disableUrlAccess: true,
        });
        try {
            if (!message) {
                await transporter.verify();
                return { ok: true, messageId: null };
            }
            const info = await transporter.sendMail(message);
            return { ok: true, messageId: typeof info.messageId === 'string' ? info.messageId : null };
        } catch (err) {
            return { ok: false, error: err };
        } finally {
            transporter.close();
        }
    },

    /**
     * 通过 Graph POST /me/sendMail 发信。成功为 202 Accepted（不代表已送达）。
     */
    async sendMailViaGraph(
        accessToken: string,
        payload: unknown,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<{ ok: true } | { ok: false; status: number; bodyText: string; retryAfter: string | null }> {
        try {
            const response = await proxyFetch(
                'https://graph.microsoft.com/v1.0/me/sendMail',
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                },
                proxyConfig
            );
            if (response.status === 202 || response.ok) {
                await response.text().catch(() => '');
                return { ok: true };
            }
            const bodyText = await response.text().catch(() => '');
            return { ok: false, status: response.status, bodyText, retryAfter: response.headers.get('retry-after') };
        } catch (err) {
            logger.error({ err }, 'Graph sendMail request failed');
            return { ok: false, status: 0, bodyText: getErrorMessage(err), retryAfter: null };
        }
    },

    /**
     * 使用 Graph API 获取邮件
     */
    async getEmailsViaGraphApi(
        accessToken: string,
        mailbox: string,
        limit: number = 100,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<EmailMessage[]> {
        // 转换邮箱名称
        let folder = 'inbox';
        if (mailbox?.toLowerCase() === 'junk') {
            folder = 'junkemail';
        } else if (mailbox?.toLowerCase() === 'inbox') {
            folder = 'inbox';
        }

        try {
            const response = await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=receivedDateTime desc`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Graph API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as GraphMessagesResponse;
            const emails = Array.isArray(data.value) ? data.value : [];

            return emails.map((item: GraphMessage, index: number) => ({
                id: item.id || `graph_${Date.now()}_${index}`,
                from: item.from?.emailAddress?.address || '',
                subject: item.subject || '',
                text: item.bodyPreview || '',
                html: item.body?.content || '',
                date: item.receivedDateTime || item.createdDateTime || '',
            }));
        } catch (err) {
            logger.error({ err }, 'Failed to fetch emails via Graph API');
            throw err;
        }
    },

    /**
     * 获取 IMAP Access Token (不带 scope)
     */
    async getImapAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<TokenAttempt<{ accessToken: string }>> {
        const cacheKey = `imap_api_access_token_${credentials.email}`;

        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached IMAP token');
            return { ok: true, accessToken: cachedToken };
        }

        // 注意：IMAP 不需要 scope，按授权时的权限签发；配置了独立 IMAP 凭据时用它
        const slot: CredentialSlot = hasSeparateImapCredentials(credentials) ? 'imap' : 'main';
        const pair = credentialPair(credentials, slot);
        const result = await exchangeRefreshToken({
            clientId: pair.clientId,
            refreshToken: pair.refreshToken,
            tenant: credentials.oauthTenant,
            proxyConfig,
        });
        if (!result.ok) {
            logger.error({ email: credentials.email, slot, tenant: normalizeOAuthTenant(credentials.oauthTenant), kind: result.failure.kind, aadsts: result.failure.aadsts, error: result.failure.description }, 'IMAP token request failed');
            return result;
        }
        await persistRotatedRefreshToken(credentials, result.refreshToken, slot);

        await setCache(cacheKey, result.accessToken, Math.max(result.expiresIn - 60, 60));
        return { ok: true, accessToken: result.accessToken };
    },

    /**
     * 生成 IMAP XOAUTH2 认证字符串
     */
    generateAuthString(email: string, accessToken: string): string {
        const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
        return Buffer.from(authString).toString('base64');
    },

    /**
     * 使用 IMAP 获取邮件
     */
    async getEmailsViaImap(
        email: string,
        authString: string,
        mailbox: string = 'INBOX',
        limit: number = 100
    ): Promise<EmailMessage[]> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(hardTimer);
                fn();
            };
            const settleResolve = (messages: EmailMessage[]) => settle(() => resolve(messages));
            const settleReject = (err: unknown) => settle(() => reject(err));

            const imapConfig: ConstructorParameters<typeof Imap>[0] = {
                user: email,
                password: '',
                xoauth2: authString,
                host: IMAP_HOST,
                port: 993,
                tls: true,
                connTimeout: IMAP_TIMEOUT_MS,
                authTimeout: IMAP_TIMEOUT_MS,
                tlsOptions: {
                    servername: IMAP_HOST,
                },
            };
            const imap = new Imap(imapConfig);

            const hardTimer = setTimeout(() => {
                logger.error({ email }, 'IMAP fetch timed out');
                imap.end();
                settleReject(new Error('IMAP fetch timed out'));
            }, IMAP_HARD_TIMEOUT_MS);

            const emailList: EmailMessage[] = [];
            let fetchEnded = false;
            let pendingParses = 0;

            const maybeFinish = () => {
                if (fetchEnded && pendingParses === 0) {
                    imap.end();
                }
            };

            imap.once('ready', async () => {
                try {
                    await new Promise<void>((res, rej) => {
                        // IMAP 中除 INBOX 外文件夹名区分大小写，Outlook 垃圾箱为 "Junk"
                        const boxName = mailbox?.toLowerCase() === 'junk' ? 'Junk' : mailbox?.toLowerCase() === 'inbox' ? 'INBOX' : mailbox;
                        imap.openBox(boxName, true, (err) => {
                            if (err) return rej(err);
                            res();
                        });
                    });

                    imap.search(['ALL'], (err: Error | null, results: number[]) => {
                        if (err) {
                            imap.end();
                            return settleReject(err);
                        }

                        if (!results || results.length === 0) {
                            imap.end();
                            return settleResolve([]);
                        }

                        // 限制返回数量
                        const limitedResults = results.slice(-limit);

                        const f = imap.fetch(limitedResults, { bodies: '' });

                        f.on('message', (msg) => {
                            msg.on('body', (stream) => {
                                pendingParses += 1;
                                simpleParser(stream as unknown as Source)
                                    .then((mail: ParsedMail) => {
                                        const html = typeof mail.html === 'string' ? mail.html : '';
                                        emailList.push({
                                            id: `imap_${Date.now()}_${emailList.length}`,
                                            from: mail.from?.text || '',
                                            subject: mail.subject || '',
                                            text: mail.text || '',
                                            html,
                                            date: mail.date?.toISOString() || '',
                                        });
                                    })
                                    .catch((parseErr: Error) => {
                                        logger.error({ parseErr }, 'Error parsing email');
                                    })
                                    .finally(() => {
                                        pendingParses -= 1;
                                        maybeFinish();
                                    });
                            });
                        });

                        f.once('error', (fetchErr: Error) => {
                            logger.error({ fetchErr }, 'IMAP fetch error');
                            settleReject(fetchErr);
                            imap.end();
                        });

                        f.once('end', () => {
                            fetchEnded = true;
                            maybeFinish();
                        });
                    });
                } catch (err) {
                    imap.end();
                    settleReject(err);
                }
            });

            imap.once('error', (err: Error) => {
                logger.error({ err }, 'IMAP connection error');
                settleReject(err);
            });

            imap.once('end', () => {
                logger.debug({ email }, 'IMAP connection ended');
                // 按日期降序排序（最新的在前面）
                emailList.sort((a: EmailMessage, b: EmailMessage) => {
                    const dateA = a.date ? new Date(a.date).getTime() : 0;
                    const dateB = b.date ? new Date(b.date).getTime() : 0;
                    return dateB - dateA;
                });
                settleResolve(emailList);
            });

            imap.connect();
        });
    },

    /**
     * 获取邮件（主入口）- 支持 Graph API 和 IMAP 回退
     */
    async getEmails(
        credentials: Credentials,
        options: { mailbox: string; limit?: number; socks5?: string; http?: string }
    ) {
        const proxyConfig = { socks5: options.socks5, http: options.http };
        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        const limit = options.limit || 100;

        const fetchViaGraph = async () => {
            const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);
            if (!tokenResult.ok) {
                throw toAppError(tokenFailureToFetchFailure('graph', tokenResult.failure));
            }
            if (!tokenResult.hasMailRead) {
                throw new AppError('GRAPH_SCOPE_MISSING', 'Graph token missing Mail.Read scope', 502);
            }

            logger.info({ email: credentials.email, strategy }, 'Using Graph API for email retrieval');
            let messages: EmailMessage[];
            try {
                messages = await this.getEmailsViaGraphApi(
                    tokenResult.accessToken,
                    options.mailbox,
                    limit,
                    proxyConfig
                );
            } catch (err) {
                throw toAppError(fetchFailureFromError('graph', err));
            }

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                count: messages.length,
                messages,
                method: 'graph_api',
            };
        };

        const fetchViaImap = async () => {
            logger.info({ email: credentials.email, strategy }, 'Using IMAP for email retrieval');
            const imapToken = await this.getImapAccessToken(credentials, proxyConfig);
            if (!imapToken.ok) {
                throw toAppError(tokenFailureToFetchFailure('imap', imapToken.failure));
            }

            const authString = this.generateAuthString(credentials.email, imapToken.accessToken);
            let messages: EmailMessage[];
            try {
                messages = await this.getEmailsViaImap(
                    credentials.email,
                    authString,
                    options.mailbox,
                    limit
                );
            } catch (err) {
                throw toAppError(fetchFailureFromError('imap', err));
            }

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                count: messages.length,
                messages,
                method: 'imap',
            };
        };

        if (strategy === 'GRAPH_ONLY') {
            return fetchViaGraph();
        }

        if (strategy === 'IMAP_ONLY') {
            return fetchViaImap();
        }

        // 主路径失败后回退；两条都失败时合并两边的原因，不只报最后一个
        const withFallback = async <T>(
            primaryMethod: FetchMethod,
            primary: () => Promise<T>,
            fallbackMethod: FetchMethod,
            fallback: () => Promise<T>
        ): Promise<T> => {
            let primaryErr: unknown;
            try {
                return await primary();
            } catch (err) {
                primaryErr = err;
                logger.warn({ err, email: credentials.email, strategy }, `${primaryMethod} failed, fallback to ${fallbackMethod}`);
            }
            try {
                return await fallback();
            } catch (fallbackErr) {
                throw toAppError(combineFetchFailures(
                    fetchFailureFromError(primaryMethod, primaryErr),
                    fetchFailureFromError(fallbackMethod, fallbackErr)
                ));
            }
        };

        if (strategy === 'IMAP_FIRST') {
            return withFallback('imap', fetchViaImap, 'graph', fetchViaGraph);
        }

        return withFallback('graph', fetchViaGraph, 'imap', fetchViaImap);
    },

    /**
     * 清空邮箱（通过 Graph API 删除所有邮件）
     */
    async processMailbox(
        credentials: Credentials,
        options: { mailbox: string; socks5?: string; http?: string }
    ) {
        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        if (strategy === 'IMAP_ONLY') {
            throw new AppError(
                'MAILBOX_CLEAR_UNSUPPORTED',
                'Mailbox clear is not available for IMAP_ONLY strategy',
                400
            );
        }

        logger.info({ email: credentials.email, mailbox: options.mailbox }, 'Processing mailbox via Graph API');

        const proxyConfig = { socks5: options.socks5, http: options.http };
        const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);

        if (!tokenResult.ok) {
            throw toAppError(tokenFailureToFetchFailure('graph', tokenResult.failure, { code: 'GRAPH_API_FAILED', statusCode: 500 }));
        }

        // 1. 获取所有邮件 ID
        let page = 0;
        let deletedCount = 0;
        let hasMore = true;

        try {
            while (hasMore && page < 10) { // 限制最大页数防止超时
                const messages = await this.getEmailsViaGraphApi(
                    tokenResult.accessToken,
                    options.mailbox,
                    500, // 每次取 500
                    proxyConfig
                );

                if (messages.length === 0) {
                    hasMore = false;
                    break;
                }

                // 2. 批量删除（Graph API 不支持批量删除，只能并发逐个删除）
                // 限制并发数为 10
                const batchSize = 10;
                for (let i = 0; i < messages.length; i += batchSize) {
                    const chunk = messages.slice(i, i + batchSize);
                    const results = await Promise.all(chunk.map(msg =>
                        this.deleteMessageViaGraphApi(tokenResult.accessToken, msg.id, proxyConfig)
                    ));
                    deletedCount += results.filter(Boolean).length;
                }

                page++;
            }

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Successfully deleted ${deletedCount} messages`,
                status: 'success',
                deletedCount,
            };

        } catch (err: unknown) {
            logger.error({ err, email: credentials.email }, 'Error processing mailbox');
            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Partial success or error: ${getErrorMessage(err)}`,
                status: 'error',
                deletedCount,
            };
        }
    },

    /**
     * 单个删除邮件，返回是否删除成功
     */
    async deleteMessageViaGraphApi(
        accessToken: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<boolean> {
        try {
            const response = await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                    },
                },
                proxyConfig
            );
            return response.ok;
        } catch (_err) {
            logger.warn({ messageId }, 'Failed to delete message');
            return false;
        }
    },
};

