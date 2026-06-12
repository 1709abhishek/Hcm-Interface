import { Injectable } from '@nestjs/common';

@Injectable()
export class MockHcmService {
  getHello(): string {
    return 'Hello World!';
  }
}
