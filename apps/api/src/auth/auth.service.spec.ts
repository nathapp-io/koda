import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/app-exception';
import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: PrismaService;
  let _configService: ConfigService;
  let jwtService: JwtService;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed-password',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockJwtService = {
    signAsync: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prismaService = module.get<PrismaService>(PrismaService);
    _configService = module.get<ConfigService>(ConfigService);
    jwtService = module.get<JwtService>(JwtService);

    // Default mock values
    mockJwtService.signAsync.mockResolvedValue('mock-token');
    mockConfigService.get.mockReturnValue('7d');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should create a new user with bcrypt hashed password', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      };

      mockPrismaService.user.create.mockResolvedValue(mockUser);

      const result = await service.register(registerDto);

      expect(prismaService.user.create).toHaveBeenCalled();
      const createCall = (prismaService.user.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.email).toBe(registerDto.email);
      expect(createCall.data.name).toBe(registerDto.name);

      // Verify bcrypt was used (passwordHash should not be plaintext)
      const hashedPassword = createCall.data.passwordHash;
      expect(hashedPassword).not.toBe(registerDto.password);
      expect(await bcrypt.compare(registerDto.password, hashedPassword)).toBe(true);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });

    it('should return tokens and user data', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'password123',
      };

      mockPrismaService.user.create.mockResolvedValue(mockUser);

      const result = await service.register(registerDto);

      // Should not return passwordHash
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user.email).toBe(mockUser.email);
      expect(result.user.name).toBe(mockUser.name);
      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });
  });

  describe('login', () => {
    it('should return tokens for valid credentials', async () => {
      const password = 'password123';
      const hashedPassword = await bcrypt.hash(password, 12);
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockPrismaService.user.findUnique.mockResolvedValue(userWithHash);

      const result = await service.login({
        email: mockUser.email,
        password,
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(mockUser.email);
    });

    it('should throw 401 error for invalid password', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      await expect(
        service.login({
          email: mockUser.email,
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(AppException);
    });

    it('should throw 401 error for non-existent user', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'nonexistent@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('refresh', () => {
    it('should return new tokens with valid refresh token', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.refresh({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });
  });

  describe('validateUser', () => {
    it('should return user for valid JWT payload', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.validateUser({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(result).toEqual(mockUser);
      expect(prismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id },
      });
    });

    it('should return null if user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 'nonexistent-id',
        email: 'nonexistent@example.com',
        role: 'MEMBER',
      });

      expect(result).toBeNull();
    });
  });

  describe('JWT token generation', () => {
    it('should generate access token with correct payload', async () => {
      const token = await service.generateAccessToken(mockUser.id, mockUser.email, mockUser.role);

      expect(token).toBe('mock-token');
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        {
          sub: mockUser.id,
          email: mockUser.email,
          role: mockUser.role,
        },
        expect.any(Object),
      );
    });

    it('should generate refresh token', async () => {
      const token = await service.generateRefreshToken(mockUser.id);

      expect(token).toBe('mock-token');
      expect(jwtService.signAsync).toHaveBeenCalledWith(
        {
          sub: mockUser.id,
        },
        expect.any(Object),
      );
    });

    it('should include sub, email, and role in JWT payload', async () => {
      // Decode token manually to verify payload
      const token = await service.generateAccessToken(mockUser.id, mockUser.email, 'ADMIN');

      expect(token).toBe('mock-token');
      const callArgs = (jwtService.signAsync as jest.Mock).mock.calls[0][0];
      expect(callArgs.sub).toBe(mockUser.id);
      expect(callArgs.email).toBe(mockUser.email);
      expect(callArgs.role).toBe('ADMIN');
    });
  });
});
