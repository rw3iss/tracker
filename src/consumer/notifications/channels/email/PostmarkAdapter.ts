import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface PostmarkAdapterConfig {
  serverToken: string;
}

export class PostmarkAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: PostmarkAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': this.config.serverToken,
        'Content-Type':            'application/json',
        Accept:                    'application/json',
      },
      body: JSON.stringify({
        From:     email.from,
        To:       email.to.join(','),
        Subject:  email.subject,
        HtmlBody: email.html,
        TextBody: email.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Postmark error ${response.status}: ${await response.text()}`);
    }
  }
}
