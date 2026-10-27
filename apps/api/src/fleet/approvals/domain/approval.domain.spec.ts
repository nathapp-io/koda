import { FLEET_ASK_KEY, FLEET_ASK_TYPE, fleetTypeOfKey } from './approval.domain';

/**
 * Permissions P3 (US-002) — the key-to-type mapping the readers use. `fleetTypeOfKey` promises a type or null, so it
 * must not answer a name it inherits from `Object.prototype`: a permission key is arbitrary text (`constructor`,
 * `toString`, …) and the readers that label a row call it on whatever the database held.
 */
describe('fleetTypeOfKey', () => {
  it('labels each fleet ask key with its own type', () => {
    expect(fleetTypeOfKey(FLEET_ASK_KEY.nax_bash_escalate)).toBe('nax_bash_escalate');
    expect(fleetTypeOfKey(FLEET_ASK_KEY.budget_override_required)).toBe('budget_override_required');
    // The map holds those two keys and nothing else: the reverse of `FLEET_ASK_KEY`, not a second list.
    expect(Object.keys(FLEET_ASK_TYPE).sort()).toEqual(Object.values(FLEET_ASK_KEY).sort());
  });

  it('answers null for a key that is not a fleet ask', () => {
    expect(fleetTypeOfKey('ticket.delete')).toBeNull();
    expect(fleetTypeOfKey('')).toBeNull();
  });

  it('answers null for a name inherited from Object.prototype instead of that name', () => {
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(fleetTypeOfKey(inherited)).toBeNull();
    }
  });
});
