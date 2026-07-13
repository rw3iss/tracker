export const NotificationCategory = {
  NotificationFailed: 'notification-failed',
} as const;

export type NotificationCategoryValue =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];
