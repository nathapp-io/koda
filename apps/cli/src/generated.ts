// This file is a stub - normally generated from OpenAPI spec
// In production, use: bun run generate

import { AxiosInstance } from 'axios';

export interface Project {
  id: string;
  name: string;
  key: string;
  slug: string;
  description?: string;
}

export class ProjectsService {
  static async list(client: AxiosInstance): Promise<{ data: Project[] }> {
    const response = await client.get('/projects');
    return response.data;
  }

  static async show(client: AxiosInstance, slug: string): Promise<{ data: Project }> {
    const response = await client.get(`/projects/${slug}`);
    return response.data;
  }
}
