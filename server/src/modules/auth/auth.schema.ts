import { z } from 'zod';

// ============================================
// Auth Schemas
// ============================================

export const loginSchema = z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
    otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits').optional(),
});

export const changePasswordSchema = z.object({
    oldPassword: z.string().min(1, 'Old password is required'),
    newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const verify2FaSchema = z.object({
    otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});

export const disable2FaSchema = z.object({
    password: z.string().min(1, 'Password is required'),
    otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type Verify2FaInput = z.infer<typeof verify2FaSchema>;
export type Disable2FaInput = z.infer<typeof disable2FaSchema>;
