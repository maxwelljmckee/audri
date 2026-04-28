import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TodosController } from './todos.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TodosController],
})
export class TodosModule {}
