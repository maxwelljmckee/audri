import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StorageController } from './storage.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [StorageController],
})
export class StorageModule {}
