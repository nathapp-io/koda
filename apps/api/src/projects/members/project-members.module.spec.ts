import { Test } from '@nestjs/testing';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';

describe('ProjectMembersModule — DI wiring', () => {
  it('ProjectMembersController resolves with its service', async () => {
    const module = await Test.createTestingModule({
      controllers: [ProjectMembersController],
      providers: [{ provide: ProjectMembersService, useValue: {} }],
    }).compile();
    expect(module.get(ProjectMembersController)).toBeDefined();
    await module.close();
  });
});
