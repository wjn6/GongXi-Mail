import axios from 'axios';
import type {
    AxiosError,
    AxiosRequestConfig,
    AxiosResponse,
    InternalAxiosRequestConfig,
} from 'axios';

export interface ApiResponse<T = unknown> {
    code: number;
    data: T;
    message: string;
}

interface ApiSuccessEnvelope<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code?: string | number;
        message?: string;
    };
}

interface ApiErrorPayload {
    message?: string;
    requestId?: string;
    error?: {
        code?: string | number;
        message?: string;
        details?: Array<{
            path?: Array<string | number>;
            message?: string;
        }>;
    };
}

interface ApiPagedList<T> {
    list: T[];
    total: number;
}

interface RequestGetConfig extends AxiosRequestConfig {
    dedupe?: boolean;
    cacheMs?: number;
}

interface MutationConfig extends AxiosRequestConfig {
    invalidatePrefixes?: string[];
}

type ApiResult<T = unknown> = Promise<ApiResponse<T>>;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
    },
});

const pendingGetControllers = new Map<string, AbortController>();
const getResponseCache = new Map<string, { expiresAt: number; value: ApiResponse<unknown> }>();

const REQUEST_ID_HEADER = 'X-Request-Id';

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const stableStringify = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).sort().map((key) => `${key}:${stableStringify(obj[key])}`).join(',')}}`;
    }
    return String(value);
};

const buildGetRequestKey = (url: string, config?: AxiosRequestConfig): string => {
    const paramsKey = stableStringify(config?.params);
    return `${url}?${paramsKey}`;
};

const invalidateGetCache = (prefixes?: string[]) => {
    if (!prefixes || prefixes.length === 0) {
        return;
    }

    for (const key of Array.from(getResponseCache.keys())) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
            getResponseCache.delete(key);
        }
    }

    for (const [key, controller] of Array.from(pendingGetControllers.entries())) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
            controller.abort();
            pendingGetControllers.delete(key);
        }
    }
};

const formatApiErrorMessage = (fallbackMessage: string, payload?: ApiErrorPayload): string => {
    const baseMessage = payload?.error?.message || payload?.message || fallbackMessage;
    const details = payload?.error?.details;

    if (!Array.isArray(details) || details.length === 0) {
        return baseMessage;
    }

    const detailMessage = details
        .slice(0, 3)
        .map((detail) => {
            const path = Array.isArray(detail?.path) ? detail.path.map(String).join('.') : '';
            const message = typeof detail?.message === 'string' ? detail.message : '';
            if (path && message) {
                return `${path}: ${message}`;
            }
            return message || path;
        })
        .filter(Boolean)
        .join('; ');

    if (!detailMessage) {
        return baseMessage;
    }

    return `${baseMessage}: ${detailMessage}`;
};

const createClientRequestId = (): string => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const appendRequestId = (message: string, requestId?: string): string => {
    if (!requestId) {
        return message;
    }
    return `${message} (requestId: ${requestId})`;
};

const shouldClearAuthOnUnauthorized = (
    status: number,
    payload?: ApiErrorPayload,
    requestUrl?: string
): boolean => {
    if (status !== 401) {
        return false;
    }

    const code = String(payload?.error?.code || '').toUpperCase();
    const normalizedUrl = String(requestUrl || '');
    const tokenInvalidCodes = new Set(['UNAUTHORIZED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'JWT_EXPIRED']);

    if (tokenInvalidCodes.has(code)) {
        return true;
    }

    if (normalizedUrl.includes('/admin/auth/me')) {
        return true;
    }

    return false;
};

const toApiResponse = <T>(payload: unknown): ApiResponse<T> => {
    if (isObject(payload) && typeof payload.success === 'boolean') {
        const envelope = payload as unknown as ApiSuccessEnvelope<T>;
        if (envelope.success) {
            return {
                code: 200,
                data: envelope.data as T,
                message: 'Success',
            };
        }
        throw {
            code: envelope.error?.code || 'ERROR',
            message: envelope.error?.message || 'Request failed',
        };
    }

    if (isObject(payload) && typeof payload.code === 'number') {
        return {
            code: payload.code,
            data: (payload as { data?: T }).data as T,
            message: typeof payload.message === 'string' ? payload.message : 'Success',
        };
    }

    return {
        code: 200,
        data: payload as T,
        message: 'Success',
    };
};

// 请求拦截器
api.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const headers = config.headers as Record<string, string>;
        const token = localStorage.getItem('token');
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        if (!headers[REQUEST_ID_HEADER] && !headers['x-request-id']) {
            headers[REQUEST_ID_HEADER] = createClientRequestId();
        }
        return config;
    },
    (error: AxiosError) => {
        return Promise.reject(error);
    }
);

// 响应拦截器 - 适配新的响应格式 { success, data, error }
api.interceptors.response.use(
    (response: AxiosResponse<unknown>) => {
        return toApiResponse(response.data) as unknown as AxiosResponse<unknown>;
    },
    (error: AxiosError<ApiErrorPayload>) => {
        if (error.code === 'ERR_CANCELED') {
            return Promise.reject({
                code: 'REQUEST_CANCELED',
                message: 'Request canceled',
            });
        }

        if (error.response) {
            const { status, data } = error.response;
            const headerRequestId = error.response.headers?.['x-request-id'];
            const requestId = data?.requestId || (typeof headerRequestId === 'string' ? headerRequestId : undefined);
            const requestUrl = error.config?.url;

            if (shouldClearAuthOnUnauthorized(status, data, requestUrl)) {
                // Token 过期或无效，跳转到登录页
                localStorage.removeItem('token');
                localStorage.removeItem('admin');
                window.location.href = '/login';
            }

            // 新格式错误处理
            if (data?.error) {
                return Promise.reject({
                    code: data.error.code || status,
                    message: appendRequestId(formatApiErrorMessage('Request failed', data), requestId),
                    details: data.error.details,
                    requestId,
                });
            }

            return Promise.reject({
                code: status,
                message: appendRequestId(formatApiErrorMessage('Request failed', data), requestId),
                requestId,
            });
        }

        return Promise.reject({
            code: 500,
            message: error.message || 'Network error',
        });
    }
);

export default api;

const requestGet = <T>(url: string, config?: RequestGetConfig): ApiResult<T> => {
    const { dedupe = true, cacheMs = 0, ...axiosConfig } = config || {};
    const requestKey = buildGetRequestKey(url, axiosConfig);

    if (cacheMs > 0) {
        const cached = getResponseCache.get(requestKey);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.value as ApiResponse<T>);
        }
        if (cached) {
            getResponseCache.delete(requestKey);
        }
    }

    let controller: AbortController | null = null;
    if (dedupe) {
        const previousController = pendingGetControllers.get(requestKey);
        if (previousController) {
            previousController.abort();
        }
        controller = new AbortController();
        pendingGetControllers.set(requestKey, controller);
        axiosConfig.signal = controller.signal;
    }

    return api
        .get<unknown, ApiResponse<T>>(url, axiosConfig)
        .then((response) => {
            if (cacheMs > 0) {
                getResponseCache.set(requestKey, {
                    expiresAt: Date.now() + cacheMs,
                    value: response as ApiResponse<unknown>,
                });
            }
            return response;
        })
        .finally(() => {
            if (controller && pendingGetControllers.get(requestKey) === controller) {
                pendingGetControllers.delete(requestKey);
            }
        });
};

const requestPost = <TResponse, TBody = unknown>(
    url: string,
    data?: TBody,
    config?: MutationConfig
): ApiResult<TResponse> => {
    const { invalidatePrefixes, ...axiosConfig } = config || {};
    return api.post<TBody, ApiResponse<TResponse>>(url, data, axiosConfig).then((response) => {
        invalidateGetCache(invalidatePrefixes);
        return response;
    });
};

const requestPut = <TResponse, TBody = unknown>(
    url: string,
    data?: TBody,
    config?: MutationConfig
): ApiResult<TResponse> => {
    const { invalidatePrefixes, ...axiosConfig } = config || {};
    return api.put<TBody, ApiResponse<TResponse>>(url, data, axiosConfig).then((response) => {
        invalidateGetCache(invalidatePrefixes);
        return response;
    });
};

const requestDelete = <T>(url: string, config?: MutationConfig): ApiResult<T> => {
    const { invalidatePrefixes, ...axiosConfig } = config || {};
    return api.delete<unknown, ApiResponse<T>>(url, axiosConfig).then((response) => {
        invalidateGetCache(invalidatePrefixes);
        return response;
    });
};

// ========================================
// 认证 API
// ========================================

export const authApi = {
    login: (username: string, password: string, otp?: string) =>
        requestPost<{ token: string; admin: Record<string, unknown> }, { username: string; password: string; otp?: string }>(
            '/admin/auth/login',
            { username, password, otp }
        ),

    logout: () =>
        requestPost<Record<string, unknown>>('/admin/auth/logout'),

    getMe: () =>
        requestGet<Record<string, unknown>>('/admin/auth/me'),

    changePassword: (oldPassword: string, newPassword: string) =>
        requestPost<Record<string, unknown>, { oldPassword: string; newPassword: string }>(
            '/admin/auth/change-password',
            { oldPassword, newPassword }
        ),

    getTwoFactorStatus: () =>
        requestGet<{ enabled: boolean; pending: boolean; legacyEnv: boolean }>('/admin/auth/2fa/status'),

    setupTwoFactor: () =>
        requestPost<{ secret: string; otpauthUrl: string }>('/admin/auth/2fa/setup'),

    enableTwoFactor: (otp: string) =>
        requestPost<{ enabled: boolean }, { otp: string }>('/admin/auth/2fa/enable', { otp }),

    disableTwoFactor: (password: string, otp: string) =>
        requestPost<{ enabled: boolean }, { password: string; otp: string }>('/admin/auth/2fa/disable', { password, otp }),
};

// ========================================
// 管理员 API
// ========================================

export const adminApi = {
    getList: <T = Record<string, unknown>>(params?: { page?: number; pageSize?: number; status?: string; role?: string; keyword?: string }) =>
        requestGet<ApiPagedList<T>>('/admin/admins', { params }),

    getById: (id: number) =>
        requestGet<Record<string, unknown>>(`/admin/admins/${id}`),

    create: (data: { username: string; password: string; email?: string; role?: string; status?: string }) =>
        requestPost<Record<string, unknown>, { username: string; password: string; email?: string; role?: string; status?: string }>(
            '/admin/admins',
            data,
            { invalidatePrefixes: ['/admin/admins'] }
        ),

    update: (id: number, data: { username?: string; password?: string; email?: string; role?: string; status?: string; twoFactorEnabled?: boolean }) =>
        requestPut<Record<string, unknown>, { username?: string; password?: string; email?: string; role?: string; status?: string; twoFactorEnabled?: boolean }>(
            `/admin/admins/${id}`,
            data,
            { invalidatePrefixes: ['/admin/admins'] }
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/admins/${id}`, { invalidatePrefixes: ['/admin/admins'] }),
};

// ========================================
// API Key API
// ========================================

export const apiKeyApi = {
    getList: <T = Record<string, unknown>>(params?: { page?: number; pageSize?: number; status?: string; keyword?: string }) =>
        requestGet<ApiPagedList<T>>('/admin/api-keys', { params, cacheMs: 800 }),

    getById: (id: number) =>
        requestGet<Record<string, unknown>>(`/admin/api-keys/${id}`),

    create: (data: { name: string; permissions?: Record<string, boolean>; rateLimit?: number; expiresAt?: string | null; allowedGroupIds?: number[]; allowedEmailIds?: number[] }) =>
        requestPost<{ key: string }, { name: string; permissions?: Record<string, boolean>; rateLimit?: number; expiresAt?: string | null; allowedGroupIds?: number[]; allowedEmailIds?: number[] }>(
            '/admin/api-keys',
            data,
            { invalidatePrefixes: ['/admin/api-keys', '/admin/dashboard/stats'] }
        ),

    update: (id: number, data: { name?: string; permissions?: Record<string, boolean>; rateLimit?: number; status?: string; expiresAt?: string | null; allowedGroupIds?: number[]; allowedEmailIds?: number[] }) =>
        requestPut<Record<string, unknown>, { name?: string; permissions?: Record<string, boolean>; rateLimit?: number; status?: string; expiresAt?: string | null; allowedGroupIds?: number[]; allowedEmailIds?: number[] }>(
            `/admin/api-keys/${id}`,
            data,
            {
                invalidatePrefixes: ['/admin/api-keys', `/admin/api-keys/${id}`, '/admin/dashboard/stats'],
            }
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/api-keys/${id}`, {
            invalidatePrefixes: ['/admin/api-keys', `/admin/api-keys/${id}`, '/admin/dashboard/stats'],
        }),

    getUsage: (id: number, groupName?: string) =>
        requestGet<{ total: number; used: number; remaining: number }>(`/admin/api-keys/${id}/usage`, {
            params: { group: groupName },
            cacheMs: 1000,
        }),

    resetPool: (id: number, groupName?: string) =>
        requestPost<Record<string, unknown>, { group?: string }>(`/admin/api-keys/${id}/reset-pool`, {
            group: groupName,
        }, { invalidatePrefixes: [`/admin/api-keys/${id}/usage`, `/admin/api-keys/${id}/pool-emails`] }),

    getPoolEmails: <T = Record<string, unknown>>(id: number, groupId?: number) =>
        requestGet<T[]>(`/admin/api-keys/${id}/pool-emails`, { params: { groupId }, cacheMs: 800 }),

    updatePoolEmails: (id: number, emailIds: number[], groupId?: number) =>
        requestPut<{ count: number }, { emailIds: number[]; groupId?: number }>(`/admin/api-keys/${id}/pool-emails`, {
            emailIds,
            groupId,
        }, { invalidatePrefixes: [`/admin/api-keys/${id}/usage`, `/admin/api-keys/${id}/pool-emails`] }),
};

// ========================================
// 邮箱账户 API
// ========================================

export const emailApi = {
    getList: <T = Record<string, unknown>>(params?: { page?: number; pageSize?: number; status?: string; keyword?: string; groupId?: number }) =>
        requestGet<ApiPagedList<T>>('/admin/emails', { params, cacheMs: 800 }),

    getById: <T = Record<string, unknown>>(id: number, includeSecrets?: boolean) =>
        requestGet<T>(`/admin/emails/${id}`, { params: { secrets: includeSecrets } }),

    create: (data: { email: string; clientId: string; refreshToken: string; password?: string; groupId?: number }) =>
        requestPost<Record<string, unknown>, { email: string; clientId: string; refreshToken: string; password?: string; groupId?: number }>(
            '/admin/emails',
            data,
            {
                invalidatePrefixes: ['/admin/emails', '/admin/email-groups', '/admin/api-keys', '/admin/dashboard/stats'],
            }
        ),

    import: (content: string, separator?: string, groupId?: number) =>
        requestPost<Record<string, unknown>, { content: string; separator?: string; groupId?: number }>(
            '/admin/emails/import',
            { content, separator, groupId },
            {
                invalidatePrefixes: ['/admin/emails', '/admin/email-groups', '/admin/api-keys', '/admin/dashboard/stats'],
            }
        ),

    export: (ids?: number[], separator?: string, groupId?: number) =>
        requestGet<{ content: string }>('/admin/emails/export', {
            params: { ids: ids?.join(','), separator, groupId },
        }),

    update: (id: number, data: { email?: string; clientId?: string; refreshToken?: string; password?: string; status?: string; groupId?: number | null }) =>
        requestPut<Record<string, unknown>, { email?: string; clientId?: string; refreshToken?: string; password?: string; status?: string; groupId?: number | null }>(
            `/admin/emails/${id}`,
            data,
            {
                invalidatePrefixes: ['/admin/emails', '/admin/email-groups', '/admin/api-keys', '/admin/dashboard/stats'],
            }
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/emails/${id}`, {
            invalidatePrefixes: ['/admin/emails', '/admin/email-groups', '/admin/api-keys', '/admin/dashboard/stats'],
        }),

    batchDelete: (ids: number[]) =>
        requestPost<{ deleted: number }, { ids: number[] }>('/admin/emails/batch-delete', { ids }, {
            invalidatePrefixes: ['/admin/emails', '/admin/email-groups', '/admin/api-keys', '/admin/dashboard/stats'],
        }),

    // 查看邮件 (管理员专用)
    viewMails: <T = Record<string, unknown>>(id: number, mailbox?: string) =>
        requestGet<{ messages: T[] }>(`/admin/emails/${id}/mails`, { params: { mailbox } }),

    // 清空邮箱 (管理员专用)
    clearMailbox: (id: number, mailbox?: string) =>
        requestPost<{ deletedCount: number }, { mailbox?: string }>(`/admin/emails/${id}/clear`, {
            mailbox,
        }),
};

// ========================================
// 邮箱分组 API
// ========================================

export const groupApi = {
    getList: <T = Record<string, unknown>>() =>
        requestGet<T[]>('/admin/email-groups', { cacheMs: 5000 }),

    getById: (id: number) =>
        requestGet<Record<string, unknown>>(`/admin/email-groups/${id}`),

    create: (data: { name: string; description?: string; fetchStrategy: 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY' }) =>
        requestPost<Record<string, unknown>, { name: string; description?: string; fetchStrategy: 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY' }>(
            '/admin/email-groups',
            data,
            { invalidatePrefixes: ['/admin/email-groups', '/admin/emails', '/admin/api-keys'] }
        ),

    update: (id: number, data: { name?: string; description?: string; fetchStrategy?: 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY' }) =>
        requestPut<Record<string, unknown>, { name?: string; description?: string; fetchStrategy?: 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY' }>(
            `/admin/email-groups/${id}`,
            data,
            { invalidatePrefixes: ['/admin/email-groups', '/admin/emails', '/admin/api-keys'] }
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/email-groups/${id}`, {
            invalidatePrefixes: ['/admin/email-groups', '/admin/emails', '/admin/api-keys'],
        }),

    assignEmails: (groupId: number, emailIds: number[]) =>
        requestPost<{ count: number }, { emailIds: number[] }>(`/admin/email-groups/${groupId}/assign`, {
            emailIds,
        }, { invalidatePrefixes: ['/admin/email-groups', '/admin/emails', '/admin/api-keys'] }),

    removeEmails: (groupId: number, emailIds: number[]) =>
        requestPost<{ count: number }, { emailIds: number[] }>(`/admin/email-groups/${groupId}/remove`, {
            emailIds,
        }, { invalidatePrefixes: ['/admin/email-groups', '/admin/emails', '/admin/api-keys'] }),
};

// ========================================
// 仪表盘 API
// ========================================

export const dashboardApi = {
    getStats: <T = Record<string, unknown>>() =>
        requestGet<T>('/admin/dashboard/stats', { cacheMs: 2000 }),

    getApiTrend: <T = Record<string, unknown>>(days: number = 7) =>
        requestGet<T[]>('/admin/dashboard/api-trend', { params: { days }, cacheMs: 2000 }),

    getLogs: <T = Record<string, unknown>>(params?: { page?: number; pageSize?: number; action?: string }) =>
        requestGet<ApiPagedList<T>>('/admin/dashboard/logs', { params }),
};

// ========================================
// 操作日志 API（废弃，使用 dashboardApi.getLogs）
// ========================================

export const logsApi = {
    getList: <T = Record<string, unknown>>(params: { page?: number; pageSize?: number; action?: string; resource?: string }) =>
        requestGet<ApiPagedList<T>>('/admin/dashboard/logs', { params }),
};

