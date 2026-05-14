import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AutomationsController } from './automations.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [AutomationsController],
})
export class AutomationsModule {}
