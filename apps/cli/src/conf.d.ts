declare module 'conf' {
  class Conf<T extends Record<string, unknown> = Record<string, unknown>> {
    readonly path: string;
    constructor(options?: {
      projectName?: string;
      configName?: string;
      cwd?: string;
      schema?: Record<string, unknown>;
      fileDescriptor?: number;
    });
    get<K extends keyof T>(key: K): T[K];
    set<K extends keyof T>(key: K, value: T[K]): void;
  }

  export default Conf;
}
