import { getConfig, maskApiKey, setConfig } from '../config';

export interface ConfigShowResult {
  apiKey: string;
  apiUrl: string;
}

export interface ConfigSetResult {
  success: boolean;
  message: string;
}

export function configShow(): ConfigShowResult {
  const config = getConfig();
  return {
    apiKey: maskApiKey(config.apiKey),
    apiUrl: config.apiUrl,
  };
}

export function configSet(partial: {
  apiKey?: string;
  apiUrl?: string;
}): ConfigSetResult {
  setConfig(partial);
  return {
    success: true,
    message: 'Config updated successfully.',
  };
}
