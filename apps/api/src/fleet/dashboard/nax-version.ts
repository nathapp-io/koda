const CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/;

export type CoreVersion = readonly [number, number, number];

/** major.minor.patch of a nax version; a prerelease or build suffix is ignored; null when unparsable (spec §2.4, D412). */
export function parseCoreVersion(version: string | null | undefined): CoreVersion | null {
  if (!version) return null;
  const m = CORE.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareCore(a: CoreVersion, b: CoreVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const formatCore = (v: CoreVersion): string => v.join('.');
