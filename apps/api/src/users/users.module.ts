import { ApprovalEngineModule } from '../approvals/approval-engine.module';
import { AuthRepositoryModule } from '../auth/auth-repository.module';
import { UserRouteCommands } from './user-route.commands';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';
import { PrismaUsersRepository } from './prisma-users.repository';

// CacheManager and TRANSACTION_MANAGER come from the global CacheModule / PrismaModule.forRoot.
@Module({
  imports: [ApprovalEngineModule, AuthRepositoryModule, PrismaModule],
  controllers: [AdminUsersController],
  providers: [UserRouteCommands, PrismaUsersRepository, UsersAdminService],
})
export class UsersModule {}
