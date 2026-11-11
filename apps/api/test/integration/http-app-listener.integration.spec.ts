import request from 'supertest';
import { fixtureDb } from '../helpers/action-context';
import { seedFleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('HTTP app listener lifecycle (PG)', () => {
  it('keeps one IPv4 loopback listener across authenticated and refused requests until app.close', async () => {
    await resetDb();
    const app = await bootHttpApp({ registrationEnabled: false });
    const server = app.getHttpServer();
    try {
      const address = server.address();
      expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) });
      expect(server.listening).toBe(true);
      const world = await seedFleetHttpWorld(server, fixtureDb(app));

      for (let i = 0; i < 3; i++) {
        const authenticated = await request(server).get('/api/auth/me')
          .set('Authorization', `Bearer ${world.tokens.root}`).expect(200);
        expect(authenticated.body).toHaveProperty('ret', 0);
        await request(server).get('/api/auth/me').expect(401);
        expect(server.listening).toBe(true);
        expect(server.address()).toEqual(address);
      }
    } finally {
      await app.close();
    }
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
  });
});
