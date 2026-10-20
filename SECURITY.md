# Security

Do not include passwords, session tokens, `.env`, Apple signing settings, device identifiers, private keys, Android keystores, user databases or backups in issues or pull requests. These files are excluded from Git and Docker build contexts where applicable.

Report a reproducible issue without private data through the repository's private vulnerability reporting feature if available. If unavailable, open an issue requesting a private contact without exploit details or credentials.

Self-host with HTTPS, current Node.js 24 and resource limits. Keep private database backups and signing identities outside public CI. The service's optional shared book-source access code and individual account sessions are separate. Read `docs/cloud-sync.md` for data scope and current account-management limitations.

The public CI builds unsigned-by-the-maintainer debug artifacts using ephemeral debug signing. It does not receive the maintainer's private signing identity. Treat forks and pull requests as untrusted code.
