import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should extend PrismaClient', () => {
    // Check that service has PrismaClient methods
    expect(service).toHaveProperty('$connect');
    expect(service).toHaveProperty('$disconnect');
    expect(service).toHaveProperty('user');
  });

  it('should implement OnModuleInit interface', () => {
    expect(service).toHaveProperty('onModuleInit');
    expect(typeof service.onModuleInit).toBe('function');
  });

  it('should implement OnModuleDestroy interface', () => {
    expect(service).toHaveProperty('onModuleDestroy');
    expect(typeof service.onModuleDestroy).toBe('function');
  });

  it('should call $connect on onModuleInit', async () => {
    const connectSpy = jest.spyOn(service, '$connect').mockResolvedValue(undefined);

    await service.onModuleInit();

    expect(connectSpy).toHaveBeenCalled();

    connectSpy.mockRestore();
  });

  it('should call $disconnect on onModuleDestroy', async () => {
    const disconnectSpy = jest.spyOn(service, '$disconnect').mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(disconnectSpy).toHaveBeenCalled();

    disconnectSpy.mockRestore();
  });

  describe('Database operations', () => {
    // Note: These tests assume we can call user.count() without error
    // The actual connection happens during module init in the integration test
    it('should have user model available', () => {
      expect(service.user).toBeDefined();
    });
  });

  afterEach(async () => {
    await service.$disconnect();
  });
});
