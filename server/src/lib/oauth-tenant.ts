/**
 * 微软登录端点（纯函数，无依赖，便于测试）。
 *   CONSUMERS      /consumers      仅个人 Microsoft 账号（outlook.com、hotmail.com 等）
 *   ORGANIZATIONS  /organizations  仅工作 / 学校账号（Entra ID）
 *   COMMON         /common         两种都接受（需要应用注册为同时支持两种账号）
 * 应用若注册为仅支持个人账号，用 /common 会被微软拒绝（AADSTS9002331）。
 */

export type OAuthTenantName = 'CONSUMERS' | 'ORGANIZATIONS' | 'COMMON';

export const DEFAULT_OAUTH_TENANT: OAuthTenantName = 'CONSUMERS';

const TENANT_PATHS: Record<OAuthTenantName, string> = {
    CONSUMERS: 'consumers',
    ORGANIZATIONS: 'organizations',
    COMMON: 'common',
};

/** 未设置或无法识别时使用 CONSUMERS（未分组的邮箱也按个人账号处理） */
export function normalizeOAuthTenant(value: unknown): OAuthTenantName {
    return value === 'ORGANIZATIONS' || value === 'COMMON' || value === 'CONSUMERS' ? value : DEFAULT_OAUTH_TENANT;
}

export function tokenEndpointFor(tenant: unknown): string {
    return `https://login.microsoftonline.com/${TENANT_PATHS[normalizeOAuthTenant(tenant)]}/oauth2/v2.0/token`;
}
