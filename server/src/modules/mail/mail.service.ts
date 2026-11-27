import { emailService } from '../email/email.service.js';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { setCache, getCache, deleteCache } from '../../lib/redis.js';
import { hasMailSendScope } from '../../lib/send-mail.js';
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
}

interface EmailMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface OAuthTokenResponse {
    access_token?: string;
    expires_in?: number;
    scope?: string;
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
    ): Promise<{ accessToken: string; hasMailRead: boolean } | null> {
        const cacheKey = `graph_api_access_token_${credentials.email}`;

        // 尝试从缓存获取（缓存的 token 一定有 Mail.Read 权限）
        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached Graph API token');
            return { accessToken: cachedToken, hasMailRead: true };
        }

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: credentials.clientId,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                        scope: 'https://graph.microsoft.com/.default',
                    }).toString(),
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error({ email: credentials.email, status: response.status, error: errorText }, 'Graph API token request failed');
                return null;
            }

            const data = await response.json() as OAuthTokenResponse;

            // 检查是否有邮件读取权限
            const scopeText = typeof data.scope === 'string' ? data.scope : '';
            const hasMailRead = scopeText.includes('https://graph.microsoft.com/Mail.Read');
            const accessToken = typeof data.access_token === 'string' ? data.access_token : null;

            if (!accessToken) {
                logger.warn({ email: credentials.email }, 'Graph API token missing access_token');
                return null;
            }

            if (hasMailRead) {
                // 只有有 Mail.Read 权限时才缓存
                const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
                await setCache(cacheKey, accessToken, expireTime);
            } else {
                logger.warn({ email: credentials.email }, 'No Mail.Read scope in token, will fallback to IMAP');
            }

            return { accessToken, hasMailRead };
        } catch (err) {
            logger.error({ err, email: credentials.email }, 'Failed to get Graph API token');
            return null;
        }
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

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: credentials.clientId,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                        scope: 'https://graph.microsoft.com/.default',
                    }).toString(),
                },
                options.proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                let message = `HTTP ${response.status}`;
                try {
                    const parsed = JSON.parse(errorText) as { error_description?: string; error?: string };
                    message = parsed.error_description || parsed.error || message;
                } catch {
                    message = errorText.slice(0, 200) || message;
                }
                logger.warn({ email: credentials.email, status: response.status }, 'Graph send token request failed');
                return { error: message.slice(0, 300) };
            }

            const data = await response.json() as OAuthTokenResponse;
            const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
            if (!accessToken) {
                return { error: 'Token response missing access_token' };
            }
            const scope = typeof data.scope === 'string' ? data.scope : '';
            const hasMailSend = hasMailSendScope(scope);
            if (hasMailSend) {
                const expireTime = (typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60;
                await setCache(cacheKey, accessToken, Math.max(expireTime, 60));
            }
            return { accessToken, hasMailSend, scope };
        } catch (err) {
            logger.error({ err, email: credentials.email }, 'Failed to get Graph send token');
            return { error: getErrorMessage(err).slice(0, 300) };
        }
    },

    async clearGraphSendToken(email: string) {
        await deleteCache(`graph_send_token_${email}`);
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
    ): Promise<string | null> {
        const cacheKey = `imap_api_access_token_${credentials.email}`;

        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached IMAP token');
            return cachedToken;
        }

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: credentials.clientId,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                        // 注意：IMAP 不需要 scope
                    }).toString(),
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error({ email: credentials.email, status: response.status, error: errorText }, 'IMAP token request failed');
                return null;
            }

            const data = await response.json() as OAuthTokenResponse;
            const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
            if (!accessToken) {
                logger.warn({ email: credentials.email }, 'IMAP token missing access_token');
                return null;
            }

            const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
            await setCache(cacheKey, accessToken, expireTime);

            return accessToken;
        } catch (err) {
            logger.error({ err, email: credentials.email }, 'Failed to get IMAP token');
            return null;
        }
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
            if (!tokenResult) {
                throw new AppError('GRAPH_TOKEN_FAILED', 'Failed to get Graph API access token', 502);
            }
            if (!tokenResult.hasMailRead) {
                throw new AppError('GRAPH_SCOPE_MISSING', 'Graph token missing Mail.Read scope', 502);
            }

            logger.info({ email: credentials.email, strategy }, 'Using Graph API for email retrieval');
            const messages = await this.getEmailsViaGraphApi(
                tokenResult.accessToken,
                options.mailbox,
                limit,
                proxyConfig
            );

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
            if (!imapToken) {
                throw new AppError('IMAP_TOKEN_FAILED', 'Failed to get IMAP access token', 502);
            }

            const authString = this.generateAuthString(credentials.email, imapToken);
            const messages = await this.getEmailsViaImap(
                credentials.email,
                authString,
                options.mailbox,
                limit
            );

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

        if (strategy === 'IMAP_FIRST') {
            try {
                return await fetchViaImap();
            } catch (imapErr) {
                logger.warn({ imapErr, email: credentials.email }, 'IMAP failed, fallback to Graph API');
                return fetchViaGraph();
            }
        }

        try {
            return await fetchViaGraph();
        } catch (graphErr) {
            logger.warn({ graphErr, email: credentials.email }, 'Graph API failed, fallback to IMAP');
            return fetchViaImap();
        }
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

        if (!tokenResult) {
            throw new AppError('GRAPH_API_FAILED', 'Failed to get access token', 500);
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
