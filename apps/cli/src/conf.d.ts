declare module 'conf' {
  class Conf<T extends Record<string, unknown> = Record<string, unknown>> {
    constructor(options?: {
      projectName?: string;
      schema?: Record<string, unknown>;
      fileDescriptor?: number;
    });
    get<K extends keyof T>(key: K): T[K];
    set<K extends keyof T>(key: K, value: T[K]): void;
  }

  export default Conf;
}
