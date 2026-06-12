// apps/time-off-service/src/requests/requests.controller.ts
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { RequestsService } from './requests.service';
import type { SubmitDto } from './requests.service';

@Controller('time-off-requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  submit(@Body() dto: SubmitDto, @Headers('idempotency-key') idempotencyKey: string) {
    return this.requests.submit(dto, idempotencyKey);
  }

  @Get()
  list(
    @Query('employeeId') employeeId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
  ) {
    return this.requests.list({ employeeId, locationId, status });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.requests.getById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: { managerId: string }) {
    return this.requests.approve(id, body.managerId);
  }

  @Post(':id/deny')
  @HttpCode(200)
  deny(@Param('id') id: string, @Body() body: { managerId: string }) {
    return this.requests.deny(id, body.managerId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.requests.cancel(id);
  }
}
