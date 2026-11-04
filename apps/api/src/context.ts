import type { PrismaClient, User, Role } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';

export interface AppContext {
 db: PrismaClient;
 redis: Redis;
 now: () => Date;
 auth: (req: Pick<FastifyRequest, 'cookies'>) => Promise<User>;
 verified: (req: Pick<FastifyRequest, 'cookies'>) => Promise<User>;
 staff: (req: Pick<FastifyRequest, 'cookies'>, roles: Role[]) => Promise<User>;
 emit: (room: string, event: string, payload: unknown) => void;
 jobs: Queue;
 encrypt: (value: unknown) => string;
 decrypt: (ciphertext: string) => any;
}
export class ApiError extends Error {
 constructor(public statusCode: number, message: string) { super(message); }
}
