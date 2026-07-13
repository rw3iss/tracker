import type { Repository } from 'typeorm';
import { TrackerEventStatus } from '../../../common/types';
import type { StoredTrackerEvent } from '../../../common/types';
import type { DistinctField, ITrackerStorage, ITrackerStorageFilter } from '../ITrackerStorage';
import type { TrackerEventRow } from './TrackerEventEntity';

const DISTINCT_COLUMNS: Record<DistinctField, string> = {
    appId:       'e.appId',
    category:    'e.category',
    type:        'e.type',
    status:      'e.status',
    environment: "e.context->>'environment'",
};

export class TypeOrmTrackerStorage implements ITrackerStorage {
  constructor(private readonly repo: Repository<TrackerEventRow>) {}

  async save(event: StoredTrackerEvent): Promise<void> {
    await this.repo.save(this.toEntity(event));
  }

  async saveBatch(events: StoredTrackerEvent[]): Promise<void> {
    await this.repo.save(events.map((e) => this.toEntity(e)));
  }

  async find(filters: ITrackerStorageFilter = {}): Promise<StoredTrackerEvent[]> {
    const allowedSortColumns = ['id', 'type', 'message', 'appId', 'category', 'status', 'timestamp', 'receivedAt'];
    const sortBy = filters.sortBy && allowedSortColumns.includes(filters.sortBy) ? filters.sortBy : 'receivedAt';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    const qb = this.repo.createQueryBuilder('e').orderBy(`e.${sortBy}`, sortDir as 'ASC' | 'DESC');

    // Exact-match filters preserve programmatic-caller semantics.
    if (filters.appId)       qb.andWhere('e.appId = :appId',       { appId:    filters.appId });
    if (filters.appIds && filters.appIds.length > 0) {
      qb.andWhere('e.appId IN (:...appIdList)', { appIdList: filters.appIds });
    }
    if (filters.type)        qb.andWhere('e.type = :type',         { type:     filters.type });
    if (filters.types && filters.types.length > 0) {
      qb.andWhere('e.type IN (:...typeList)', { typeList: filters.types });
    }
    if (filters.status)      qb.andWhere('e.status = :status',     { status:   filters.status });
    if (filters.category)    qb.andWhere('e.category = :category', { category: filters.category });
    if (filters.categories && filters.categories.length > 0) {
      qb.andWhere('e.category IN (:...categoryList)', { categoryList: filters.categories });
    }
    if (filters.from)        qb.andWhere('e.receivedAt >= :from',  { from:     filters.from });
    if (filters.to)          qb.andWhere('e.receivedAt <= :to',    { to:       filters.to });
    if (filters.userId)      qb.andWhere("e.context->>'userId' = :userId",       { userId: filters.userId });
    if (filters.environment) qb.andWhere("e.context->>'environment' = :env",     { env:    filters.environment });
    // Substring (ILIKE) filters used by the dashboard's loose search.
    const like = (v: string) => `%${v.replace(/[\\%_]/g, m => '\\' + m)}%`;
    if (filters.appIdContains)       qb.andWhere('e.appId ILIKE :appIdC',     { appIdC:    like(filters.appIdContains) });
    if (filters.categoryContains)    qb.andWhere('e.category ILIKE :categoryC', { categoryC: like(filters.categoryContains) });
    if (filters.userIdContains)      qb.andWhere("e.context->>'userId' ILIKE :userIdC",       { userIdC: like(filters.userIdContains) });
    if (filters.environmentContains) qb.andWhere("e.context->>'environment' ILIKE :envC",     { envC:    like(filters.environmentContains) });
    if (filters.tags?.length) {
      filters.tags.forEach((tag, i) => {
        qb.andWhere(`e.tags LIKE :tag${i}`, { [`tag${i}`]: `%${tag}%` });
      });
    }
    if (filters.payloadFilters) {
      let pIdx = 0;
      for (const [key, value] of Object.entries(filters.payloadFilters)) {
        qb.andWhere(`e.payload->>'${key.replace(/'/g, "''")}' = :pf${pIdx}`, { [`pf${pIdx}`]: value });
        pIdx++;
      }
    }

    qb.limit(filters.limit ?? 100).offset(filters.offset ?? 0);

    return (await qb.getMany()).map((e) => this.toStored(e));
  }

  async findById(id: string): Promise<StoredTrackerEvent | null> {
    const e = await this.repo.findOne({ where: { id } });
    return e ? this.toStored(e) : null;
  }

  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    await this.repo.update(id, { status });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  /**
   * Delete events matching the filter (no filter = clear the table).
   * Uses TypeORM's QueryBuilder so the filter set composes with the
   * same expressions `find()` already supports. Returns the affected
   * row count.
   */
  async clear(filters: ITrackerStorageFilter = {}): Promise<number> {
    const qb = this.repo.createQueryBuilder().delete().from(this.repo.metadata.tableName);

    if (filters.appId)       qb.andWhere('"appId" = :appId',     { appId: filters.appId });
    if (filters.appIds && filters.appIds.length > 0) {
      qb.andWhere('"appId" IN (:...appIdList)', { appIdList: filters.appIds });
    }
    if (filters.type)        qb.andWhere('"type" = :type',       { type:    filters.type });
    if (filters.types && filters.types.length > 0) {
      qb.andWhere('"type" IN (:...typeList)', { typeList: filters.types });
    }
    if (filters.status)      qb.andWhere('"status" = :status',   { status:  filters.status });
    if (filters.category)    qb.andWhere('"category" = :category', { category: filters.category });
    if (filters.categories && filters.categories.length > 0) {
      qb.andWhere('"category" IN (:...categoryList)', { categoryList: filters.categories });
    }
    if (filters.from)        qb.andWhere('"receivedAt" >= :from', { from:    filters.from });
    if (filters.to)          qb.andWhere('"receivedAt" <= :to',   { to:      filters.to });
    if (filters.userId)      qb.andWhere(`"context"->>'userId' = :userId`,           { userId: filters.userId });
    if (filters.environment) qb.andWhere(`"context"->>'environment' = :env`,         { env:    filters.environment });

    const result = await qb.execute();
    return result.affected ?? 0;
  }

  async distinct(
    field: DistinctField,
    opts?: { limit?: number; sinceMs?: number },
  ): Promise<Array<{ value: string; count: number }>> {
    const expr  = DISTINCT_COLUMNS[field];
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 2000));
    const qb = this.repo
      .createQueryBuilder('e')
      .select(`${expr}`, 'value')
      .addSelect('COUNT(*)::int', 'count')
      .where(`${expr} IS NOT NULL`)
      .andWhere(`${expr} <> ''`)
      .groupBy(expr)
      .orderBy('count', 'DESC')
      .addOrderBy('value', 'ASC')
      .limit(limit);
    if (opts?.sinceMs !== undefined) {
      qb.andWhere('e.receivedAt >= :since', { since: opts.sinceMs });
    }
    const rows = await qb.getRawMany<{ value: string; count: number | string }>();
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  private toEntity(event: StoredTrackerEvent): Partial<TrackerEventRow> {
    return {
      id:         event.id,
      type:       event.type,
      message:    event.message,
      appId:      event.appId ?? null,
      category:   event.category ?? null,
      status:     event.status,
      payload:    event.payload ?? null,
      error:      event.error ?? null,
      context:    event.context ?? null,
      tags:       event.tags ?? [],
      timestamp:  event.timestamp,
      receivedAt: event.receivedAt,
    };
  }

  private toStored(e: TrackerEventRow): StoredTrackerEvent {
    return {
      id:         e.id,
      type:       e.type as StoredTrackerEvent['type'],
      message:    e.message,
      appId:      e.appId ?? undefined,
      category:   e.category ?? undefined,
      status:     e.status,
      payload:    e.payload ?? undefined,
      error:      e.error ?? undefined,
      context:    e.context ?? undefined,
      tags:       e.tags ?? [],
      timestamp:  e.timestamp,
      receivedAt: e.receivedAt,
    };
  }
}
