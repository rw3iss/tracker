import type { ISmsAdapter } from '../ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { SmsPayload } from '../../types';

export interface TwilioSmsAdapterConfig {
  accountSid: string;
  authToken:  string;
  from:       string;
}

export class TwilioSmsAdapter implements ISmsAdapter {
  readonly channelType = 'sms' as const;

  constructor(private readonly config: TwilioSmsAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const sms  = payload.raw as SmsPayload;
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;

    const errors: string[] = [];
    await Promise.allSettled(
      sms.to.map(async (to) => {
        const form = new URLSearchParams({ From: this.config.from, To: to, Body: sms.body });
        const response = await fetch(url, {
          method:  'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    form.toString(),
        });
        if (!response.ok) {
          errors.push(`${to}: ${response.status} ${await response.text()}`);
        }
      }),
    );
    if (errors.length > 0) {
      throw new Error(`Twilio errors: ${errors.join('; ')}`);
    }
  }
}
