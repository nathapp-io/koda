import { AppException } from '@nathapp/nestjs-common';
import { SUPPORTED_FLEET_PROTOCOL_VERSIONS } from '../common/protocol';

/** 426 Upgrade Required: the runner speaks a protocol version this API does not (spec §1). */
export class ProtocolVersionException extends AppException {
  constructor(version: unknown) {
    super(426, { version: String(version), supported: SUPPORTED_FLEET_PROTOCOL_VERSIONS.join(', ') }, 'fleet.protocol', 426);
  }
}
