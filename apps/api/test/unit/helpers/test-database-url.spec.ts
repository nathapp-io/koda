import { assertSafeTestDatabaseUrl } from '../../helpers/test-database-url';

describe('assertSafeTestDatabaseUrl', () => {
  it.each([
    'postgresql://koda:koda@localhost:5433/koda_test',
    'postgres://koda:koda@127.0.0.1:5433/koda_test?schema=public',
    'postgresql://u:p@localhost/other_test',
  ])('accepts a local *_test database: %s', (url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    ['sqlite url', 'file:./koda.db'],
    ['dev database', 'postgresql://koda:koda@localhost:5432/koda'],
    ['remote host', 'postgresql://koda:koda@db.example.com:5433/koda_test'],
    ['name only contains test', 'postgresql://koda:koda@localhost:5433/koda_test_backup'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(/refusing to reset/);
  });

  it('does not echo credentials in the error', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://koda:s3cret@prod.example.com:5432/koda')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('s3cret') }),
    );
  });
});
