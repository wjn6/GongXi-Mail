import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import nodeFetch from 'node-fetch';
import { logger } from './logger.js';

interface ProxyOptions {
    fetch: typeof fetch;
    agent?: SocksProxyAgent;
    dispatcher?: ProxyAgent;
    type?: 'socks5' | 'http' | 'none';
}

type ProxyFetchOptions = Omit<RequestInit, 'dispatcher'> & {
    agent?: unknown;
    dispatcher?: unknown;
};

/**
 * 创建 SOCKS5 代理 Agent
 */
export function createSocksAgent(socks5: string): SocksProxyAgent | null {
    if (!socks5 || typeof socks5 !== 'string') {
        return null;
    }

    let normalizedUrl = socks5.trim();
    if (!normalizedUrl.startsWith('socks5://')) {
        if (!normalizedUrl.includes('://')) {
            normalizedUrl = `socks5://${normalizedUrl}`;
        } else {
            logger.error({ url: socks5 }, 'Only SOCKS5 protocol is supported');
            return null;
        }
    }

    try {
        const agent = new SocksProxyAgent(normalizedUrl, {
            timeout: 10000,
        });
        logger.debug({ url: normalizedUrl }, 'SOCKS5 proxy created');
        return agent;
    } catch (err) {
        logger.error({ err, url: socks5 }, 'Failed to create SOCKS5 proxy');
        return null;
    }
}

/**
 * 创建 HTTP 代理 Agent
 */
export function createHttpAgent(http: string): ProxyAgent | null {
    if (!http) {
        return null;
    }

    try {
        const agent = new ProxyAgent(http);
        logger.debug({ url: http }, 'HTTP proxy created');
        return agent;
    } catch (err) {
        logger.error({ err, url: http }, 'Failed to create HTTP proxy');
        return null;
    }
}

/**
 * 自动选择代理
 */
export function autoProxy(socks5?: string, http?: string): ProxyOptions {
    // SOCKS5 代理优先
    if (socks5) {
        const agent = createSocksAgent(socks5);
        if (agent) {
            return {
                fetch: nodeFetch as unknown as typeof fetch,
                agent,
                type: 'socks5',
            };
        }
    }

    // HTTP 代理
    if (http) {
        const dispatcher = createHttpAgent(http);
        if (dispatcher) {
            return {
                fetch: undiciFetch as unknown as typeof fetch,
                dispatcher,
                type: 'http',
            };
        }
    }

    // 无代理
    return {
        fetch: undiciFetch as unknown as typeof fetch,
        type: 'none',
    };
}

/**
 * 使用代理发起请求
 */
export async function proxyFetch(
    url: string,
    options: RequestInit = {},
    proxyConfig?: { socks5?: string; http?: string }
): Promise<Response> {
    const proxy = autoProxy(proxyConfig?.socks5, proxyConfig?.http);

    const fetchOptions: ProxyFetchOptions = { ...options };

    if (proxy.agent) {
        fetchOptions.agent = proxy.agent;
    }
    if (proxy.dispatcher) {
        fetchOptions.dispatcher = proxy.dispatcher;
    }

    return proxy.fetch(url, fetchOptions as RequestInit) as Promise<Response>;
}

export default { createSocksAgent, createHttpAgent, autoProxy, proxyFetch };
