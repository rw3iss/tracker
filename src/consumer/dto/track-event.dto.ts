import {
  IsArray, IsEnum, IsNumber, IsObject, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { EventType } from '../../common/types';

class SerializedErrorPreviousDto {
  @IsString() name!: string;
  @IsString() message!: string;
  @IsOptional() @IsString() file?: string;
  @IsOptional() @IsNumber() line?: number;
  @IsOptional() code?: string | number;
}

class SerializedErrorDto {
  @IsString() name!: string;
  @IsString() message!: string;
  @IsOptional() @IsString() stack?: string;
  @IsOptional() @IsString() file?: string;
  @IsOptional() @IsNumber() line?: number;
  @IsOptional() code?: string | number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SerializedErrorPreviousDto)
  previous?: SerializedErrorPreviousDto[];
}

class TrackerContextDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() sessionId?: string;
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() userAgent?: string;
}

export class TrackEventDto {
  @IsEnum(['error', 'warning', 'info', 'debug', 'event'] as const) type!: EventType;
  @IsString() message!: string;
  @IsOptional() @IsString() appId?: string;
  @IsOptional() @IsString() category?: string;
  @IsNumber() timestamp!: number;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => SerializedErrorDto) error?: SerializedErrorDto;
  @IsOptional() @ValidateNested() @Type(() => TrackerContextDto) context?: TrackerContextDto;
  @IsOptional() @IsString({ each: true }) tags?: string[];
}
