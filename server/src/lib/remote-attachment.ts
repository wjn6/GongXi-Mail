/**
 * 远程附件下载（Resend attachments[].path）。
 * 安全限制：仅 https；拒绝内网 / 回环 / 保留地址（连接时校验解析结果，防 DNS 重绑定）；
 * 手动跟随重定向并逐跳校验；限制大小与超时。
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { SendRequestError, sanitizeFilename } from './send-mail.js';

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

function isPublicIpv4(ip: string): boolean {
    const value = ipv4ToInt(ip);
    return !BLOCKED_V4.some(([base, bits]) => {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (value & mask) === (ipv4ToInt(base) & mask);
    });
}

function expandIpv6(ip: string): number[] | null {
    let addr = ip.toLowerCase();
    const zone = addr.indexOf('%');
    if (zone >= 0) addr = addr.slice(0, zone);
    // 末尾嵌入 IPv4（::ffff:1.2.3.4）
    const v4Match = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (v4Match) {
        const v4 = ipv4ToInt(v4Match[1]);
        addr = addr.slice(0, -v4Match[1].length) + `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const parts = addr.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (parts.length === 1 && missing !== 0) return null;
    const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    const values = groups.map((g) => parseInt(g || '0', 16));
    return values.some((v) => Number.isNaN(v) || v < 0 || v > 0xffff) ? null : values;
}

function isPublicIpv6(ip: string): boolean {
    const g = expandIpv6(ip);
    if (!g) return false;
    const allZeroPrefix = (n: number) => g.slice(0, n).every((v) => v === 0);
    if (g.every((v) => v === 0)) return false; // ::
    if (allZeroPrefix(7) && g[7] === 1) return false; // ::1
    // IPv4 映射 / 兼容地址：按内嵌 IPv4 判断
    if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) {
        return isPublicIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    // NAT64 64:ff9b::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((v) => v === 0)) {
        return isPublicIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 唯一本地
    if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
    if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 组播
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 文档地址
    return true;
}

/** 是否为可访问的公网 IP（拒绝内网、回环、链路本地、组播与保留地址） */
export function isPublicIpAddress(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) return isPublicIpv4(ip);
    if (family === 6) return isPublicIpv6(ip);
    return false;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 供 net/tls 连接使用的 lookup：解析后逐个校验地址 */
function safeLookup(hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback) {
    const opts = typeof options === 'number' ? { family: options } : options || {};
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) {
            callback(err, '');
            return;
        }
        const list = (Array.isArray(addresses) ? addresses : []) as LookupAddress[];
        if (list.length === 0 || list.some((item) => !isPublicIpAddress(item.address))) {
            const blocked = new Error(`Refusing to connect to non-public address for ${hostname}`) as NodeJS.ErrnoException;
            blocked.code = 'EBLOCKEDADDRESS';
            callback(blocked, '');
            return;
        }
        if (opts.all) {
            callback(null, list);
        } else {
            callback(null, list[0].address, list[0].family);
        }
    });
}

let agent: Agent | null = null;
function getAgent(): Agent {
    if (!agent) {
        agent = new Agent({
            connect: { lookup: safeLookup as unknown as typeof dnsLookup, timeout: 10_000 },
            headersTimeout: DOWNLOAD_TIMEOUT_MS,
            bodyTimeout: DOWNLOAD_TIMEOUT_MS,
        });
    }
    return agent;
}

function invalid(index: number, message: string): SendRequestError {
    return new SendRequestError('INVALID_ATTACHMENT', `attachments[${index}].path: ${message}`, 422, `attachments[${index}]`);
}

function assertAllowedUrl(raw: string, index: number): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw invalid(index, 'invalid URL.');
    }
    if (url.protocol !== 'https:') {
        throw invalid(index, 'only https URLs are supported.');
    }
    if (url.username || url.password) {
        throw invalid(index, 'URLs with credentials are not allowed.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // 直接写 IP 时连接不会经过 lookup，需要在这里校验
    if (net.isIP(host) && !isPublicIpAddress(host)) {
        throw invalid(index, 'non-public addresses are not allowed.');
    }
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
        throw invalid(index, 'non-public addresses are not allowed.');
    }
    return url;
}

export interface DownloadedAttachment {
    contentBase64: string;
    size: number;
    filename: string;
    contentType?: string;
}

/**
 * 下载远程附件，返回 base64 内容。maxBytes 为本附件允许的最大字节数。
 */
export async function downloadRemoteAttachment(rawUrl: string, index: number, maxBytes: number): Promise<DownloadedAttachment> {
    let url = assertAllowedUrl(rawUrl, index);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        for (let redirects = 0; ; redirects++) {
            let response: Awaited<ReturnType<typeof undiciFetch>>;
            try {
                response = await undiciFetch(url, {
                    method: 'GET',
                    redirect: 'manual',
                    dispatcher: getAgent(),
                    signal: controller.signal,
                    headers: { 'User-Agent': 'GongXi-Mail-Attachment-Fetcher' },
                });
            } catch (err) {
                const code = (err as { cause?: { code?: string } })?.cause?.code;
                if (code === 'EBLOCKEDADDRESS') {
                    throw invalid(index, 'non-public addresses are not allowed.');
                }
                throw invalid(index, controller.signal.aborted ? 'download timed out.' : 'download failed.');
            }

            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                await response.body?.cancel();
                if (redirects >= MAX_REDIRECTS) {
                    throw invalid(index, 'too many redirects.');
                }
                url = assertAllowedUrl(new URL(response.headers.get('location')!, url).toString(), index);
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw invalid(index, `download failed with HTTP ${response.status}.`);
            }

            const declared = Number(response.headers.get('content-length') || 0);
            if (declared > maxBytes) {
                await response.body?.cancel();
                throw invalid(index, `file is larger than ${Math.floor(maxBytes / 1024)} KB.`);
            }

            const chunks: Buffer[] = [];
            let size = 0;
            if (response.body) {
                for await (const chunk of response.body) {
                    const buf = Buffer.from(chunk as Uint8Array);
                    size += buf.length;
                    if (size > maxBytes) {
                        controller.abort();
                        throw invalid(index, `file is larger than ${Math.floor(maxBytes / 1024)} KB.`);
                    }
                    chunks.push(buf);
                }
            }
            if (size === 0) {
                throw invalid(index, 'downloaded file is empty.');
            }

            const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
            const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined;
            return {
                contentBase64: Buffer.concat(chunks).toString('base64'),
                size,
                filename: sanitizeFilename(lastSegment) || 'attachment',
                contentType,
            };
        }
    } finally {
        clearTimeout(timer);
    }
}
