import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { OutboxRouteCommands } from './outbox-route.commands';
import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { OutboxAdminService } from './outbox-admin.service';
import { OutboxModule } from './outbox.module';

/** Admin HTTP surface for the outbox, kept out of the domain module so OutboxModule compiles without auth wiring. */
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, OutboxModule],
  controllers: [AdminController],
  providers: [OutboxRouteCommands, OutboxAdminService],
})
export class OutboxAdminModule {}
