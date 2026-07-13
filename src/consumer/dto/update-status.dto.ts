import { IsEnum } from 'class-validator';
import { TrackerEventStatus } from '../../common/types';

export class UpdateStatusDto {
  @IsEnum(TrackerEventStatus)
  status!: TrackerEventStatus;
}
