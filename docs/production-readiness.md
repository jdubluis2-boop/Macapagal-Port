# Production deployment prerequisites

The delivered system runs the full local workflow. It is not a claim that live ferry operations, banking credentials or regulatory approval have been provisioned.

- Replace the mock payment adapter with tested GCash/Maya/card provider adapters and provider-specific webhook verification/status/refund APIs. Production refuses mock payments at startup; `PAYMENT_PROVIDER=disabled` leaves online payments unavailable. Real card data never belongs in this application; use provider-hosted tokenization.
- Configure a real SMTP service and the optional Twilio SMS adapter/provider. Local Mailpit captures email. SMS currently records an explicit unconfigured result; it does not claim messages were sent.
- Register OAuth applications, callback origins and authorized domains if using Google/Facebook. Code/configuration gates exist; external OAuth logins were not tested without supplied applications.
- Replace demonstration timetable/operator/fare data with approved published sailings, category fares, refund tiers, gate/terminal details and genuine official support/hotline contacts. The fixed design fixtures remain unpublished; optional future fixtures are clearly named DEMO.
- Approve passenger terms, the privacy notice, lawful retention periods, data subject request handling and operational retention/deletion procedures under Philippine law. Current legal pages label themselves as a development preview.
- Use isolated managed PostgreSQL/Redis, encrypted backups, key management, stable data encryption keys, HTTPS, trusted proxy configuration, least-privilege service accounts, monitoring and incident procedures. Never publicly deploy the development Compose password or Mailpit.
- Review migration tooling, conduct security/load/failure-recovery testing, verify provider and worker replay behavior, and operate audited role provisioning. End-to-end local tests do not establish bank or government integration approval.

Refund requests through a passenger ticket cancel the entire booking. Partial passenger refunds and cross-booking transfers are intentionally not offered. Staff may resolve individual duplicate-extra-payment exceptions without invalidating a valid original ticket.

Delivering the source code does not publish an environment snapshot or deploy a live service. Those are separate operational steps.

Verification limits: automated tests use the local mock provider and Mailpit. Actual GCash/Maya/card/SMS settlements, external Google/Facebook credentials, physical gate hardware and real camera capture were not exercised. The camera's unsupported-browser/manual fallback is covered. These limits must not be confused with bank or hardware certification.
