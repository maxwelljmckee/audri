import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UrlsController } from './urls.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [UrlsController],
})
export class UrlsModule {}
