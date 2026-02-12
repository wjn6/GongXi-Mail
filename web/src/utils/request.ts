import { message } from 'antd';
import { getErrorMessage } from './error';

interface ApiResponse<T> {
    code: number;
    data: T;
    message?: string;
}

export async function requestData<T>(
    requestFn: () => Promise<unknown>,
    fallbackErrorMessage: string,
    options?: { silent?: boolean }
): Promise<T | null> {
    try {
        const response = await requestFn() as ApiResponse<T>;
        if (response?.code === 200) {
            return response.data as T;
        }

        if (!options?.silent) {
            message.error(response?.message || fallbackErrorMessage);
        }
        return null;
    } catch (err: unknown) {
        if (
            err &&
            typeof err === 'object' &&
            (err as { code?: unknown }).code === 'REQUEST_CANCELED'
        ) {
            return null;
        }
        if (!options?.silent) {
            message.error(getErrorMessage(err, fallbackErrorMessage));
        }
        return null;
    }
}
