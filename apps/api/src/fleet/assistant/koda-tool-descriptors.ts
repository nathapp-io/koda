import type { KodaToolDescriptor } from '@nathapp/fleet-protocol';

/**
 * The koda tool descriptors a THREAD ASSIGN carries. A plain module, so placement code can import it without
 * importing the assistant module (1b-D3). Each tool group appends its descriptors here.
 */
export const KODA_TOOL_DESCRIPTORS: readonly KodaToolDescriptor[] = [];
