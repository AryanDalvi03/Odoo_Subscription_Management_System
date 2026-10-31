import { z } from 'zod';
export const serviceHealthSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.object({
    database: z.boolean(),
    redis: z.boolean(),
    transactions: z.boolean(),
    worker: z.boolean(),
  }),
});
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
export type ApiResponse<T> = { data: T };
export type ApiError = { error: { code: string; message: string; requestId: string } };
export const roleSchema = z.enum(['admin', 'staff', 'customer']);
export type Role = z.infer<typeof roleSchema>;
