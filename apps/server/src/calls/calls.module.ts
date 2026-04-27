import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
