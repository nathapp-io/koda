/**
 * Webhook signature v2 US-005 — the committed `openapi.json` advertises the CI webhook's three signature
 * headers as optional.
 *
 * The document is read from disk, exactly as `approvals/approval-openapi.contract.spec.ts` reads it, so the
 * spec needs no database and no booted app: it asserts what a generated receiver reads from the published
 * contract. `x-ci-signature-v2` and `x-ci-timestamp` are only sent by a v2 sender, and `x-ci-signature` is
 * omitted by a v2-only one, so none of the three may be documented as required. Each appears exactly once:
 * `@headers` reflects the handler parameter and `@ApiHeader` declares it, and the swagger explorer merges the
 * two by `(name, in)` — a second entry would mean the merge stopped working.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type OpenApiParameter = { name?: string; in?: string; required?: boolean };
type OpenApiOperation = { parameters?: OpenApiParameter[] };
type OpenApiDocument = { paths: Record<string, Record<string, OpenApiOperation>> };

const openapi = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../openapi.json'), 'utf8'),
) as OpenApiDocument;

const CI_WEBHOOK_PATH = '/api/projects/{slug}/ci-webhook';
const operation = openapi.paths[CI_WEBHOOK_PATH]?.post;

/** Every `in: header` parameter of the CI webhook operation carrying `name`. */
function headerParameters(name: string): OpenApiParameter[] {
  return (operation?.parameters ?? []).filter(
    (parameter) => parameter.in === 'header' && parameter.name === name,
  );
}

describe('CI webhook OpenAPI contract for the signature headers (US-005)', () => {
  it('AC-3: POST /api/projects/{slug}/ci-webhook documents one optional x-ci-signature-v2 header', () => {
    expect(operation, `${CI_WEBHOOK_PATH} post`).toBeDefined();

    const headers = headerParameters('x-ci-signature-v2');

    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ name: 'x-ci-signature-v2', in: 'header', required: false });
  });

  it('AC-4: the same operation documents one optional x-ci-timestamp header', () => {
    expect(operation, `${CI_WEBHOOK_PATH} post`).toBeDefined();

    const headers = headerParameters('x-ci-timestamp');

    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ name: 'x-ci-timestamp', in: 'header', required: false });
  });

  it('AC-5: the same operation documents one optional x-ci-signature header', () => {
    expect(operation, `${CI_WEBHOOK_PATH} post`).toBeDefined();

    const headers = headerParameters('x-ci-signature');

    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ name: 'x-ci-signature', in: 'header', required: false });
  });
});
