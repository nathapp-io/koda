import { getConfig, getProfiles, maskApiKey, setConfig, type Profile } from '../config';

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
  return getProfiles();
}

export function configProfileListAction(deps?: ConfigProfileActionDeps): void {
  const profiles = deps ? deps.getProfiles() : getProfiles();
  if (profiles.length === 0) {
    console.log('No profiles configured');
  } else {
    console.log('Name\tApiUrl');
    for (const p of profiles) {
      console.log(`${p.name}\t${p.apiUrl}`);
    }
  }
  process.exit(0);
}

export function configProfileAddAction(
  name: string,
  apiUrl: string,
  apiKey: string,
  deps?: ConfigProfileActionDeps,
): void {
  if (deps) {
    deps.setProfile(name, { apiUrl, apiKey });
  }
}

export function configProfileRemoveAction(
  name: string,
  deps?: ConfigProfileActionDeps,
): void {
  try {
    if (deps) {
      deps.removeProfile(name);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
