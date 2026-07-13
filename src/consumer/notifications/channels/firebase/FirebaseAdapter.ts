import type { IFirebaseAdapter } from '../ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { FirebasePayload } from '../../types';

export interface FirebaseAdapterConfig {
  /** Service account object from your Firebase project (imported from JSON). */
  serviceAccount: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFirebaseAdmin = any;

/**
 * Firebase Cloud Messaging adapter using the FCM HTTP v1 API via firebase-admin.
 * firebase-admin must be installed in the consuming project.
 */
export class FirebaseAdapter implements IFirebaseAdapter {
  readonly channelType = 'firebase' as const;
  private adminApp: AnyFirebaseAdmin = null;

  constructor(private readonly config: FirebaseAdapterConfig) {}

  private async getAdmin(): Promise<AnyFirebaseAdmin> {
    // Dynamic require to avoid compile-time dependency on firebase-admin
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('firebase-admin') as AnyFirebaseAdmin;
  }

  private async getApp(): Promise<AnyFirebaseAdmin> {
    if (!this.adminApp) {
      const admin = await this.getAdmin();
      const appName = `tracker-notifications-${Date.now()}`;
      this.adminApp = admin.initializeApp(
        { credential: admin.credential.cert(this.config.serviceAccount) },
        appName,
      );
    }
    return this.adminApp;
  }

  async send(payload: FormattedNotification): Promise<void> {
    const fcm   = payload.raw as FirebasePayload;
    const app   = await this.getApp();
    const admin = await this.getAdmin();

    const response = await admin.messaging(app).sendEachForMulticast({
      tokens:       fcm.tokens,
      notification: { title: fcm.title, body: fcm.body },
      data:         fcm.data,
    });

    const failed = response.responses.filter((r: AnyFirebaseAdmin) => !r.success);
    if (failed.length > 0) {
      throw new Error(
        `Firebase FCM: ${failed.length}/${fcm.tokens.length} sends failed: ` +
          failed.map((r: AnyFirebaseAdmin) => r.error?.message).join('; '),
      );
    }
  }
}
