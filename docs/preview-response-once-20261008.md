# One authorized ordinary preview response read — 2026-10-08

## Actual response

One unauthenticated GET of the same original public preview endpoint was made at `2026-10-07T23:54:21.512981Z` (Beijing 2026-10-08 07:54:21), ending at `23:54:21.658805Z` (145.82 ms).

- HTTP status: **403**
- Server: `cloudflare`
- CF-Ray: `a470d49d4c81c47e-LAX`
- Content-Type: `text/plain; charset=UTF-8`
- Body: `error code: 1010\n` (17 bytes)
- No redirect, cookie, authorization or custom user agent; no retry, proxy change, deployment or configuration change.

The exact original URL is retained in [the sanitized JSON](preview-response-once-evidence-20261008.json). The successful [diagnostic job](https://github.com/dodoxiaxia/xinzhi/actions/runs/37704860910) means the single read and evidence capture completed; it does **not** mean the endpoint succeeded.

Source commit: `953362de38db93a784c368f1488eacba83cb590c`, job `113076679549`. As with the original probe, this ran on normal GitHub `ubuntu-latest` with Python 3.11 and urllib's ordinary default identity. A new standard hosted job was used, not a chosen alternate node or proxy. Existing authentication was not added to the public request. Safe JSON was printed to the existing job log and saved as an artifact so evidence did not depend on the environment's denied artifact-download link.

## Diagnosis and limits

[Cloudflare's official error1010 documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/) defines this as refusal based on the client's browser signature. Combined with the response body, Cloudflare Server header and public Ray ID, this is strong evidence that **this ordinary diagnostic request was rejected by Cloudflare edge security**. It is not merely a bare unexplained egress403 and not an explicit response of the reviewed public-data application handler.

The exact security-rule ID and actual Browser Integrity Check setting were not read. Do not assert a particular WAF rule, bot product, owner-managed setting or that this account can change protections on the shared `pages.dev` host. The initial03:38 response was not retained, so this later response classifies the new diagnostic request, not conclusively the original event's exact rule.

Previously verified metadata reports Functions present in both preview and production. A blocked request can explain absent invocation evidence, but Preview “No data” does not itself prove that all requests were blocked or that CPU/memory gates passed.

## Stop and production decision

The clear denial was recorded and requests stopped. No further route read, other hostname, credential, UA disguise, challenge solving, policy relaxation or permission expansion was attempted or requested. No additional user screenshots or desktop login requested.

Production remains **v14.2.12**, main `0371c21e846f05fdb5ef8e41968a711ac01a5a19`. The old preview is source `5c46f0f5c973fa0940fc18af3ad1a582abb0f2a9`; newer reviewed candidate `53bee6b1f5b5b9cd1f5cca4bcede8921806e4b10` has not been deployed and remains **HOLD**. Exact-candidate GET/HEAD, concurrency, CPU and memory gates are unmet.

This evidence is ready for an authorized read-only review of existing Cloudflare event records or Support using the public hostname, timestamp and Ray ID. No external support message was sent. Do not treat this as authorization to disable or bypass a protection. The temporary one-request workflow and script are removed from this branch's final tree.

