import type { INotificationAdapter } from '../../INotificationAdapter';

export interface IEmailAdapter extends INotificationAdapter {
  readonly channelType: 'email';
}
