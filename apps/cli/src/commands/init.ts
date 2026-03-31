import { promises as fs } from 'fs';
import { resolveAuth } from '../utils/auth';
import { OpenAPI } from '../generated/core/OpenAPI';
import { projectsControllerFindBySlug } from '../generated';

export interface InitOptions {
  project?: string;
  defaultType?: string;
  defaultPriority?: string;
  apiKey?: string;
  apiUrl?: string;
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
  resolveAuth: (options: { apiKey?: string; apiUrl?: string }) => { apiKey: string; apiUrl: string };
  cwd: () => string;
}

export const _initDeps: InitDeps = {
  writeFile: (filePath: string, content: string) => fs.writeFile(filePath, content, 'utf-8'),
  mkdir: (dirPath: string, opts: { recursive: boolean }) => fs.mkdir(dirPath, opts).then(() => undefined),
  fetchProject: async (apiUrl: string, apiKey: string, slug: string) => {
    OpenAPI.BASE = apiUrl.replace(/\/api\/?$/, '');
    OpenAPI.TOKEN = apiKey;
    return projectsControllerFindBySlug({ slug });
  },
  resolveAuth,
  cwd: () => process.cwd(),
};

export async function initCommand(options: InitOptions, deps: InitDeps = _initDeps): Promise<void> {
  const { apiKey, apiUrl } = deps.resolveAuth({ apiKey: options.apiKey, apiUrl: options.apiUrl });

  if (!apiKey) {
    console.error('Not logged in. Run: koda login --api-key <key>');
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

  const cwd = deps.cwd();
  const dir = `${cwd}/.koda`;
  const filePath = `${dir}/config.json`;

  await deps.mkdir(dir, { recursive: true });
  await deps.writeFile(filePath, JSON.stringify(configData, null, 2));

  console.log('✓ Created .koda/config.json');
  console.log('Note: This file must not contain API tokens or secrets.');
  process.exit(0);
}
