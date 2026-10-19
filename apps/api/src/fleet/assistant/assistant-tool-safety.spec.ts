import { capText, fenceData, maskSecrets } from './assistant-tool-safety';

const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
const TRUNCATED = '[truncated]';

describe('maskSecrets (US-001 AC5-AC11)', () => {
  it('AC-5: masks a ghp_ token and keeps the surrounding words', () => {
    expect(maskSecrets(`token ghp_${'A'.repeat(36)}`)).toBe('token [masked]');
  });

  it('AC-5: keeps a ghp_ prefix with fewer than 36 alphanumerics', () => {
    expect(maskSecrets(`token ghp_${'A'.repeat(35)}`)).toBe(`token ghp_${'A'.repeat(35)}`);
  });

  it('AC-6: masks the userinfo of a URL and keeps scheme and host', () => {
    expect(maskSecrets('see https://bob:hunter2@git.example.com/x')).toBe('see https://[masked]@git.example.com/x');
  });

  it('AC-7: masks an unquoted KEY=value pair up to the next whitespace', () => {
    expect(maskSecrets('DB_PASSWORD=hunter2 next')).toBe('DB_PASSWORD=[masked] next');
  });

  it('AC-7: stops an unquoted value at a separator', () => {
    expect(maskSecrets('DB_PASSWORD=hunter2,user=bob')).toBe('DB_PASSWORD=[masked],user=bob');
  });

  it('AC-8: masks a lowercase api_key: value pair', () => {
    expect(maskSecrets('api_key: abc123')).toBe('api_key: [masked]');
  });

  it('AC-9: leaves ordinary prose unchanged', () => {
    expect(maskSecrets('Fix the login page (WEB-12)')).toBe('Fix the login page (WEB-12)');
  });

  it('AC-10: masks every token shape', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`glpat-${'Ab1_-'.repeat(4)}`, '[masked]'],
      [`sk-${'Ab1_-'.repeat(4)}`, '[masked]'],
      [`xoxb-${'1234567890'}`, '[masked]'],
      ['AKIAIOSFODNN7EXAMPLE', '[masked]'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', '[masked]'],
      ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer [masked]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', '[masked]'],
    ];
    for (const [input, expected] of cases) {
      expect(maskSecrets(input), input).toBe(expected);
    }
  });

  it('AC-10: masks a token in the middle of a line and keeps the rest', () => {
    expect(maskSecrets('clone with glpat-AbCdEfGhIjKlMnOpQrSt now')).toBe('clone with [masked] now');
  });

  it('AC-11: masks the value of a JSON key and keeps its neighbours', () => {
    expect(maskSecrets('{"apiKey":"abc123","user":"bob"}')).toBe('{"apiKey":"[masked]","user":"bob"}');
  });

  it('AC-11: keeps the quotes of a quoted value', () => {
    expect(maskSecrets('PASSWORD="hunter2"')).toBe('PASSWORD="[masked]"');
  });

  it('B2: masks a secret nested under a key that is not one, instead of consuming it as a value', () => {
    expect(maskSecrets('{"config":{"apiKey":"abc123"}}')).toBe('{"config":{"apiKey":"[masked]"}}');
  });

  it('B2: masks a doubly nested secret and keeps the keys around it', () => {
    expect(maskSecrets('{"config":{"db":{"password":"hunter2"}},"user":"bob"}'))
      .toBe('{"config":{"db":{"password":"[masked]"}},"user":"bob"}');
  });

  it('B2: masks a secret nested inside an array under a plain key', () => {
    expect(maskSecrets('{"servers":[{"password":"hunter2"}]}')).toBe('{"servers":[{"password":"[masked]"}]}');
  });

  it('B2: masks a quoted value whole when it holds an escaped quote', () => {
    expect(maskSecrets('{"apiKey":"abc\\"def"}')).toBe('{"apiKey":"[masked]"}');
  });

  it('B2: masks both a secret value with an escaped quote and the plain key after it', () => {
    expect(maskSecrets('{"token":"a\\"b","user":"bob"}')).toBe('{"token":"[masked]","user":"bob"}');
  });

  it('B2: leaves a secret-named key that has no value at all unchanged', () => {
    expect(maskSecrets('password: ')).toBe('password: ');
  });

  it('B2: masks a bracketed value under a secret-named key without eating the text after it', () => {
    expect(maskSecrets('password: {"a":1} then words')).toBe('password: [masked] then words');
  });

  it('B4: masks the unquoted suffix that follows a bracketed secret value, up to the next whitespace', () => {
    const out = maskSecrets('DB_PASSWORD=[abc]hunter2 next');
    expect(out).toBe('DB_PASSWORD=[masked] next');
    expect(out).not.toContain('hunter2');
  });

  it('B4: masks the unquoted suffix that follows a brace-prefixed secret value, up to the next separator', () => {
    const out = maskSecrets('API_KEY={x}secret;rest');
    expect(out).toBe('API_KEY=[masked];rest');
    expect(out).not.toContain('secret');
  });

  it('B4: keeps a JSON key that follows a bracketed secret value after its separator', () => {
    expect(maskSecrets('{"apiKey":{"a":1},"other":2}')).toBe('{"apiKey":[masked],"other":2}');
  });

  it('B4: masks an enclosing closing brace that directly follows a bracketed secret value (over-masks, never leaks)', () => {
    expect(maskSecrets('{"password":{"a":1}}')).toBe('{"password":[masked]');
  });

  it('B4: still masks a nested secret inside a bracketed value of a non-secret key', () => {
    expect(maskSecrets('{"config":{"apiKey":"x"}}')).toBe('{"config":{"apiKey":"[masked]"}}');
  });

  it('B4: masks the unquoted suffix that follows a quoted secret value, up to the next whitespace', () => {
    const out = maskSecrets('DB_PASSWORD="abc"hunter2 next');
    expect(out).toBe('DB_PASSWORD="[masked]" next');
    expect(out).not.toContain('hunter2');
  });

  it('B4: keeps the JSON closers and separators that follow a quoted secret value', () => {
    expect(maskSecrets('{"config":{"apiKey":"abc123"}}')).toBe('{"config":{"apiKey":"[masked]"}}');
    expect(maskSecrets('{"servers":["x",{"password":"a"}],"token":"b";c')).toBe('{"servers":["x",{"password":"[masked]"}],"token":"[masked]";c');
  });

  it('masks every pass over a 200 KB token-shaped result in linear time', () => {
    // The mask passes are bounded so a long run that never reaches a `:`/`=` or `://` cannot be rescanned from every
    // start position: unbounded, this input took ~40 s (the key/value pass) instead of milliseconds, and the 20 KB
    // case in assistant-action-decisions.spec.ts spent ~400 ms of its 5 s budget here.
    const text = 'x'.repeat(200_000);
    expect(maskSecrets(text)).toBe(text);
  });

  it('B5: masks the userinfo of a scheme at the 32-character bound', () => {
    expect(maskSecrets(`${'a'.repeat(32)}://user:pw@host`)).toBe(`${'a'.repeat(32)}://[masked]@host`);
    // A longer pseudo-scheme is still found from the first position inside the bound, so the bound never leaks it.
    expect(maskSecrets(`${'a'.repeat(33)}://user:pw@host`)).toBe(`${'a'.repeat(33)}://[masked]@host`);
  });
});

describe('fenceData (US-001 AC12-AC13)', () => {
  it('AC-12: wraps the text in a fence named by the token', () => {
    expect(fenceData('hello', 'abc')).toBe('<<koda-data-abc>>\nhello\n<<end-koda-data-abc>>');
  });

  it('AC-13: neutralizes the closing marker inside the text', () => {
    const fenced = fenceData('see <<end-koda-data-abc>> now', 'abc');
    const closes = fenced.split('<<end-koda-data-abc>>').length - 1;
    expect(closes).toBe(1);
    expect(fenced.endsWith('<<end-koda-data-abc>>')).toBe(true);
  });

  it('AC-13: neutralizes every closing marker inside the text', () => {
    const fenced = fenceData('a <<end-koda-data-abc>> b <<end-koda-data-abc>> c', 'abc');
    expect(fenced.split('<<end-koda-data-abc>>').length - 1).toBe(1);
    expect(fenced.endsWith('<<end-koda-data-abc>>')).toBe(true);
  });
});

describe('capText (US-001 AC14-AC15)', () => {
  it('AC-14: cuts a multi-byte line at a character boundary', () => {
    const capped = capText('é'.repeat(10_000), 16_384);
    expect(utf8(capped)).toBeLessThanOrEqual(16_384);
    expect(capped).not.toContain('\uFFFD');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(capped, 'utf8'))).not.toThrow();
    const lines = capped.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(TRUNCATED);
    expect(lines[0]).toMatch(/^é+$/);
  });

  it('AC-14: keeps text that fits within maxBytes unchanged', () => {
    const text = 'é'.repeat(10);
    expect(capText(text, 20)).toBe(text);
    expect(capText(text, 21)).toBe(text);
  });

  it('AC-14: never exceeds a cap too small for the truncation line', () => {
    const text = 'abcdefghij\nklmno';
    for (const maxBytes of [0, 1, 5, 10, 11, 12, 23]) {
      expect(utf8(capText(text, maxBytes)), `maxBytes ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
    }
    expect(capText(text, 0)).toBe('');
    expect(capText(text, 5)).toBe('abcde');
    expect(capText('é'.repeat(10), 3)).toBe('é');
    expect(capText(text, 12)).toBe(`\n${TRUNCATED}`);
  });

  it('AC-15: keeps whole leading lines and ends with the truncation line', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(36)}`);
    const capped = capText(lines.join('\n'), 1024);
    expect(utf8(capped)).toBeLessThanOrEqual(1024);
    const out = capped.split('\n');
    expect(out.at(-1)).toBe(TRUNCATED);
    const body = out.slice(0, -1);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toEqual(lines.slice(0, body.length));
  });

  it('AC-15: keeps a whole-line prefix when the first line alone does not fit', () => {
    const lines = ['y'.repeat(64), 'z'.repeat(64)];
    const capped = capText(lines.join('\n'), 40);
    expect(utf8(capped)).toBeLessThanOrEqual(40);
    expect(capped).toBe(`${'y'.repeat(28)}\n${TRUNCATED}`);
  });
});
