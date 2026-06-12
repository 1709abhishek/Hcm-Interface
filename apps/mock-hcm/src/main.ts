import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

async function bootstrap() {
  const app = await NestFactory.create(MockHcmModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();
