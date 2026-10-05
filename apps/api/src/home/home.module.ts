import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { HomeController } from './home.controller';
import { HOME_REPOSITORY } from './home.domain';
import { HomeService } from './home.service';
import { PrismaHomeRepository } from './prisma-home.repository';

/** UX redesign slice 2: the cross-project dashboard snapshot behind GET /home (MASTER-PLAN §6). */
@Module({
  imports: [PrismaModule],
  controllers: [HomeController],
  providers: [PrismaHomeRepository, { provide: HOME_REPOSITORY, useExisting: PrismaHomeRepository }, HomeService],
})
export class HomeModule {}
