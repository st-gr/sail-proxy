---
title: LDAP and Active Directory sign-in
description: Set up LDAP or Active Directory sign-in for the Admin Cockpit on Docker and Kyma, with an external directory or the bundled test server, and the group to role mapping.
---

# LDAP and Active Directory sign-in

This page sets up sign-in to the Admin Cockpit against a corporate LDAP directory or Active Directory. Dex checks the user's name and password with an LDAP bind and reads the user's groups; two groups become the cockpit's administrator and user roles. [Authentication providers](./authentication) explains how sign-in works and compares the providers.

Users type their directory user name and password into the Dex sign-in page, under **Log in with LDAP Directory**.

## Server types

| Type | Docker | Kyma | For |
|---|---|---|---|
| `external` | yes | yes | Your LDAP or Active Directory server |
| `local` | yes | no | A test OpenLDAP server with sample users and groups, started as an extra Compose service |

## Before you start (external server)

- The server address and port (`host:port`). Use LDAPS (usually port 636) outside a test setup; the services must be able to reach it.
- A service account that Dex binds with. It needs read access to users and groups only.
- Where users and groups live (base DNs), and the filters and attributes your schema uses.
- Two groups in the directory, for example `sap-llm-gateway-admin` and `sap-llm-gateway-user`, with the members added.

## Run the setup

On Docker, run `node docker/setup-docker.js` and choose **LDAP/Active Directory**. On Kyma, run `node kyma/scripts/setup-kyma.js` and choose the same ([Kyma deployment](./kyma)); Kyma asks the external-server questions directly.

The setup asks first for the server type (Docker only), the admin group name (default `sap-llm-gateway-admin`), the user group name (default `sap-llm-gateway-user`) and the logout redirect URL (default `auto-shell`). For an external server it then asks:

| Question | Default |
|---|---|
| LDAP server (`host:port`) | none |
| Allow insecure connection (`true`/`false`) | `false` |
| Bind DN (service account) and its password | none |
| User search base DN | none |
| User search filter | `(objectClass=person)` |
| Username, ID, email, name and preferred username attributes | `sAMAccountName`, `sAMAccountName`, `mail`, `displayName`, `sAMAccountName` |
| Group search base DN | none |
| Group search filter | `(objectClass=group)` |
| Group name attribute | `cn` |
| Group member attribute | `member` |

The defaults fit Active Directory. For a directory with another schema, change them: for OpenLDAP with `inetOrgPerson` users, for example, the user filter is `(objectClass=inetOrgPerson)` and the username attribute `uid`. The user's groups are found by matching the user's DN against the group member attribute.

Set **Allow insecure connection** to `false` and use an LDAPS address. `true` sends passwords unencrypted.

Start the stack as described in [Docker deployment](./docker), or deploy as described in [Kyma deployment](./kyma). The connector and the bind password are written to the Dex configuration; on Docker that is `docker/dex.config.yaml`, on Kyma the ConfigMap `dex-config`.

## The local test server (Docker only)

Choose the server type `local` to try the sign-in without a directory. The setup writes `docker/docker-compose.override.yml`, which adds an OpenLDAP service with sample data. Start the stack with the override named explicitly:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up -d
```

The server listens on `127.0.0.1:389` and `127.0.0.1:636` only. The base DN is `dc=example,dc=com`; the Dex bind account is `cn=admin,dc=example,dc=com` with the password `admin`. These credentials are public: use the test server for evaluation only.

All sample users have the password `P@ssw0rd!`:

| User name | Groups | Cockpit role |
|---|---|---|
| `admin` | `sap-llm-gateway-admin`, `security-team` | admin |
| `alice` | `sap-llm-gateway-admin`, `developers` | admin |
| `user` | `sap-llm-gateway-user` | user |
| `bob` | `sap-llm-gateway-user`, `developers` | user |
| `charlie` | `sap-llm-gateway-user` | user |

An optional phpLDAPadmin service for browsing the directory is part of the override. Start it with `--profile ldap-admin`; it is published on `127.0.0.1:6443`.

Running the setup again with another provider, or with an external server, removes the override file.

## Roles

The setup writes this role mapping for the admin service, with your group names:

```json
{"sap-llm-gateway-admin":"admin","sap-llm-gateway-user":"user"}
```

Group names are matched exactly, as Dex reports them (the group name attribute, `cn` by default). A user whose groups map to no role gets the user role. To make someone an administrator, add them to the admin group in the directory; it applies at their next sign-in. What each role may do: [Roles](/guide/roles). Restart the admin service after any change to `ROLE_MAPPING`.

## Troubleshooting

Read the Dex log first:

```bash
# Docker
docker compose -f docker/docker-compose.yml logs dex | grep -i ldap
# Kyma
kubectl -n sail-proxy logs deploy/dex
```

- **Bind errors**: the bind DN or password is wrong, the server is unreachable from the services, or a firewall blocks port 389 or 636.
- **Sign-in succeeds but the role is wrong**: the group search finds no groups. Check the group base DN, the group filter and the member attribute against your schema, and that the user is a member of a group named in the setup.
- **Certificate errors with LDAPS**: the server's certificate must be trusted by the Dex container. A certificate from a private certificate authority needs that authority's certificate mounted into the Dex container and referenced with `rootCA` in the Dex configuration.
- **No user is found**: check the user base DN, the user filter and the username attribute.

More: [Sign-in problems](/guide/troubleshooting#sign-in-problems-docker-and-kyma).
