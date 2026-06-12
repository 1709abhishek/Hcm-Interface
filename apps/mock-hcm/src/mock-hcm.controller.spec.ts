import { Test, TestingModule } from '@nestjs/testing';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmService } from './mock-hcm.service';

describe('MockHcmController', () => {
  let mockHcmController: MockHcmController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [MockHcmController],
      providers: [MockHcmService],
    }).compile();

    mockHcmController = app.get<MockHcmController>(MockHcmController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(mockHcmController.getHello()).toBe('Hello World!');
    });
  });
});
