import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** How many rows one export answers when the caller names no `take`. */
export const MEMORY_EXPORT_TAKE_DEFAULT = 100;
/** The largest page an export answers; a mirror pages again with the cursor it was given. */
export const MEMORY_EXPORT_TAKE_MAX = 500;

/**
 * The export feed's query (memory-notes US-006): `GET /projects/:slug/memory/export?since=&take=`.
 *
 * `since` is the opaque cursor of the last row the caller already holds — `decodeMemoryExportCursor`
 * decides whether it is one this API produced, and the route answers 400 naming `since` when it is not.
 * An omitted (or blank) `since` asks for the feed from its beginning. `take` is 1..500 and defaults to
 * 100; the global `ValidationPipe` reads these decorators, and `parseQuery` turns the query strings into
 * the numbers the handler passes on.
 */
export class ExportMemoryQuery {
  @ApiPropertyOptional({ description: 'Cursor of the last row already held; omit to export from the beginning' })
  @IsOptional()
  @IsString()
  since?: string;

  @ApiPropertyOptional({
    description: 'Rows to answer (1..500)',
    default: MEMORY_EXPORT_TAKE_DEFAULT,
    minimum: 1,
    maximum: MEMORY_EXPORT_TAKE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEMORY_EXPORT_TAKE_MAX)
  take: number = MEMORY_EXPORT_TAKE_DEFAULT;
}
