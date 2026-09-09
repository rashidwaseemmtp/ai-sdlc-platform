import { Prisma, PrismaClient } from '@prisma/client';

/** One client for the process. Prisma pools connections itself. */
export const db = new PrismaClient();

/** Append to the project's activity log. Every meaningful state change goes through here. */
export async function logEvent(
  projectId: string,
  type: string,
  payload: Record<string, unknown> = {},
  actor = 'system',
): Promise<void> {
  await db.event.create({
    data: { projectId, type, payload: payload as Prisma.InputJsonValue, actor },
  });
}
