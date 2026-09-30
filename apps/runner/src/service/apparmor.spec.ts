import { describe, expect, test } from 'bun:test';
import { APPARMOR_MARKER, apparmorProfile, attachesTo, userNamespacesRestricted } from './apparmor';

describe('AppArmor (design §3.3, D106)', () => {
  test('the Ubuntu 24.04 restriction is the sysctl reading 1', () => {
    expect(userNamespacesRestricted('1\n')).toBe(true);
    expect(userNamespacesRestricted('0\n')).toBe(false);
    expect(userNamespacesRestricted(null)).toBe(false);   // not Linux, or an AppArmor-less kernel
  });
  test('the profile attaches to the real bwrap path, unconfined, with userns', () => {
    expect(apparmorProfile('/usr/bin/bwrap')).toBe([
      APPARMOR_MARKER,
      '# Lets bwrap create the unprivileged user namespace the nax sandbox needs on Ubuntu 24.04+.',
      'abi <abi/4.0>,',
      'include <tunables/global>',
      '',
      'profile koda-runner-bwrap /usr/bin/bwrap flags=(unconfined) {',
      '  userns,',
      '',
      '  include if exists <local/koda-runner-bwrap>',
      '}',
      '',
    ].join('\n'));
  });
  test('attachesTo sees a named or an unnamed profile on the path, and nothing else', () => {
    expect(attachesTo('abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n', '/usr/bin/bwrap')).toBe(true);
    expect(attachesTo('/usr/bin/bwrap flags=(complain) {\n}\n', '/usr/bin/bwrap')).toBe(true);
    expect(attachesTo('profile x /usr/bin/bwrapper {\n}\n', '/usr/bin/bwrap')).toBe(false);
    expect(attachesTo('# /usr/bin/bwrap is not confined here\n', '/usr/bin/bwrap')).toBe(false);
    expect(attachesTo('  /usr/bin/bwrap ix,\n', '/usr/bin/bwrap')).toBe(false);   // a rule inside another profile, not an attachment
  });
});
