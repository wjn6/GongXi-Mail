import { emailService } from '../email/email.service.js';
import { poolService } from './pool.service.js';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { setCache, getCache } from '../../lib/redis.js';
import { proxyFetch } from '../../lib/proxy.js';
import prisma from '../../lib/prisma.js';
import type { MailRequestInput } from './mail.schema.js';
import Imap from 'node-imap';
import { simpleParser, type ParsedMail, type Source } from 'mailparser';

interface Credentials {
    id: number;
    email: string;
    clientId: string;
    refreshToken: string;
    autoAssigned: boolean;
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

export const mailService = {
    /**
     * 解析凭证
     */
    async resolveCredentials(
        input: MailRequestInput,
        apiKeyId?: number
    ): Promise<Credentials> {
        const { email, auto } = input;

        // 自动分配模式
        if (!email && auto) {
            if (!apiKeyId) {
                throw new AppError('AUTH_REQUIRED', 'Auto assignment requires API Key authentication', 400);
            }

            const account = await poolService.getUnusedEmail(apiKeyId);
            if (!account) {
                const stats = await poolService.getStats(apiKeyId);
                throw new AppError(
                    'NO_UNUSED_EMAIL',
                    `No unused emails available. Used: ${stats.used}/${stats.total}`,
                    400
                );
            }

            return { ...account, autoAssigned: true };
        }

        // 必须提供邮箱
        if (!email) {
            throw new AppError('EMAIL_REQUIRED', 'Email is required. Set auto=true to auto-assign.', 400);
        }

        // 从数据库查询
        const account = await emailService.getByEmail(email);
        if (!account) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }

        return { ...account, autoAssigned: false };
    },

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
        responseTimeMs: number
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
                date: item.createdDateTime || '',
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
            const imapConfig: ConstructorParameters<typeof Imap>[0] = {
                user: email,
                password: '',
                xoauth2: authString,
                host: 'outlook.office365.com',
                port: 993,
                tls: true,
                tlsOptions: {
                    rejectUnauthorized: false,
                },
            };
            const imap = new Imap(imapConfig);

            const emailList: EmailMessage[] = [];
            let messageCount = 0;
            let processedCount = 0;

            imap.once('ready', async () => {
                try {
                    await new Promise<void>((res, rej) => {
                        imap.openBox(mailbox, true, (err) => {
                            if (err) return rej(err);
                            res();
                        });
                    });

                    imap.search(['ALL'], (err: Error | null, results: number[]) => {
                        if (err) {
                            imap.end();
                            return reject(err);
                        }

                        if (!results || results.length === 0) {
                            imap.end();
                            return resolve([]);
                        }

                        // 限制返回数量
                        const limitedResults = results.slice(-limit);
                        messageCount = limitedResults.length;

                        const f = imap.fetch(limitedResults, { bodies: '' });

                        f.on('message', (msg) => {
                            msg.on('body', (stream) => {
                                simpleParser(stream as unknown as Source)
                                    .then((mail: ParsedMail) => {
                                        const html = typeof mail.html === 'string' ? mail.html : '';
                                        emailList.push({
                                            id: `imap_${Date.now()}_${processedCount}`,
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
                                        processedCount++;
                                        if (processedCount === messageCount) {
                                            imap.end();
                                        }
                                    });
                            });
                        });

                        f.once('error', (fetchErr: Error) => {
                            logger.error({ fetchErr }, 'IMAP fetch error');
                            imap.end();
                            reject(fetchErr);
                        });

                        f.once('end', () => {
                            // 如果没有消息，直接结束
                            if (messageCount === 0) {
                                imap.end();
                            }
                        });
                    });
                } catch (err) {
                    imap.end();
                    reject(err);
                }
            });

            imap.once('error', (err: Error) => {
                logger.error({ err }, 'IMAP connection error');
                reject(err);
            });

            imap.once('end', () => {
                logger.debug({ email }, 'IMAP connection ended');
                // 按日期降序排序（最新的在前面）
                emailList.sort((a: EmailMessage, b: EmailMessage) => {
                    const dateA = a.date ? new Date(a.date).getTime() : 0;
                    const dateB = b.date ? new Date(b.date).getTime() : 0;
                    return dateB - dateA;
                });
                resolve(emailList);
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

        // 1. 尝试 Graph API
        const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);

        if (tokenResult && tokenResult.hasMailRead) {
            // Graph API 有权限，使用 Graph API
            logger.info({ email: credentials.email }, 'Using Graph API for email retrieval');
            try {
                const messages = await this.getEmailsViaGraphApi(
                    tokenResult.accessToken,
                    options.mailbox,
                    options.limit || 100,
                    proxyConfig
                );

                return {
                    email: credentials.email,
                    mailbox: options.mailbox,
                    count: messages.length,
                    messages,
                    method: 'graph_api',
                };
            } catch (graphErr) {
                logger.warn({ graphErr, email: credentials.email }, 'Graph API failed, trying IMAP fallback');
            }
        }

        // 2. 回退到 IMAP
        logger.info({ email: credentials.email }, 'Using IMAP fallback for email retrieval');
        const imapToken = await this.getImapAccessToken(credentials, proxyConfig);

        if (!imapToken) {
            throw new AppError('IMAP_TOKEN_FAILED', 'Failed to get IMAP access token', 500);
        }

        const authString = this.generateAuthString(credentials.email, imapToken);
        const messages = await this.getEmailsViaImap(
            credentials.email,
            authString,
            options.mailbox,
            options.limit || 100
        );

        return {
            email: credentials.email,
            mailbox: options.mailbox,
            count: messages.length,
            messages,
            method: 'imap',
        };
    },

    /**
     * 清空邮箱（通过 Graph API 删除所有邮件）
     */
    async processMailbox(
        credentials: Credentials,
        options: { mailbox: string; socks5?: string; http?: string }
    ) {
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
                    await Promise.all(chunk.map(msg =>
                        this.deleteMessageViaGraphApi(tokenResult.accessToken, msg.id, proxyConfig)
                    ));
                    deletedCount += chunk.length;
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
     * 单个删除邮件
     */
    async deleteMessageViaGraphApi(
        accessToken: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ) {
        try {
            await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                    },
                },
                proxyConfig
            );
        } catch (_err) {
            // 忽略删除错误，继续下一个
            logger.warn({ messageId }, 'Failed to delete message');
        }
    },
};
