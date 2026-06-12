import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { AppError } from './app-error';

@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let title = 'INTERNAL_ERROR';
    let detail: string | undefined;
    if (exception instanceof AppError) {
      status = exception.status;
      title = exception.code;
      detail = exception.detail;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = exception.message;
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title,
        status,
        ...(detail ? { detail } : {}),
      });
  }
}
