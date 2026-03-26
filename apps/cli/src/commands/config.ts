import { getConfig, maskApiKey, setConfig, type Profile } from '../config';

export interface ConfigShowResult {
  apiKey: string;
  apiUrl: string;
}

export interface ConfigSetResult {
  success: boolean;
  message: string;
}

export interface ConfigProfileActionDeps {
  getProfiles: () => Array<{ name: string; apiUrl: string }>;
  setProfile: (name: string, profile: Profile) => void;
  removeProfile: (name: string) => void;
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

export function configProfileList(): Array<{ name: string; apiUrl: string }> {
  // stub — not yet implemented
  return [];
}

export function configProfileListAction(_deps?: ConfigProfileActionDeps): void {
  // stub — not yet implemented
}

export function configProfileAddAction(
  _name: string,
  _apiUrl: string,
  _apiKey: string,
  _deps?: ConfigProfileActionDeps,
): void {
  // stub — not yet implemented
}

export function configProfileRemoveAction(
  _name: string,
  _deps?: ConfigProfileActionDeps,
): void {
  // stub — not yet implemented
}
