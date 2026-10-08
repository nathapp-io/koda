import { Global, Module } from '@nestjs/common';
import { ClockModule, IdGeneratorModule } from '@nathapp/nestjs-common';
import { TenantContextService } from '@nathapp/nestjs-tenant';

/**
 * Fleet S4b §1: what NotifyModule's default services inject but do not provide. TenantContextService is never
 * `run()` in koda, so `getTenantIdOrNull()` is null and the package's tenant-mismatch check is skipped.
 */
@Global()
@Module({
  imports: [ClockModule.register(), IdGeneratorModule.register()],
  providers: [TenantContextService],
  exports: [TenantContextService, ClockModule, IdGeneratorModule],
})
export class EmailPlatformModule {}
