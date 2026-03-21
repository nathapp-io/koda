/**
 * US-004 — Services must throw AppException, not raw NestJS HTTP exceptions
 *
 * AC: No throw new NotFoundException(...), ForbiddenException(...),
 *     UnauthorizedException(...), BadRequestException(...), or
 *     ConflictException(...) in apps/api/src/**
 *
 * These tests are RED until each service replaces its HTTP exceptions with
 * AppException calls carrying i18n keys.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppException } from '@nathapp/nestjs-common';
import { AuthService } from '../../src/auth/auth.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { AgentsService } from '../../src/agents/agents.service';
import { TicketsService } from '../../src/tickets/tickets.service';
import { CommentsService } from '../../src/comments/comments.service';
import { LabelsService } from '../../src/labels/labels.service';

// ── helpers ──────────────────────────────────────────────────────────────────

async function collectThrownError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function assertIsAppException(err: unknown): void {
  expect(err).toBeInstanceOf(AppException);
  expect(err).not.toBeInstanceOf(NotFoundException);
  expect(err).not.toBeInstanceOf(ForbiddenException);
  expect(err).not.toBeInstanceOf(UnauthorizedException);
  expect(err).not.toBeInstanceOf(BadRequestException);
  expect(err).not.toBeInstanceOf(ConflictException);
}

// ── AuthService ───────────────────────────────────────────────────────────────

describe('AuthService — throws AppException (US-004)', () => {
  let service: AuthService;

  const mockPrisma = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockJwtService = {
    signAsync: jest.fn().mockResolvedValue('token'),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('secret'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: 'PrismaService', useValue: mockPrisma },
        { provide: 'JwtService', useValue: mockJwtService },
        { provide: 'ConfigService', useValue: mockConfigService },
      ],
    })
      .overrideProvider(AuthService)
      .useFactory({
        factory: () =>
          new (AuthService as any)(mockPrisma, mockJwtService, mockConfigService),
      })
      .compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  it('login — throws AppException (not UnauthorizedException) for invalid credentials', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const err = await collectThrownError(() =>
      service.login({ email: 'x@x.com', password: 'wrong' }),
    );

    assertIsAppException(err);
    expect((err as AppException).i18nKey).toBe('auth.invalidCredentials');
  });
});

// ── ProjectsService ───────────────────────────────────────────────────────────

describe('ProjectsService — throws AppException (US-004)', () => {
  let service: ProjectsService;

  const mockPrisma = {
    project: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: 'PrismaService', useValue: mockPrisma },
      ],
    })
      .overrideProvider(ProjectsService)
      .useFactory({
        factory: () => new (ProjectsService as any)(mockPrisma),
      })
      .compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('create — throws AppException (not BadRequestException) for short name', async () => {
    const err = await collectThrownError(() =>
      service.create({ name: 'X', slug: 'x', key: 'XX' }),
    );
    assertIsAppException(err);
  });

  it('create — throws AppException (not BadRequestException) for invalid slug', async () => {
    const err = await collectThrownError(() =>
      service.create({ name: 'Valid', slug: 'UPPER_CASE', key: 'XX' }),
    );
    assertIsAppException(err);
  });

  it('create — throws AppException (not BadRequestException) for invalid key', async () => {
    const err = await collectThrownError(() =>
      service.create({ name: 'Valid', slug: 'valid', key: 'x' }),
    );
    assertIsAppException(err);
  });

  it('create — throws AppException (not ConflictException) for duplicate slug', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'existing' });

    const err = await collectThrownError(() =>
      service.create({ name: 'Valid', slug: 'existing', key: 'XX' }),
    );
    assertIsAppException(err);
  });

  it('findBySlug — throws AppException (not NotFoundException) when project missing', async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);

    const err = await collectThrownError(() => service.findBySlug('no-such-slug'));
    assertIsAppException(err);
  });
});

// ── AgentsService ─────────────────────────────────────────────────────────────

describe('AgentsService — throws AppException (US-004)', () => {
  let service: AgentsService;

  const mockPrisma = {
    agent: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    agentRoleEntry: { deleteMany: jest.fn(), createMany: jest.fn() },
    agentCapability: { deleteMany: jest.fn(), createMany: jest.fn() },
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('hmac-secret'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: 'PrismaService', useValue: mockPrisma },
        { provide: 'ConfigService', useValue: mockConfigService },
      ],
    })
      .overrideProvider(AgentsService)
      .useFactory({
        factory: () => new (AgentsService as any)(mockPrisma, mockConfigService),
      })
      .compile();

    service = module.get<AgentsService>(AgentsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('findBySlug — throws AppException (not NotFoundException) when agent missing', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue(null);

    const err = await collectThrownError(() => service.findBySlug('no-such-agent'));
    assertIsAppException(err);
  });
});

// ── TicketsService ────────────────────────────────────────────────────────────

describe('TicketsService — throws AppException (US-004)', () => {
  let service: TicketsService;

  const mockPrisma = {
    project: { findUnique: jest.fn() },
    ticket: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    ticketActivity: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: 'PrismaService', useValue: mockPrisma },
      ],
    })
      .overrideProvider(TicketsService)
      .useFactory({
        factory: () => new (TicketsService as any)(mockPrisma),
      })
      .compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('findByRef — throws AppException (not NotFoundException) when project missing', async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);

    const err = await collectThrownError(() => service.findByRef('no-project', 'NOPE-1'));
    assertIsAppException(err);
  });

  it('findByRef — throws AppException (not NotFoundException) when ticket missing', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    mockPrisma.ticket.findUnique.mockResolvedValue(null);
    mockPrisma.ticket.findFirst.mockResolvedValue(null);

    const err = await collectThrownError(() => service.findByRef('koda', 'KODA-999'));
    assertIsAppException(err);
  });
});

// ── CommentsService ───────────────────────────────────────────────────────────

describe('CommentsService — throws AppException (US-004)', () => {
  let service: CommentsService;

  const mockPrisma = {
    project: { findUnique: jest.fn() },
    ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
    comment: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: 'PrismaService', useValue: mockPrisma },
      ],
    })
      .overrideProvider(CommentsService)
      .useFactory({
        factory: () => new (CommentsService as any)(mockPrisma),
      })
      .compile();

    service = module.get<CommentsService>(CommentsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('update — throws AppException (not NotFoundException) when comment missing', async () => {
    mockPrisma.comment.findUnique.mockResolvedValue(null);

    const err = await collectThrownError(() =>
      service.update('no-id', { body: 'x' }, { sub: 'u-1', role: 'MEMBER' }, 'user'),
    );
    assertIsAppException(err);
  });

  it('update — throws AppException (not ForbiddenException) for non-author non-admin', async () => {
    mockPrisma.comment.findUnique.mockResolvedValue({
      id: 'c-1',
      authorUserId: 'other-user',
      authorAgentId: null,
    });

    const err = await collectThrownError(() =>
      service.update('c-1', { body: 'x' }, { sub: 'user-1', role: 'MEMBER' }, 'user'),
    );
    assertIsAppException(err);
  });
});

// ── LabelsService ─────────────────────────────────────────────────────────────

describe('LabelsService — throws AppException (US-004)', () => {
  let service: LabelsService;

  const mockPrisma = {
    project: { findUnique: jest.fn() },
    ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
    label: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    ticketLabel: { create: jest.fn(), delete: jest.fn() },
    ticketActivity: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelsService,
        { provide: 'PrismaService', useValue: mockPrisma },
      ],
    })
      .overrideProvider(LabelsService)
      .useFactory({
        factory: () => new (LabelsService as any)(mockPrisma),
      })
      .compile();

    service = module.get<LabelsService>(LabelsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('create — throws AppException (not ForbiddenException) for non-admin user', async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: 'proj-1' });

    const err = await collectThrownError(() =>
      service.create('koda', { name: 'bug', color: '#f00' }, { sub: 'u-1', role: 'MEMBER' }, 'user'),
    );
    assertIsAppException(err);
  });
});
