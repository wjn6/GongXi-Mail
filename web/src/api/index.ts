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
    error?: {
        code?: string | number;
        message?: string;
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
        const token = localStorage.getItem('token');
        if (token && config.headers) {
            (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
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

            if (status === 401) {
                // Token 过期或无效，跳转到登录页
                localStorage.removeItem('token');
                localStorage.removeItem('admin');
                window.location.href = '/login';
            }

            // 新格式错误处理
            if (data?.error) {
                return Promise.reject({
                    code: data.error.code || status,
                    message: data.error.message || 'Request failed',
                });
            }

            return Promise.reject({
                code: status,
                message: data?.message || 'Request failed',
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
    config?: AxiosRequestConfig
): ApiResult<TResponse> => api.post<TBody, ApiResponse<TResponse>>(url, data, config);

const requestPut = <TResponse, TBody = unknown>(
    url: string,
    data?: TBody,
    config?: AxiosRequestConfig
): ApiResult<TResponse> => api.put<TBody, ApiResponse<TResponse>>(url, data, config);

const requestDelete = <T>(url: string, config?: AxiosRequestConfig): ApiResult<T> =>
    api.delete<unknown, ApiResponse<T>>(url, config);

// ========================================
// 认证 API
// ========================================

export const authApi = {
    login: (username: string, password: string) =>
        requestPost<{ token: string; admin: Record<string, unknown> }, { username: string; password: string }>(
            '/admin/auth/login',
            { username, password }
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
            data
        ),

    update: (id: number, data: { username?: string; password?: string; email?: string; role?: string; status?: string }) =>
        requestPut<Record<string, unknown>, { username?: string; password?: string; email?: string; role?: string; status?: string }>(
            `/admin/admins/${id}`,
            data
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/admins/${id}`),
};

// ========================================
// API Key API
// ========================================

export const apiKeyApi = {
    getList: <T = Record<string, unknown>>(params?: { page?: number; pageSize?: number; status?: string; keyword?: string }) =>
        requestGet<ApiPagedList<T>>('/admin/api-keys', { params, cacheMs: 800 }),

    getById: (id: number) =>
        requestGet<Record<string, unknown>>(`/admin/api-keys/${id}`),

    create: (data: { name: string; permissions?: Record<string, boolean>; rateLimit?: number; expiresAt?: string | null }) =>
        requestPost<{ key: string }, { name: string; permissions?: Record<string, boolean>; rateLimit?: number; expiresAt?: string | null }>(
            '/admin/api-keys',
            data
        ),

    update: (id: number, data: { name?: string; permissions?: Record<string, boolean>; rateLimit?: number; status?: string; expiresAt?: string | null }) =>
        requestPut<Record<string, unknown>, { name?: string; permissions?: Record<string, boolean>; rateLimit?: number; status?: string; expiresAt?: string | null }>(
            `/admin/api-keys/${id}`,
            data
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/api-keys/${id}`),

    getUsage: (id: number, groupName?: string) =>
        requestGet<{ total: number; used: number; remaining: number }>(`/admin/api-keys/${id}/usage`, {
            params: { group: groupName },
            cacheMs: 1000,
        }),

    resetPool: (id: number, groupName?: string) =>
        requestPost<Record<string, unknown>, { group?: string }>(`/admin/api-keys/${id}/reset-pool`, {
            group: groupName,
        }),

    getPoolEmails: <T = Record<string, unknown>>(id: number, groupId?: number) =>
        requestGet<T[]>(`/admin/api-keys/${id}/pool-emails`, { params: { groupId }, cacheMs: 800 }),

    updatePoolEmails: (id: number, emailIds: number[]) =>
        requestPut<{ count: number }, { emailIds: number[] }>(`/admin/api-keys/${id}/pool-emails`, {
            emailIds,
        }),
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
            data
        ),

    import: (content: string, separator?: string, groupId?: number) =>
        requestPost<Record<string, unknown>, { content: string; separator?: string; groupId?: number }>(
            '/admin/emails/import',
            { content, separator, groupId }
        ),

    export: (ids?: number[], separator?: string, groupId?: number) =>
        requestGet<{ content: string }>('/admin/emails/export', {
            params: { ids: ids?.join(','), separator, groupId },
        }),

    update: (id: number, data: { email?: string; clientId?: string; refreshToken?: string; password?: string; status?: string; groupId?: number | null }) =>
        requestPut<Record<string, unknown>, { email?: string; clientId?: string; refreshToken?: string; password?: string; status?: string; groupId?: number | null }>(
            `/admin/emails/${id}`,
            data
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/emails/${id}`),

    batchDelete: (ids: number[]) =>
        requestPost<{ deleted: number }, { ids: number[] }>('/admin/emails/batch-delete', { ids }),

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

    create: (data: { name: string; description?: string }) =>
        requestPost<Record<string, unknown>, { name: string; description?: string }>(
            '/admin/email-groups',
            data
        ),

    update: (id: number, data: { name?: string; description?: string }) =>
        requestPut<Record<string, unknown>, { name?: string; description?: string }>(
            `/admin/email-groups/${id}`,
            data
        ),

    delete: (id: number) =>
        requestDelete<Record<string, unknown>>(`/admin/email-groups/${id}`),

    assignEmails: (groupId: number, emailIds: number[]) =>
        requestPost<{ count: number }, { emailIds: number[] }>(`/admin/email-groups/${groupId}/assign`, {
            emailIds,
        }),

    removeEmails: (groupId: number, emailIds: number[]) =>
        requestPost<{ count: number }, { emailIds: number[] }>(`/admin/email-groups/${groupId}/remove`, {
            emailIds,
        }),
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

