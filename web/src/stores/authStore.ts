import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Admin {
    id: number;
    username: string;
    email?: string;
    role: 'SUPER_ADMIN' | 'ADMIN';
}

interface AuthState {
    token: string | null;
    admin: Admin | null;
    isAuthenticated: boolean;
    setAuth: (token: string, admin: Admin) => void;
    clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            token: null,
            admin: null,
            isAuthenticated: false,

            setAuth: (token: string, admin: Admin) => {
                localStorage.setItem('token', token);
                set({
                    token,
                    admin,
                    isAuthenticated: true,
                });
            },

            clearAuth: () => {
                localStorage.removeItem('token');
                set({
                    token: null,
                    admin: null,
                    isAuthenticated: false,
                });
            },
        }),
        {
            name: 'auth-storage',
            partialize: (state) => ({
                token: state.token,
                admin: state.admin,
                isAuthenticated: state.isAuthenticated,
            }),
        }
    )
);
