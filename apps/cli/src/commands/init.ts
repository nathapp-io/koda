import { promises as fs } from 'fs';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { ProjectsService } from '../generated';

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
    const client = configureClient(apiUrl, apiKey);
    return ProjectsService.show(client, slug);
  },
  resolveAuth,
  cwd: () => process.cwd(),
};

export async function initCommand(_options: InitOptions, _deps: InitDeps = _initDeps): Promise<void> {
  throw new Error('not implemented');
}
