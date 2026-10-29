---
title: Okta SAML sign-in
description: Set up Okta SAML single sign-on for the Admin Cockpit on Docker and Kyma, with the Okta application, groups and role mapping.
---

# Okta SAML sign-in

This page sets up sign-in to the Admin Cockpit with a SAML 2.0 application in Okta. Dex acts as the SAML service provider; Okta sends the user's groups, and two of them become the cockpit's administrator and user roles. [Authentication providers](./authentication) explains how sign-in works and compares the providers.

## Before you start

- An Okta administrator account that can create SAML applications and assign users and groups.
- Two Okta groups, for example `sap-llm-gateway-admin` for administrators and `sap-llm-gateway-user` for users, with the members added.
- The base URL of the deployment, for example `https://sail.example.com`, or `http://localhost:8080` for a local Docker installation.

## 1. Create the SAML application in Okta

1. In the Okta Admin Console, create an app integration with the sign-in method **SAML 2.0**.
2. Set the **Single sign-on URL** to `<base URL>/dex/callback`, for example `https://sail.example.com/dex/callback`.
3. Set the **Audience URI (SP Entity ID)** to `<base URL>/dex`, for example `https://sail.example.com/dex`.
4. Add attribute statements so the assertion carries these attributes: `name` (the user's display name), `email` (the user's email address) and `groups` (the user's groups, with a group attribute filter that matches the groups to send). The names are exact: Dex reads `name`, `email` and `groups`.
5. Assign the two groups to the application.
6. Open the application's **Sign On** tab and copy the **Metadata URL**, for example `https://example.okta.com/app/abc123/sso/saml/metadata`.

A second deployment, for example a test namespace on Kyma, has a host of its own and needs its own single sign-on URL and audience URI; create another Okta application for it.

## 2. Run the setup

On Docker, run `node docker/setup-docker.js` and choose **Okta SAML**. On Kyma, run `node kyma/scripts/setup-kyma.js` and choose the same ([Kyma deployment](./kyma)). The questions:

| Question | Meaning |
|---|---|
| Okta SAML metadata URL | The Metadata URL from step 1 |
| Okta SSO URL | Replaced by the value in the metadata when the certificate is fetched automatically |
| SAML certificate | **Auto-fetch from metadata URL** (default), or enter the certificate manually |
| Okta admin group name | Default `sap-llm-gateway-admin` |
| Okta user group name | Default `sap-llm-gateway-user` |
| Logout redirect URL | Default `auto-shell`, which returns to the cockpit start page |

With the automatic fetch, the setup downloads the metadata, takes the signing certificate and the HTTP-POST single sign-on URL from it, and uses them. The machine that runs the setup must reach the metadata URL. If the fetch fails, the setup asks for the certificate in an editor.

What the setup writes differs between the deployments:

- **Docker**: the certificate goes to `docker/okta-saml-ca.pem`, which the `dex` service mounts, and the connector to `docker/dex.config.yaml`. Start the stack as described in [Docker deployment](./docker).
- **Kyma**: the certificate goes to the ConfigMap `dex-saml-cert`, which the `dex` pod mounts. Deploy as described in [Kyma deployment](./kyma).

The connector uses the callback `<base URL>/dex/callback` and the entity issuer `<base URL>/dex`; these are the two values from step 1.

## Roles

The setup writes this role mapping for the admin service:

```json
{"sap-llm-gateway-admin":"admin","sap-llm-gateway-user":"user"}
```

The names are the group names given to the setup, matched exactly against the `groups` attribute. A user whose groups map to no role gets the user role. To make someone an administrator, add them to the administrator group in Okta; it applies at their next sign-in. What each role may do: [Roles](/guide/roles). Restart the admin service after any change to `ROLE_MAPPING`.

## Troubleshooting

- **Dex fails to start or reports a certificate error**: the certificate is missing or not in PEM form. Run the setup again with the automatic fetch, or check that the metadata URL returns XML that contains an `X509Certificate` element.
- **Okta rejects the request or reports a wrong destination**: the single sign-on URL and the audience URI in Okta must equal `<base URL>/dex/callback` and `<base URL>/dex` exactly, including scheme and port. The SSO URL in the Dex configuration is Okta's own sign-on URL from the metadata, not the callback.
- **Signed in but with the wrong role**: Okta does not send the `groups` attribute, or the groups are not assigned to the application. The group names must match the setup's answers exactly.
- **Redirect loop after sign-in**: the base URL given to the setup differs from the URL in the browser.
- **Certificate rotated in Okta**: run the setup again to fetch the new certificate.

Read the Dex log for the exact error:

```bash
# Docker
docker compose -f docker/docker-compose.yml logs dex
# Kyma
kubectl -n sail-proxy logs deploy/dex
```

More: [Sign-in problems](/guide/troubleshooting#sign-in-problems-docker-and-kyma).
