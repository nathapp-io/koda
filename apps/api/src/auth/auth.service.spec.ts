import { Test, TestingModule } from '@nestjs/testing';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@nathapp/nestjs-common';
import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let authRepo: PrismaAuthRepository;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed-password',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAuthRepository = {
    findAnyUser: jest.fn(),
    createUser: jest.fn(),
    findUserByEmail: jest.fn(),
    findUserById: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockJwtStrategyProvider = {
    sign: jest.fn(),
  };

  const mockJwtRefreshStrategyProvider = {
    sign: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: JwtStrategyProvider, useValue: mockJwtStrategyProvider },
        { provide: JwtRefreshStrategyProvider, useValue: mockJwtRefreshStrategyProvider },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    authRepo = module.get<PrismaAuthRepository>(PrismaAuthRepository);

    // Default mock values
    mockJwtStrategyProvider.sign.mockReturnValue('mock-token');
    mockJwtRefreshStrategyProvider.sign.mockReturnValue('mock-token');
    mockAuthRepository.findAnyUser.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should create a new user with bcrypt hashed password', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'Password123!',
      };

      mockAuthRepository.createUser.mockResolvedValue(mockUser);

      const result = await service.register(registerDto);

      expect(authRepo.createUser).toHaveBeenCalled();
      const createCall = (authRepo.createUser as jest.Mock).mock.calls[0][0];
      expect(createCall.email).toBe(registerDto.email);
      expect(createCall.name).toBe(registerDto.name);

      // Verify bcrypt was used (passwordHash should not be plaintext)
      const hashedPassword = createCall.passwordHash;
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
        password: 'Password123!',
      };

      mockAuthRepository.createUser.mockResolvedValue(mockUser);

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
      const password = 'Password123!';
      const hashedPassword = await bcrypt.hash(password, 12);
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockAuthRepository.findUserByEmail.mockResolvedValue(userWithHash);

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
      mockAuthRepository.findUserByEmail.mockResolvedValue(mockUser);

      await expect(
        service.login({
          email: mockUser.email,
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(AppException);
    });

    it('should throw 401 error for non-existent user', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'nonexistent@example.com',
          password: 'Password123!',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('refresh', () => {
    it('should return new tokens with valid refresh token', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(mockUser);

      const result = await service.refresh({
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: [],
        extra: {},
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });
  });

  describe('validateUser', () => {
    it('should return user for valid JWT payload', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(mockUser);

      const result = await service.validateUser({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });

      expect(result).toEqual(mockUser);
      expect(authRepo.findUserById).toHaveBeenCalledWith(mockUser.id);
    });

    it('should return null if user not found', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(null);

      const result = await service.validateUser({
        sub: 'nonexistent-id',
        email: 'nonexistent@example.com',
        role: 'MEMBER',
      });

      expect(result).toBeNull();
    });
  });

  describe('JWT token generation', () => {
    it('should generate access token with correct payload', () => {
      const token = service.generateAccessToken(mockUser.id, mockUser.email, mockUser.role);

      expect(token).toBe('mock-token');
      expect(mockJwtStrategyProvider.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });
    });

    it('should generate refresh token', () => {
      const token = service.generateRefreshToken(mockUser.id);

      expect(token).toBe('mock-token');
      expect(mockJwtRefreshStrategyProvider.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
      });
    });

    it('should include sub, email, and role in JWT payload', () => {
      const token = service.generateAccessToken(mockUser.id, mockUser.email, 'ADMIN');

      expect(token).toBe('mock-token');
      const callArgs = (mockJwtStrategyProvider.sign as jest.Mock).mock.calls[0][0];
      expect(callArgs.sub).toBe(mockUser.id);
      expect(callArgs.email).toBe(mockUser.email);
      expect(callArgs.role).toBe('ADMIN');
    });
  });
});
