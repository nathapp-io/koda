import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { REDACTED_SECRET } from '../../approvals/route/redact-secret';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { findCatalogEntry } from '../../permissions/catalog';
import type { ProviderCredentialDto } from './dto/provider-credential.dto';
import type { ProviderCredentialsService } from './provider-credentials.service';
import {
  PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS,
  PROVIDER_CREDENTIAL_ROUTE_VARIANTS,
  ProviderCredentialRouteCommands,
} from './provider-credential-route.commands';

/**
 * The GLOBAL provider credential routes' approval command (C10 US-003).
 *
 * The command is the only path both the immediate (a human, no policy) and the deferred (an agent
 * under a wait policy) create go through, so its redaction is what keeps the key out of every
 * approval request row.
 */
describe('ProviderCredentialRouteCommands', () => {
  const created: ProviderCredentialDto = Object.assign(new (class {
    id = 'cred-1';
    scope = 'GLOBAL';
    projectId = null;
    repoId = null;
    providerId = 'openrouter';
    name = 'fleet';
    last4 = '3456';
    fingerprint = '0123456789ab';
    disabled = false;
    createdBy = 'u1';
    updatedAt = '2026-11-05T00:00:00.000Z';
  })()) as ProviderCredentialDto;

  function build() {
    const registry = new ApprovalCommandRegistry();
    const credentials = {
      createGlobal: vi.fn().mockResolvedValue(created),
      assertEnabled: vi.fn(),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ actorType: 'user', id: 'u1' }) };
    new ProviderCredentialRouteCommands(
      registry,
      credentials as unknown as ProviderCredentialsService,
      loader as unknown as ActorPrincipalLoader,
    ).onModuleInit();
    const command = registry.get('fleet.credential.create', PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create);
    if (command === undefined) throw new Error('the create command is not registered');
    return { registry, credentials, loader, command };
  }

  it('registers the create command as a redeem command under fleet.credential.create', () => {
    const { command } = build();

    expect(PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create).toBe('rest:fleet-provider-credentials.create');
    expect(command).toMatchObject({
      key: 'fleet.credential.create', variant: 'rest:fleet-provider-credentials.create', redeem: expect.any(Object),
    });
  });

  it('parses the body into exactly providerId, name and key', () => {
    const { command } = build();

    const parsed = command.parse({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456', scope: 'PROJECT' });

    expect(parsed).toEqual({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' });
  });

  it.each([
    ['an empty providerId', { providerId: '', name: 'fleet', key: 'sk-or-abcdef123456' }],
    ['an uppercase providerId', { providerId: 'OpenRouter', name: 'fleet', key: 'sk-or-abcdef123456' }],
    ['a whitespace-bearing key', { providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef 123456' }],
    ['a key shorter than 16 characters', { providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef' }],
    ['an empty name', { providerId: 'openrouter', name: '', key: 'sk-or-abcdef123456' }],
  ])('refuses %s', (_label, body) => {
    const { command } = build();

    expect(() => command.parse(body)).toThrow(ValidationAppException);
  });

  it('stores the key as the redaction marker, so no request row carries it', () => {
    const { command } = build();

    const parsed = command.parse({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' });

    expect(command.redeem?.redact?.(parsed)).toEqual({
      providerId: 'openrouter', name: 'fleet', key: REDACTED_SECRET,
    });
  });

  it('runs the service as the requester and answers the created row', async () => {
    const { command, credentials, loader } = build();

    const input = command.parse({ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' });
    const output = await command.execute(input);

    expect(credentials.createGlobal).toHaveBeenCalledExactlyOnceWith('u1', input);
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(output).toBe(created);
    expect(command.toResult?.(output)).toBe(created);
  });

  it('AC-13: fleet.credential.create is a global, high-risk role key', () => {
    expect(findCatalogEntry('fleet.credential.create')).toMatchObject({
      scope: 'global', access: 'role', risk: 'high', ownable: false,
      approval: { approvable: true },
    });
  });

  it('AC-13: the write siblings of the key are global and high risk too', () => {
    for (const key of ['fleet.credential.update', 'fleet.credential.delete']) {
      expect([key, findCatalogEntry(key)]).toEqual([
        key,
        expect.objectContaining({ scope: 'global', access: 'role', risk: 'high' }),
      ]);
    }
  });

  it('AC-14: en and zh carry both credential refusal sentences under the fleet namespace', () => {
    expect(localeSentence('en', 'fleet.providerCredentials.duplicate.409')).toEqual(expect.any(String));
    expect(localeSentence('en', 'fleet.providerCredentials.vaultOff.503')).toEqual(expect.any(String));
    expect(localeSentence('zh', 'fleet.providerCredentials.duplicate.409')).toEqual(expect.any(String));
    expect(localeSentence('zh', 'fleet.providerCredentials.vaultOff.503')).toEqual(expect.any(String));
  });
});

/**
 * Resolves a dotted i18n key the way the loader mounts the files: `src/i18n/<lang>/<namespace>.json`
 * becomes `<namespace>.<property…>`. An entry that is not nested under its status never resolves for
 * the `<prefix>.<code>` key the exception filter asks for, so this fails on a flat string too.
 */
function localeSentence(lang: 'en' | 'zh', key: string): string {
  const root = join(__dirname, '..', '..', 'i18n', lang);
  const segments = key.split('.');
  const file = join(root, `${segments[0]}.json`);
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const sentence = [segments[0], ...segments.slice(1)].slice(1).reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    catalog,
  );
  if (typeof sentence !== 'string') {
    throw new Error(`${key} is not declared in ${file} (files: ${readdirSync(root).join(', ')})`);
  }
  return sentence;
}

/**
 * C10 US-005: the project routes' approval commands. The project id is pinned input — it is part of
 * the stored body, so a redemption has to match the project it was opened for, and the redaction keeps
 * the key out of the request row exactly as the GLOBAL commands do.
 */
describe('ProviderCredentialRouteCommands project scope (US-005)', () => {
  const row: ProviderCredentialDto = Object.assign(new (class {
    id = 'cred-p1';
    scope = 'PROJECT';
    projectId = 'p1';
    repoId = null;
    providerId = 'openrouter';
    name = 'project';
    last4 = '3456';
    fingerprint = '0123456789ab';
    disabled = false;
    createdBy = 'u1';
    updatedAt = '2026-11-05T00:00:00.000Z';
  })()) as ProviderCredentialDto;

  function build() {
    const registry = new ApprovalCommandRegistry();
    const credentials = {
      createProject: vi.fn().mockResolvedValue(row),
      updateProject: vi.fn().mockResolvedValue(row),
      removeProject: vi.fn().mockResolvedValue(undefined),
    };
    const loader = { forContext: vi.fn().mockResolvedValue({ actorType: 'user', id: 'u1' }) };
    new ProviderCredentialRouteCommands(
      registry,
      credentials as unknown as ProviderCredentialsService,
      loader as unknown as ActorPrincipalLoader,
    ).onModuleInit();
    return { registry, credentials, loader };
  }

  it('registers the three project variants under the project catalog keys', () => {
    const { registry } = build();

    expect(PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS).toEqual({
      create: 'rest:project-provider-credentials.create',
      update: 'rest:project-provider-credentials.update',
      delete: 'rest:project-provider-credentials.delete',
    });
    for (const [key, variant] of [
      ['project.credential.create', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create],
      ['project.credential.update', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update],
      ['project.credential.delete', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete],
    ] as const) {
      expect([key, registry.get(key, variant)?.key]).toEqual([key, key]);
    }
  });

  it('create parses the pinned project, the body and the repo scope', () => {
    const { registry } = build();
    const command = registry.get('project.credential.create', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create);

    const parsed = command?.parse({
      projectId: 'p1', providerId: 'openrouter', name: 'project', key: 'sk-or-abcdef123456', repoId: 'r1', scope: 'GLOBAL',
    });

    expect(parsed).toEqual({ projectId: 'p1', providerId: 'openrouter', name: 'project', key: 'sk-or-abcdef123456', repoId: 'r1' });
  });

  it('create redacts only the key and keeps the pinned project and repo', () => {
    const { registry } = build();
    const command = registry.get('project.credential.create', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create);
    const parsed = command?.parse({ projectId: 'p1', providerId: 'openrouter', name: 'project', key: 'sk-or-abcdef123456', repoId: null });

    expect(command?.redeem?.redact?.(parsed)).toEqual({
      projectId: 'p1', providerId: 'openrouter', name: 'project', key: REDACTED_SECRET, repoId: null,
    });
  });

  it('create runs the service as the requester against the pinned project', async () => {
    const { registry, credentials } = build();
    const command = registry.get('project.credential.create', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create);
    const parsed = command?.parse({ projectId: 'p1', providerId: 'openrouter', name: 'project', key: 'sk-or-abcdef123456' });

    const output = await command?.execute(parsed);

    expect(credentials.createProject).toHaveBeenCalledExactlyOnceWith('u1', 'p1', parsed);
    expect(output).toBe(row);
  });

  it('update redacts a rotated key and leaves an absent one absent', () => {
    const { registry } = build();
    const command = registry.get('project.credential.update', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update);

    const rotated = command?.parse({ projectId: 'p1', id: 'cred-p1', patch: { key: 'sk-or-abcdef123456' } });
    expect(command?.redeem?.redact?.(rotated)).toEqual({ projectId: 'p1', id: 'cred-p1', patch: { key: REDACTED_SECRET } });

    const renamed = command?.parse({ projectId: 'p1', id: 'cred-p1', patch: { name: 'renamed' } });
    expect(command?.redeem?.redact?.(renamed)).toEqual({ projectId: 'p1', id: 'cred-p1', patch: { name: 'renamed' } });
  });

  it('update runs the service with the caller as the updater', async () => {
    const { registry, credentials } = build();
    const command = registry.get('project.credential.update', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update);

    await command?.execute(command.parse({ projectId: 'p1', id: 'cred-p1', patch: { disabled: true } }));

    expect(credentials.updateProject).toHaveBeenCalledExactlyOnceWith('p1', 'cred-p1', { disabled: true, updatedById: 'u1' });
  });

  it('delete requires the pinned project, then deletes as the requester', async () => {
    const { registry, credentials } = build();
    const command = registry.get('project.credential.delete', PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete);

    expect(() => command?.parse({ id: 'cred-p1' })).toThrow(ValidationAppException);
    await command?.execute(command.parse({ projectId: 'p1', id: 'cred-p1' }));

    expect(credentials.removeProject).toHaveBeenCalledExactlyOnceWith('p1', 'cred-p1', 'u1');
    expect(command?.redeem).toEqual({});
  });
});
