import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface SmtpAdapterConfig {
  host:   string;
  port:   number;
  secure: boolean;
  auth:   { user: string; pass: string };
}

export class SmtpAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;
  private transporter: import('nodemailer').Transporter | null = null;

  constructor(private readonly config: SmtpAdapterConfig) {}

  private async getTransporter(): Promise<import('nodemailer').Transporter> {
    if (!this.transporter) {
      const nodemailer = await import('nodemailer');
      this.transporter = nodemailer.createTransport(this.config);
    }
    return this.transporter;
  }

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const transport = await this.getTransporter();
    await transport.sendMail({
      from:    email.from,
      to:      email.to.join(', '),
      subject: email.subject,
      html:    email.html,
      text:    email.text,
    });
  }
}
