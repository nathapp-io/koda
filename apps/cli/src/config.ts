let _config: Record<string, any> = {};

export interface AppConfig {
  apiKey?: string;
  apiUrl?: string;
}

export function getConfig(): AppConfig {
  return {
    apiKey: _config.apiKey,
    apiUrl: _config.apiUrl,
  };
}

export function setConfig(updates: Partial<AppConfig>): void {
  if (updates.apiKey !== undefined) {
    _config.apiKey = updates.apiKey;
  }
  if (updates.apiUrl !== undefined) {
    _config.apiUrl = updates.apiUrl;
  }
}
