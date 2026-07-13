/**
 * Regression test for the dashboard's loose-search behaviour added on the
 * storage interface — substring filters (`*Contains`) must:
 *   • match case-insensitively,
 *   • not bleed into the exact-match `appId` / `category` / `userId` /
 *     `environment` fields used by `TrackerQueryHelpers` for app-scoping.
 */

import { InMemoryStorageAdapter } from '../../../../src/consumer/storage/adapters/InMemoryStorageAdapter';
import { TrackerEventStatus, type StoredTrackerEvent } from '../../../../src/common/types';

function ev(over: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'info',
    message: 'm',
    status: TrackerEventStatus.New,
    timestamp: Date.now(),
    receivedAt: Date.now(),
    ...over,
  };
}

describe('InMemoryStorageAdapter — *Contains substring filters', () => {
  it('appIdContains matches case-insensitively', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'dev-portal' }),
      ev({ appId: 'PROD-portal' }),
      ev({ appId: 'staging-api' }),
    ]);
    expect((await s.find({ appIdContains: 'dev' }))).toHaveLength(1);
    expect((await s.find({ appIdContains: 'PORTAL' }))).toHaveLength(2);
    expect((await s.find({ appIdContains: 'api' }))).toHaveLength(1);
  });

  it('exact appId still requires an exact match', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'app-a' }),
      ev({ appId: 'app-a-staging' }),
      ev({ appId: 'app-b' }),
    ]);
    const found = await s.find({ appId: 'app-a' });
    expect(found).toHaveLength(1);
    expect(found[0].appId).toBe('app-a');
  });

  it('categoryContains works alongside exact type filter', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ type: 'error', category: 'payment-charge' }),
      ev({ type: 'error', category: 'payment-refund' }),
      ev({ type: 'info',  category: 'payment-charge' }),
    ]);
    const found = await s.find({ type: 'error', categoryContains: 'payment' });
    expect(found).toHaveLength(2);
    expect(found.every(e => e.type === 'error')).toBe(true);
  });

  it('userIdContains and environmentContains scope to context fields', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ context: { userId: 'user-123', environment: 'production' } }),
      ev({ context: { userId: 'user-456', environment: 'production' } }),
      ev({ context: { userId: 'admin-9',  environment: 'staging' } }),
    ]);
    expect((await s.find({ userIdContains: 'user' }))).toHaveLength(2);
    expect((await s.find({ environmentContains: 'PROD' }))).toHaveLength(2);
  });

  it('messageContains matches case-insensitively on the message field', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ message: 'Connection refused to database' }),
      ev({ message: 'Payment processed successfully' }),
      ev({ message: 'CONNECTION timeout reached' }),
      ev({ message: 'User signed in' }),
    ]);
    expect((await s.find({ messageContains: 'connection' }))).toHaveLength(2);
    expect((await s.find({ messageContains: 'payment' }))).toHaveLength(1);
    expect((await s.find({ messageContains: 'nope' }))).toHaveLength(0);
  });

  it('messageContains composes with other filters (type + message)', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ type: 'error',   message: 'Connection refused' }),
      ev({ type: 'warning', message: 'Connection slow' }),
      ev({ type: 'info',    message: 'Connection established' }),
    ]);
    const found = await s.find({ type: 'error', messageContains: 'connection' });
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('error');
  });
});
