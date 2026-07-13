import type { StoredTrackerEvent } from '../../../common/types';
import type { INotificationStrategy } from '../INotificationStrategy';
import type { NotificationDispatcher } from '../NotificationDispatcher';
import { resolveOmitFromFailedEvent } from '../utils/resolveOmit';

export class NotifyOnErrorsStrategy implements INotificationStrategy {
  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): Promise<void> {
    if (event.type !== 'error') return;

    const omit = resolveOmitFromFailedEvent(event);

    await dispatcher.notify(
      {
        subject: `[Error] ${event.message}`,
        body:    event,
      },
      { omit, include: ['email', 'webhook'] },
    );
  }
}
