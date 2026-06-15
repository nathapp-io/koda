export const CONTEXT_REPOSITORY = Symbol('CONTEXT_REPOSITORY');

export interface IContextRepository {
  projectExistsAndNotDeleted(projectId: string): Promise<boolean>;
}
