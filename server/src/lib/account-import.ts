/**
 * 批量导入的单行解析（纯函数，便于测试）。
 *
 * 支持的格式（分隔符默认 ----）：
 *   6 列：邮箱----密码----客户端ID----Graph刷新令牌----IMAP客户端ID----IMAP刷新令牌
 *   5 列：邮箱----客户端ID----uuid----info----刷新令牌
 *   4 列：邮箱----密码----客户端ID----刷新令牌
 *   3 列：邮箱----客户端ID----刷新令牌
 *
 * 6 列格式用于 Graph 和 IMAP 由两个不同应用分别授权的账号：每个 refresh token 只能用于签发它的客户端 ID，
 * 而 IMAP 不指定 scope 换取令牌，Graph 应用的 refresh token 换出来的是 Graph 令牌，不能登录 IMAP。
 */

export interface ParsedImportLine {
    email: string;
    password?: string;
    clientId: string;
    refreshToken: string;
    /** 单独用于 IMAP / SMTP 的凭据；与主凭据相同或未提供时为 undefined */
    imapClientId?: string;
    imapRefreshToken?: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ImportLineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImportLineError';
    }
}

export function isGuid(value: string | undefined): boolean {
    return !!value && GUID_RE.test(value.trim());
}

/** 6 列格式：第 3 列与第 5 列都是客户端 ID（GUID），或第 5、6 列留空 */
function isSixColumnFormat(parts: string[]): boolean {
    if (parts.length !== 6 || !isGuid(parts[2])) return false;
    return isGuid(parts[4]) || (!parts[4] && !parts[5]);
}

export function parseImportLine(line: string, separator: string = '----'): ParsedImportLine {
    if (!separator) {
        throw new ImportLineError('Separator must not be empty');
    }
    const parts = line.trim().split(separator).map((part) => part.trim());
    if (parts.length < 3) {
        throw new ImportLineError('Invalid format: expected at least 3 columns');
    }

    let result: ParsedImportLine;
    if (isSixColumnFormat(parts)) {
        const [email, password, clientId, refreshToken, imapClientId, imapRefreshToken] = parts;
        result = {
            email,
            ...(password ? { password } : {}),
            clientId,
            refreshToken,
            ...(imapClientId && imapRefreshToken ? { imapClientId, imapRefreshToken } : {}),
        };
        if ((imapClientId && !imapRefreshToken) || (!imapClientId && imapRefreshToken)) {
            throw new ImportLineError('IMAP client ID and IMAP refresh token must be provided together');
        }
    } else if (parts.length >= 5) {
        result = { email: parts[0], clientId: parts[1], refreshToken: parts[4] };
    } else if (parts.length === 4) {
        result = {
            email: parts[0],
            ...(parts[1] ? { password: parts[1] } : {}),
            clientId: parts[2],
            refreshToken: parts[3],
        };
    } else {
        result = { email: parts[0], clientId: parts[1], refreshToken: parts[2] };
    }

    if (!result.email || !result.clientId || !result.refreshToken) {
        throw new ImportLineError('Missing required fields');
    }
    if (!EMAIL_RE.test(result.email)) {
        throw new ImportLineError(`Invalid email address: ${result.email.slice(0, 64)}`);
    }

    // 两套凭据完全相同时没必要单独保存
    if (result.imapClientId === result.clientId && result.imapRefreshToken === result.refreshToken) {
        delete result.imapClientId;
        delete result.imapRefreshToken;
    }
    return result;
}

/** 导出：有独立 IMAP 凭据的账号导出为 6 列，其它账号保持 3 列 */
export function formatExportLine(
    account: { email: string; password?: string | null; clientId: string; refreshToken: string; imapClientId?: string | null; imapRefreshToken?: string | null },
    separator: string = '----'
): string {
    if (account.imapClientId && account.imapRefreshToken) {
        return [account.email, account.password ?? '', account.clientId, account.refreshToken, account.imapClientId, account.imapRefreshToken].join(separator);
    }
    return [account.email, account.clientId, account.refreshToken].join(separator);
}
