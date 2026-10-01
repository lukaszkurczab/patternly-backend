# Operator CLI

The CLI talks directly to the backend operator API over verified HTTPS. It is
not the local administrator panel and does not use emulator credentials.
Configure one or more exact HTTPS origins in a local non-secret JSON file:

```json
{
  "allowedOrigins": ["https://operator-api.example.com"]
}
```

Start with `config/operator-cli.example.json` and replace its example origin.
The selected origin is required on every command and must match the allowlist
exactly. Redirects and invalid TLS certificates are rejected.

```sh
npm run operator -- list legal-requests --config ./operator-cli.json --origin https://operator-api.example.com
npm run operator -- show legal-requests lr_UUID --config ./operator-cli.json --origin https://operator-api.example.com
npm run operator -- action legal-requests lr_UUID --config ./operator-cli.json --origin https://operator-api.example.com
npm run operator -- create-incident --config ./operator-cli.json --origin https://operator-api.example.com
npm run operator -- authority-export si_UUID 1 --config ./operator-cli.json --origin https://operator-api.example.com
```

For `action` and `create-incident`, provide a strict JSON body through stdin
when stdin is piped, or use `--payload-fd N` to read it from an explicitly
selected descriptor such as fd 3 while retaining the terminal for prompts.
Bodies are checked against the canonical OpenAPI request schema before the
CLI prompts for a token or sends HTTP. Unknown options and extra body fields
are rejected. Payloads are never accepted in argv or from a path.

The operator ID token is requested through a hidden terminal prompt. The CLI
keeps it in memory for the command, checks the JWT algorithm and time claims
locally, then lets the server verify its signature and exact configured action
scope. Do not pass tokens in command arguments, environment variables, files,
or child-process arguments.

Before a mutation, the CLI fetches and validates current detail, checks the
supplied revision or expected status against that state, and asks for the exact
typed confirmation shown at the prompt. Declining sends no mutation. For
incident creation, the CLI prints a stable `si_UUID` before confirmation;
use `--id si_UUID` only when intentionally retrying with that same ID and
payload. Its confirmation summary states the fixed initial effect. An exact
payload replay may return the existing incident in its current state; it does
not reset that incident.

After a mutation request has been sent, a transport failure, server error, or
invalid success body is reported as **AMBIGUOUS — RECONCILIATION REQUIRED**.
The CLI performs at most one detail read and labels its result as observed
current state, not proof that this request caused it. It never retries the
mutation automatically. A definitive 4xx response is shown only as its
validated error code; raw response bodies, tokens, and mutation bodies are not
printed. `list` reports when the server capped the result at 100 items.

The HTTPS fixture tests require Node 22.19 or newer for the test-only
`tls.getCACertificates` and `tls.setDefaultCACertificates` APIs. CI pins the
locally verified Node 22.22.3 runtime. The production CLI retains the repository
Node 22+ requirement. Native terminal tests additionally use Python 3 and
OpenSSL to create an isolated controlling terminal and trusted fixture CA.
