import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface MailgunAdapterConfig {
  apiKey: string;
  domain: string;
  /** 'api.mailgun.net' for US, 'api.eu.mailgun.net' for EU. Default: 'api.mailgun.net' */
  host?:  string;
}

export class MailgunAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: MailgunAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email  = payload.raw as EmailPayload;
    const host   = this.config.host ?? 'api.mailgun.net';
    const auth   = Buffer.from(`api:${this.config.apiKey}`).toString('base64');
    const form   = new URLSearchParams({
      from:    email.from,
      to:      email.to.join(','),
      subject: email.subject,
      html:    email.html,
      text:    email.text,
    });

    const response = await fetch(
      `https://${host}/v3/${this.config.domain}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    form.toString(),
      },
    );
    if (!response.ok) {
      throw new Error(`Mailgun error ${response.status}: ${await response.text()}`);
    }
  }
}
