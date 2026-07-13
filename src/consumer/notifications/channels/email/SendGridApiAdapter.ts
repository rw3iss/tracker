import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface SendGridApiAdapterConfig {
  apiKey: string;
}

export class SendGridApiAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: SendGridApiAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: email.to.map((e) => ({ email: e })) }],
        from: { email: email.from },
        subject: email.subject,
        content: [
          { type: 'text/html',  value: email.html },
          { type: 'text/plain', value: email.text },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`SendGrid error ${response.status}: ${await response.text()}`);
    }
  }
}
