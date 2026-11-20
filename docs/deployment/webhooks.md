# Webhook signatures

Koda supports signed outbound webhooks and inbound CI webhook deliveries. During the deprecation window, both signature versions can be used; the deployment switches below let operators end that window independently for outbound and inbound traffic.

## Outbound webhooks

Koda sends these headers with each outbound webhook:

- `X-Koda-Event`: event name.
- `X-Koda-Delivery-Id`: delivery identifier, derived from the webhook, event and body. It remains stable across retries of the same delivery.
- `X-Koda-Timestamp`: decimal Unix timestamp in seconds for this send attempt.
- `X-Koda-Signature-V2`: HMAC-SHA256 signature over the timestamp, delivery ID and raw request body, joined with periods: `<timestamp>.<deliveryId>.<body>`. The header value is `sha256=<hex>` (lower-case hexadecimal).
- `X-Koda-Signature`: legacy v1 HMAC-SHA256 over only the raw request body, also in `sha256=<hex>` form. Koda sends it while `WEBHOOK_SIGNATURE_V1_ENABLED` is enabled.

Verify v2 using the webhook's secret and the exact timestamp text, delivery ID text and raw body received; do not parse and reserialize the body before checking the signature. Enforce a clock window of at most 300 seconds in either direction: refuse a timestamp more than 300 seconds before or after your clock. Dedupe on `X-Koda-Delivery-Id`, which stays stable across retries even though each retry has a fresh timestamp. A successful signature check alone does not prevent a replay inside the time window.

## Inbound CI webhook

To send a CI delivery, sign the exact raw JSON request body with the project's CI webhook token. The v2 signed string is `<timestamp>.<X-CI-Delivery>.<body>`, where `<timestamp>` is the text sent in `X-CI-Timestamp`, `X-CI-Delivery` is the delivery ID header value, and `<body>` is the raw request body. Send the resulting HMAC-SHA256 as `sha256=<hex>` in `X-CI-Signature-V2`. The timestamp must be decimal Unix seconds and within 300 seconds of the API's clock.

`<body>` is the bytes sent, not a decoded or re-serialized copy: sign the body exactly as it goes on the wire, byte for byte, even when it is not valid UTF-8. Koda verifies against the bytes it received and refuses a delivery whose raw body it could not capture. A request that sends no body signs the empty string, not the `{}` some servers substitute so their JSON parser has a document.

On a v2 delivery, `X-CI-Delivery` must be non-empty and at most 255 bytes (UTF-8). Koda records the delivery ID in a table whose unique index over the project, source and delivery ID cannot hold a longer value, so an oversized ID is refused with the same 401 as a bad signature. UUIDs and short pipeline-run identifiers are well within the limit.

The inbound headers are `X-CI-Timestamp`, `X-CI-Signature-V2`, `X-CI-Delivery` and, for legacy v1, `X-CI-Signature`. The v1 `X-CI-Signature` covers only the raw body and uses the same `sha256=<hex>` form.

If `X-CI-Signature-V2` is present, it alone decides whether the request is accepted, including when its value is empty: an invalid v2 signature is refused even if `X-CI-Signature` verifies. A request without v2 can use a valid v1 signature while v2 is not required; once v2 is required, v1-only requests are refused.

## Deprecation window

Both Compose files pass `WEBHOOK_SIGNATURE_V1_ENABLED` (default `true`) and `CI_WEBHOOK_REQUIRE_V2` (default `false`) to the API.

Both switches are deployment-wide environment variables:

- `WEBHOOK_SIGNATURE_V1_ENABLED` defaults to `true`. Set it to `false` to stop including the legacy body-only `X-Koda-Signature` on outbound webhooks. Outbound v2 signing remains enabled.
- `CI_WEBHOOK_REQUIRE_V2` defaults to `false`. Set it to `true` to reject inbound CI deliveries that do not include a valid v2 signature. While false, a request without a v2 header can still be accepted with a valid v1 signature.

There is a downgrade risk during that compatibility period: a captured delivery whose `X-CI-Signature-V2` header is stripped can still pass signature verification using its valid v1 signature while `CI_WEBHOOK_REQUIRE_V2` is false. Confirm that every CI sender is configured to send v2 before setting `CI_WEBHOOK_REQUIRE_V2=true`; then requests with a stripped or absent v2 header are refused. The v1 outbound and inbound switches are independent, so coordinate sender and receiver migration before changing either setting.
