import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TasksController } from './tasks.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TasksController],
})
export class TasksModule {}
