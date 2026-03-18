// Generated client stub - this will be replaced by actual generated code
// For now, we export a placeholder object that will be mocked in tests

export interface Project {
  id: string;
  name: string;
  key: string;
  slug: string;
  description?: string;
}

export interface ApiResponse<T> {
  data: T;
}

export const ProjectsService = {
  list: async (_client: any, _options?: any): Promise<ApiResponse<Project[]>> => {
    throw new Error('ProjectsService.list not implemented');
  },
  show: async (_client: any, _options?: any): Promise<ApiResponse<Project>> => {
    throw new Error('ProjectsService.show not implemented');
  },
};
