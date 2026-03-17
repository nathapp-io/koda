import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

describe('PrismaService Integration Tests', () => {
  let module: TestingModule;
  let prismaService: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should connect to the database on module init', async () => {
    expect(prismaService).toBeDefined();
  });

  it('should allow user.count() to return 0 without error', async () => {
    const count = await prismaService.user.count();
    expect(count).toBe(0);
  });

  it('should have User model available', async () => {
    expect(prismaService.user).toBeDefined();
    expect(typeof prismaService.user.count).toBe('function');
  });

  afterAll(async () => {
    await module.close();
  });
});
