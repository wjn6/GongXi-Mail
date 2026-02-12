import { MAIL_LOG_ACTIONS } from '../modules/mail/mail.actions.js';

export type ApiPermissions = Record<string, boolean>;

export function normalizeApiPermissionKey(key: string): string {
    return key.trim().toLowerCase().replace(/-/g, '_');
}

const ALLOWED_ACTION_KEYS = new Set(
    Object.values(MAIL_LOG_ACTIONS).map((action) => normalizeApiPermissionKey(action))
);
const WILDCARD_KEYS = new Set(['*', 'all', '__all__']);

export function isKnownApiPermissionKey(key: string): boolean {
    const normalizedKey = normalizeApiPermissionKey(key);
    return WILDCARD_KEYS.has(normalizedKey) || ALLOWED_ACTION_KEYS.has(normalizedKey);
}

export function parseApiPermissions(value: unknown): ApiPermissions | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const entries: Array<[string, boolean]> = Object.entries(value as Record<string, unknown>)
        .filter(([, permissionValue]) => typeof permissionValue === 'boolean')
        .map(([permissionKey, permissionValue]) => [normalizeApiPermissionKey(permissionKey), permissionValue as boolean] as [string, boolean])
        .filter(([permissionKey]) => isKnownApiPermissionKey(permissionKey));

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
}

export function isApiPermissionAllowed(permissions: ApiPermissions | undefined, action: string): boolean {
    if (!permissions || Object.keys(permissions).length === 0) {
        return true;
    }

    const actionKey = normalizeApiPermissionKey(action);
    for (const wildcardKey of WILDCARD_KEYS) {
        if (permissions[wildcardKey] === true) {
            return true;
        }
    }

    if (permissions[actionKey] === true) {
        return true;
    }
    if (permissions[actionKey] === false) {
        return false;
    }

    const legacyKey = actionKey.replace(/_/g, '-');
    if (permissions[legacyKey] === true) {
        return true;
    }
    if (permissions[legacyKey] === false) {
        return false;
    }

    return false;
}
