import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';
import type { ChannelType } from '../INotificationAdapter';

@Entity('tracker_unsent_notifications')
@Index(['channelType'])
@Index(['originalEventId'])
@Index(['createdAt'])
export class UnsentNotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  channelType!: ChannelType;

  @Column({ type: 'varchar', nullable: true })
  appId!: string | null;

  @Column({ type: 'text' })
  recipientInfo!: string;

  @Column({ type: 'text' })
  formattedPayload!: string;

  @Column({ type: 'text' })
  errorMessage!: string;

  @Column({ type: 'varchar', nullable: true })
  originalEventId!: string | null;

  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastAttemptAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
