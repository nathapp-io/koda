import { finishSuccess } from '../utils/output';
import { constants, promises as fs } from 'fs';
import { join, resolve } from 'path';
import { getGlobalConfigPath } from '../config';
import { resolveAuth } from '../utils/auth';
import { projectsControllerFindBySlug } from '../generated';
import { configureApiClient } from '../utils/api-client';

export interface InitOptions {
  project?: string;
  defaultType?: string;
  defaultPriority?: string;
  apiKey?: string;
  apiUrl?: string;
  cwd?: string;
}

export interface ProjectConfigFile {
  projectSlug: string;
  defaults?: {
    type?: string;
    priority?: string;
  };
}

export interface InitDeps {
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
  fetchProject: (apiUrl: string, apiKey: string, slug: string) => Promise<unknown>;
  resolveAuth: (options: { apiKey?: string; apiUrl?: string }) => Promise<{ apiKey: string; apiUrl: string }>;
  cwd: () => string;
}

async function writeProjectConfig(filePath: string, content: string): Promise<void> {
  const globalPath = getGlobalConfigPath();
  const collisionMessage = 'Cannot initialize over the global config. Choose a project directory with --cwd.';
  if (resolve(filePath) === globalPath) throw new Error(collisionMessage);

  // Open without truncating. Check and write the same file descriptor so a linked
  // destination cannot redirect a subsequent write to the credential store.
  const file = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT);
  try {
    const globalStat = await fs.stat(globalPath, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (globalStat) {
      const target = await file.stat({ bigint: true });
      if (target.dev === globalStat.dev && target.ino === globalStat.ino) throw new Error(collisionMessage);
    }
    await file.truncate(0);
    await file.writeFile(content, 'utf8');
  } finally {
    await file.close();
  }
}

export const _initDeps: InitDeps = {
  writeFile: writeProjectConfig,
  mkdir: (dirPath: string, opts: { recursive: boolean }) => fs.mkdir(dirPath, opts).then(() => undefined),
  fetchProject: async (apiUrl: string, apiKey: string, slug: string) => {
    configureApiClient(apiUrl.replace(/\/api\/?$/, ''), apiKey);
    return projectsControllerFindBySlug({ path: { slug } });
  },
  resolveAuth,
  cwd: () => process.cwd(),
};

export async function initCommand(options: InitOptions, deps: InitDeps = _initDeps): Promise<void> {
  const { apiKey, apiUrl } = await deps.resolveAuth({ apiKey: options.apiKey, apiUrl: options.apiUrl });

  if (!apiKey) {
    console.error('Not logged in. Run: koda login --api-key -');
    return void process.exit(2);
  }

  const slug = options.project;
  if (!slug) {
    console.error('Project slug required. Use: koda init --project <slug>');
    return void process.exit(2);
  }

  try {
    await deps.fetchProject(apiUrl, apiKey, slug);
  } catch (err: unknown) {
    const error = err as { response?: { status: number }; status?: number };
    if (error?.response?.status === 404 || error?.status === 404) {
      console.error(`Project not found: ${slug}`);
    } else {
      console.error(`Failed to fetch project: ${slug}`);
    }
    return void process.exit(1);
  }

  const configData: ProjectConfigFile = { projectSlug: slug };

  if (options.defaultType || options.defaultPriority) {
    configData.defaults = {};
    if (options.defaultType) configData.defaults.type = options.defaultType;
    if (options.defaultPriority) configData.defaults.priority = options.defaultPriority;
  }

  const cwd = options.cwd ?? deps.cwd();
  const dir = join(cwd, '.koda');
  const filePath = join(dir, 'config.json');

  await deps.mkdir(dir, { recursive: true });
  await deps.writeFile(filePath, JSON.stringify(configData, null, 2));

  console.log('✓ Created .koda/config.json');
  console.log('Note: This file must not contain API tokens or secrets.');
  return finishSuccess();
}
