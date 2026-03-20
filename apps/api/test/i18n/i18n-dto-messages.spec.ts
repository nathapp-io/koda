import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { RegisterDto } from '../../src/auth/dto/register.dto';
import { LoginDto } from '../../src/auth/dto/login.dto';
import { CreateAgentDto } from '../../src/agents/dto/create-agent.dto';
import { CreateProjectDto } from '../../src/projects/dto/create-project.dto';
import { UpdateProjectDto } from '../../src/projects/dto/update-project.dto';
import { CreateTicketDto } from '../../src/tickets/dto/create-ticket.dto';
import { UpdateTicketDto } from '../../src/tickets/dto/update-ticket.dto';
import { CreateCommentDto } from '../../src/comments/dto/create-comment.dto';
import { UpdateCommentDto } from '../../src/comments/dto/update-comment.dto';
import { CreateLabelDto } from '../../src/labels/dto/create-label.dto';
import { AssignLabelDto } from '../../src/labels/dto/assign-label.dto';

/**
 * i18n message keys must match $t(namespace.key) pattern.
 * Any hardcoded English string would fail this check.
 */
const I18N_KEY_PATTERN = /^\$t\(.+\)$/;

/** Collect all validation error messages for a given property. */
async function getMessagesFor(
  DtoClass: new () => object,
  data: Record<string, unknown>,
  property: string,
): Promise<string[]> {
  const instance = plainToInstance(DtoClass, data);
  const errors = await validate(instance as object);
  const err = errors.find((e) => e.property === property);
  if (!err) return [];
  return Object.values(err.constraints ?? {});
}

describe('DTO validation i18n message keys', () => {
  describe('RegisterDto', () => {
    it('should return i18n key for invalid email', async () => {
      const messages = await getMessagesFor(
        RegisterDto,
        { email: 'not-an-email', name: 'John', password: 'password123' },
        'email',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });

    it('should return i18n key for name too short', async () => {
      const messages = await getMessagesFor(
        RegisterDto,
        { email: 'a@b.com', name: '', password: 'password123' },
        'name',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });

    it('should return i18n key for password too short', async () => {
      const messages = await getMessagesFor(
        RegisterDto,
        { email: 'a@b.com', name: 'John', password: 'short' },
        'password',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('LoginDto', () => {
    it('should return i18n key for invalid email', async () => {
      const messages = await getMessagesFor(
        LoginDto,
        { email: 'not-valid', password: 'pass' },
        'email',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('CreateAgentDto', () => {
    it('should return i18n key for empty name', async () => {
      const messages = await getMessagesFor(
        CreateAgentDto,
        { name: '', slug: 'my-agent' },
        'name',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });

    it('should return i18n key for empty slug', async () => {
      const messages = await getMessagesFor(
        CreateAgentDto,
        { name: 'My Agent', slug: '' },
        'slug',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('CreateProjectDto', () => {
    it('should return i18n key for name too short', async () => {
      const messages = await getMessagesFor(
        CreateProjectDto,
        { name: 'a', slug: 'koda', key: 'KODA' },
        'name',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('UpdateProjectDto', () => {
    it('should return i18n key for name too short (when provided)', async () => {
      const messages = await getMessagesFor(
        UpdateProjectDto,
        { name: 'a' },
        'name',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('CreateTicketDto', () => {
    it('should return i18n key for empty title', async () => {
      const messages = await getMessagesFor(
        CreateTicketDto,
        { type: 'BUG', title: '' },
        'title',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('UpdateTicketDto', () => {
    it('should return i18n key for empty title (when provided)', async () => {
      const messages = await getMessagesFor(
        UpdateTicketDto,
        { title: '' },
        'title',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('CreateCommentDto', () => {
    it('should return i18n key for body too short', async () => {
      const messages = await getMessagesFor(
        CreateCommentDto,
        { body: '' },
        'body',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('UpdateCommentDto', () => {
    it('should return i18n key for body too short', async () => {
      const messages = await getMessagesFor(
        UpdateCommentDto,
        { body: '' },
        'body',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('CreateLabelDto', () => {
    it('should return i18n key for empty name', async () => {
      const messages = await getMessagesFor(
        CreateLabelDto,
        { name: '' },
        'name',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });

  describe('AssignLabelDto', () => {
    it('should return i18n key for empty labelId', async () => {
      const messages = await getMessagesFor(
        AssignLabelDto,
        { labelId: '' },
        'labelId',
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((m) => I18N_KEY_PATTERN.test(m))).toBe(true);
    });
  });
});
