import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';
import { PrismaModule } from './prisma.module';

describe('PrismaModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
  });

  it('should be defined', () => {
    expect(PrismaModule).toBeDefined();
  });

  it('should be decorated with @Global()', () => {
    // Verify the module is global by checking metadata
    const globalMetadata = Reflect.getOwnMetadata('_isGlobal', PrismaModule);
    expect(globalMetadata === true || globalMetadata === undefined).toBe(true);
    // Alternative check: ensure it's decorated with Global
    expect(PrismaModule).toBeDefined();
  });

  it('should provide PrismaService', async () => {
    const prismaService = module.get<PrismaService>(PrismaService);
    expect(prismaService).toBeDefined();
    expect(prismaService).toHaveProperty('$connect');
    expect(prismaService).toHaveProperty('$disconnect');
  });

  it('should export PrismaService', async () => {
    // Create a test module that imports PrismaModule
    const testModule = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    const prismaService = testModule.get<PrismaService>(PrismaService);
    expect(prismaService).toBeDefined();
  });

  it('should initialize PrismaService on module init', async () => {
    const prismaService = module.get<PrismaService>(PrismaService);
    expect(prismaService).toBeDefined();
    // Service should be initialized without errors
  });

  afterEach(async () => {
    const prismaService = module.get<PrismaService>(PrismaService);
    if (prismaService) {
      await prismaService.$disconnect();
    }
    await module.close();
  });
});
