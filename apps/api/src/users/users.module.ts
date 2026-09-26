import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';
import { PrismaUsersRepository } from './prisma-users.repository';

// CacheManager and TRANSACTION_MANAGER come from the global CacheModule / PrismaModule.forRoot.
@Module({
  imports: [PrismaModule],
  controllers: [AdminUsersController],
  providers: [PrismaUsersRepository, UsersAdminService],
})
export class UsersModule {}
