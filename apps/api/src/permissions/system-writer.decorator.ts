import { SetMetadata } from '@nestjs/common';
import { findCatalogEntry } from './catalog';

export const SYSTEM_WRITER_METADATA = 'koda:system-writer';

/**
 * Declares the catalog key of a class that writes on the system's own behalf (a sweeper, a cron
 * processor, an outbox subscriber, a webhook intake). The catalog contract test reads it back.
 * Throws at decoration time unless `key` is a catalog key with access `system`.
 */
export const SystemWriter = (key: string): ClassDecorator => {
  if (findCatalogEntry(key)?.access !== 'system') {
    throw new Error(`@SystemWriter needs a system catalog key, got '${key}'`);
  }
  return SetMetadata(SYSTEM_WRITER_METADATA, key);
};
