export const USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
export const APPARMOR_DIR = '/etc/apparmor.d';
export const APPARMOR_PROFILE_NAME = 'koda-runner-bwrap';
export const APPARMOR_PROFILE_PATH = `${APPARMOR_DIR}/${APPARMOR_PROFILE_NAME}`;
export const APPARMOR_MARKER = '# Written by koda-runner install-service --apply-apparmor.';

/** D106: Ubuntu 24.04+ sets this to 1, and bwrap then cannot create the user namespace the nax sandbox needs. */
export function userNamespacesRestricted(sysctl: string | null): boolean {
  return sysctl?.trim() === '1';
}

/** D106: the targeted form Ubuntu documents for an application that needs user namespaces. */
export function apparmorProfile(bwrapPath: string): string {
  return [
    APPARMOR_MARKER,
    '# Lets bwrap create the unprivileged user namespace the nax sandbox needs on Ubuntu 24.04+.',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${APPARMOR_PROFILE_NAME} ${bwrapPath} flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${APPARMOR_PROFILE_NAME}>`,
    '}',
    '',
  ].join('\n');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * D106: a profile header attached to `binaryPath` (`profile <name> <path> ... {` or `<path> ... {`). A second profile on
 * the same path would make ours fail to load, so install-service refuses instead.
 */
export function attachesTo(text: string, binaryPath: string): boolean {
  const path = escapeRegExp(binaryPath);
  return new RegExp(`^[ \\t]*(profile[ \\t]+\\S+[ \\t]+)?${path}([ \\t]+flags=\\([^)]*\\))?[ \\t]*\\{`, 'm').test(text);
}
