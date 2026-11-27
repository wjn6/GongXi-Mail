/**
 * 微软 OAuth 令牌交换（统一入口）。
 *
 * 所有用 refresh token 换取访问令牌的地方（收信 Graph / IMAP、发信、Token 刷新）都走这里，
 * 端点由邮箱所在分组的 oauthTenant 决定：
 *   CONSUMERS      /consumers      仅个人 Microsoft 账号（outlook.com、hotmail.com 等）
 *   ORGANIZATIONS  /organizations  仅工作 / 学校账号（Entra ID）
 *   COMMON         /common         两种都接受（需要应用注册为同时支持两种账号）
 * 应用若注册为仅支持个人账号，用 /common 会被微软拒绝（AADSTS9002331）。
 */
import { proxyFetch } from './proxy.js';
import { networkOAuthFailure, parseOAuthTokenError, unknownOAuthFailure, type OAuthFailure } from './oauth-error.js';
import { normalizeOAuthTenant, tokenEndpointFor } from './oauth-tenant.js';

export { DEFAULT_OAUTH_TENANT, normalizeOAuthTenant, tokenEndpointFor, type OAuthTenantName } from './oauth-tenant.js';

export interface TokenSuccess {
    accessToken: string;
    /** 微软返回的新 refresh token（会轮换，调用方应保存） */
    refreshToken: string | null;
    scope: string;
    expiresIn: number;
}

export type TokenExchangeResult = ({ ok: true } & TokenSuccess) | { ok: false; failure: OAuthFailure };

export interface TokenExchangeInput {
    clientId: string;
    refreshToken: string;
    tenant?: unknown;
    /**
     * 不传时：/consumers、/common 不带 scope（按授权时的权限签发，与原有行为一致）；
     * /organizations 要求必须带 scope，使用 DEFAULT_REFRESH_SCOPE。
     */
    scope?: string;
    proxyConfig?: { socks5?: string; http?: string };
}

interface OAuthTokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
    expires_in?: unknown;
}

/** /organizations 端点缺省 scope 时使用：Outlook IMAP 权限并保持可刷新 */
export const DEFAULT_REFRESH_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';

export async function exchangeRefreshToken(input: TokenExchangeInput): Promise<TokenExchangeResult> {
    const params: Record<string, string> = {
        client_id: input.clientId,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
    };
    const scope = input.scope || (normalizeOAuthTenant(input.tenant) === 'ORGANIZATIONS' ? DEFAULT_REFRESH_SCOPE : '');
    if (scope) {
        params.scope = scope;
    }

    try {
        const response = await proxyFetch(
            tokenEndpointFor(input.tenant),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params).toString(),
            },
            input.proxyConfig
        );

        if (!response.ok) {
            const bodyText = await response.text();
            return { ok: false, failure: parseOAuthTokenError(response.status, bodyText) };
        }

        const data = await response.json() as OAuthTokenResponse;
        const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
        if (!accessToken) {
            return { ok: false, failure: unknownOAuthFailure('Token response missing access_token') };
        }
        return {
            ok: true,
            accessToken,
            refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
            scope: typeof data.scope === 'string' ? data.scope : '',
            expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
        };
    } catch (err) {
        return { ok: false, failure: networkOAuthFailure(err instanceof Error ? err.message : String(err)) };
    }
}
