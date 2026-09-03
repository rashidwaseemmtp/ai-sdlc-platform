import { Module } from '@nestjs/common';
import { ConfigService, EventsService, PrismaService, TemporalService } from './core.js';
import { ProjectsController } from './projects.controller.js';
import { ApprovalsController } from './approvals.controller.js';
import { PlatformController } from './platform.controller.js';

@Module({
  controllers: [ProjectsController, ApprovalsController, PlatformController],
  providers: [ConfigService, PrismaService, TemporalService, EventsService],
})
export class AppModule {}
