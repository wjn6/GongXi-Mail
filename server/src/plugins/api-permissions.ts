export type ApiPermissions = Record<string, boolean>;

function normalizeApiPermissionKey(key: string): string {
    return key.trim().toLowerCase().replace(/-/g, '_');
}

export function parseApiPermissions(value: unknown): ApiPermissions | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, permissionValue]) => typeof permissionValue === 'boolean')
        .map(([permissionKey, permissionValue]) => [normalizeApiPermissionKey(permissionKey), permissionValue as boolean]);

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
    const wildcardKeys = ['*', 'all', '__all__'];

    for (const wildcardKey of wildcardKeys) {
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
