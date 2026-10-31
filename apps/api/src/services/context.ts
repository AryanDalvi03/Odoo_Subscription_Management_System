import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { AuditLog, Customer, Sequence, Notification } from '../models/index.js';
import { AppError, ensure } from '../lib/errors.js';
export type Actor = {
  id: string;
  role: 'admin' | 'staff' | 'customer';
  name: string;
  email: string;
  permissions: string[];
  ip?: string;
};
export function permit(actor: Actor, action: string) {
  ensure(
    actor.role === 'admin' || (actor.role === 'staff' && actor.permissions.includes(action)),
    403,
    'FORBIDDEN',
    'You do not have permission for this operation',
  );
}
export async function customerScope(actor: Actor): Promise<Record<string, unknown>> {
  if (actor.role === 'admin') return {};
  if (actor.role === 'staff') return { assignedStaffIds: new Types.ObjectId(actor.id) };
  return { userId: new Types.ObjectId(actor.id) };
}
export async function resourceScope(actor: Actor) {
  if (actor.role === 'admin') return {};
  const ids = await Customer.find(await customerScope(actor)).distinct('_id');
  return { customerId: { $in: ids } };
}
export async function ownedCustomer(actor: Actor, id: string, session?: ClientSession) {
  const customer = await Customer.findOne({ _id: id, ...(await customerScope(actor)) }).session(
    session ?? null,
  );
  ensure(customer, 404, 'NOT_FOUND', 'Customer not found');
  return customer;
}
export async function numberFor(type: string, session: ClientSession) {
  const key = `${type}-${new Date().getUTCFullYear()}`;
  const row = await Sequence.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after', session },
  );
  return `${key}-${String(row!.value).padStart(6, '0')}`;
}
export async function audit(
  actor: Actor | undefined,
  action: string,
  resourceType: string,
  resourceId: unknown,
  after?: unknown,
  session?: ClientSession,
  before?: unknown,
) {
  await AuditLog.create(
    [
      {
        actorId: actor?.id,
        role: actor?.role ?? 'system',
        action,
        resourceType,
        resourceId: String(resourceId),
        after,
        before,
        ip: actor?.ip,
      },
    ],
    { session },
  );
}
export async function notify(
  recipient: string,
  subject: string,
  text: string,
  eventKey: string,
  session?: ClientSession,
) {
  await Notification.updateOne(
    { eventKey },
    { $setOnInsert: { recipient, subject, text, status: 'pending' } },
    { upsert: true, session },
  );
}
export function objectId(value: unknown): string {
  ensure(
    typeof value === 'string' && Types.ObjectId.isValid(value),
    400,
    'INVALID_ID',
    'Invalid resource identifier',
  );
  return value;
}
