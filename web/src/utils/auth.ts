export type AdminRole = 'SUPER_ADMIN' | 'ADMIN';
export type AdminStatus = 'ACTIVE' | 'DISABLED';

export function normalizeAdminRole(role?: string | null): AdminRole | undefined {
    const normalizedRole = String(role || '').toUpperCase();
    if (normalizedRole === 'SUPER_ADMIN' || normalizedRole === 'ADMIN') {
        return normalizedRole;
    }
    return undefined;
}

export function isSuperAdmin(role?: string | null): boolean {
    return normalizeAdminRole(role) === 'SUPER_ADMIN';
}

export function getAdminRoleLabel(role?: string | null): string {
    return isSuperAdmin(role) ? '超级管理员' : '管理员';
}

export function normalizeAdminStatus(status?: string | null): AdminStatus | undefined {
    const normalizedStatus = String(status || '').toUpperCase();
    if (normalizedStatus === 'ACTIVE' || normalizedStatus === 'DISABLED') {
        return normalizedStatus;
    }
    return undefined;
}

export function getAdminStatusLabel(status?: string | null): string {
    return normalizeAdminStatus(status) === 'ACTIVE' ? '启用' : '禁用';
}

