import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

async function bootstrap() {
  const app = await NestFactory.create(MockHcmModule);
  await app.listen(process.env.MOCK_HCM_PORT ?? 3001);
}
void bootstrap();
