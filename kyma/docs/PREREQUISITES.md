# Kyma Deployment Prerequisites

This guide helps you set up the necessary CLI tools and configuration to interact with an SAP BTP Kyma cluster from your development machine.

## Overview

Here's a cross-platform "bootstrap" guide to get a machine ready to talk to an SAP BTP Kyma cluster with `kubectl` + `krew` + `oidc-login`.

## 0. Prerequisites (all platforms)

You'll need:

* Access to an SAP BTP subaccount with a Kyma Runtime enabled.
* A Kyma cluster in status **OK** (provisioned).
* A `kubectl` version within one minor version of your cluster (Kubernetes recommends this). ([Kubernetes][1])

High-level steps (same everywhere):

1. Install **kubectl**.
2. Install **krew** (kubectl plugin manager).
3. Install **oidc-login** plugin via krew.
4. Download **kubeconfig.yaml** from the Kyma subaccount.
5. Point `kubectl` at that kubeconfig.
6. Test with `kubectl get namespace` (which will open a browser for SAP BTP login via OIDC).

---

## 1. macOS (OS X)

### 1.1 Install kubectl

Using Homebrew (preferred, quick): ([Kubernetes][2])

```bash
brew install kubectl

# verify
kubectl version --client
```

### 1.2 Install krew (kubectl plugin manager)

Follow the official install snippet for macOS/Linux (Bash/Zsh): ([Krew][3])

```bash
(
  set -x; cd "$(mktemp -d)" &&
  OS="$(uname | tr '[:upper:]' '[:lower:]')" &&
  ARCH="$(uname -m | sed -e 's/x86_64/amd64/' \
                          -e 's/\(arm\)\(64\)\?.*/\1\2/' \
                          -e 's/aarch64$/arm64/')" &&
  KREW="krew-${OS}_${ARCH}" &&
  curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/latest/download/${KREW}.tar.gz" &&
  tar zxvf "${KREW}.tar.gz" &&
  ./"${KREW}" install krew
)
```

Add krew to your PATH (add to `~/.zshrc` or `~/.bashrc`):

```bash
export PATH="${KREW_ROOT:-$HOME/.krew}/bin:$PATH"
```

Then reload your shell and check:

```bash
kubectl krew
```

### 1.3 Install the oidc-login plugin

`oidc-login` is provided by the **kubelogin** project as a kubectl plugin. ([GitHub][4])

```bash
kubectl krew update
kubectl krew install oidc-login
```

(Alternative on macOS: `brew install kubelogin`, but you specifically asked for the krew path. ([Homebrew Formulae][5]))

---

## 2. Linux

### 2.1 Install kubectl (curl method)

From Kubernetes docs, you can download the latest stable release (example shows `amd64`; adjust path for `arm64` etc.): ([Kubernetes][6])

```bash
# download latest stable kubectl for linux/amd64
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"

chmod +x kubectl
sudo mv kubectl /usr/local/bin/kubectl

kubectl version --client
```

> If you're on ARM, replace `linux/amd64` with `linux/arm64`.

You can also use your distro package repo if it has a recent enough version.

### 2.2 Install krew

Same script as macOS (Bash/Zsh) from the official krew docs: ([Krew][3])

```bash
(
  set -x; cd "$(mktemp -d)" &&
  OS="$(uname | tr '[:upper:]' '[:lower:]')" &&
  ARCH="$(uname -m | sed -e 's/x86_64/amd64/' \
                          -e 's/\(arm\)\(64\)\?.*/\1\2/' \
                          -e 's/aarch64$/arm64/')" &&
  KREW="krew-${OS}_${ARCH}" &&
  curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/latest/download/${KREW}.tar.gz" &&
  tar zxvf "${KREW}.tar.gz" &&
  ./"${KREW}" install krew
)
```

Add to PATH (e.g. in `~/.bashrc`/`~/.zshrc`):

```bash
export PATH="${KREW_ROOT:-$HOME/.krew}/bin:$PATH"
```

Verify:

```bash
kubectl krew
```

### 2.3 Install the oidc-login plugin

```bash
kubectl krew update
kubectl krew install oidc-login
```

This installs `kubectl oidc-login` (kubelogin) as a plugin. ([GitHub][4])

---

## 3. Windows

You can do this either in **PowerShell** or **cmd**. Below assumes PowerShell.

### 3.1 Install kubectl

Easiest is `winget` (from official docs): ([Kubernetes][7])

```powershell
winget install -e --id Kubernetes.kubectl

kubectl version --client
```

(Alternatives: `choco install kubernetes-cli` or direct download from Kubernetes docs.)

### 3.2 Install krew

From krew's Windows install instructions: ([Krew][3])

1. Ensure **Git** is installed.

2. Download `krew.exe` from the krew Releases page.

3. Open **cmd.exe** or PowerShell **as Administrator**, go to the download folder and run:

   ```powershell
   .\krew.exe install krew
   ```

4. Add krew to your PATH:

   * Add `%USERPROFILE%\.krew\bin` to your **User** or **System** PATH (via *System Properties → Environment Variables*).

5. Open a **new** terminal and verify:

   ```powershell
   kubectl krew
   ```

### 3.3 Install the oidc-login plugin

```powershell
kubectl krew update
kubectl krew install oidc-login
```

> Note: Some SAP docs recommend using the kubelogin release binaries instead of Krew/Chocolatey on Windows due to occasional installation issues; use that fallback if you see permission errors. ([Scribd][8])

---

## 4. Download kubeconfig from SAP BTP Kyma

Steps are the same regardless of OS; only the environment variable syntax differs.

### 4.1 Get kubeconfig.yaml from SAP BTP

In the **SAP BTP cockpit**: ([SAP][9])

1. Go to your **subaccount overview**.
2. In the **Kyma Environment** section, click **KubeconfigURL**.
3. A file `kubeconfig.yaml` is downloaded – this is your cluster's kubeconfig for Kyma.

This kubeconfig is OIDC-enabled and designed to work with `kubectl-oidc-login` (kubelogin) for reauthentication. ([Scribd][8])

### 4.2 Point kubectl at that kubeconfig

You can either:

#### Option A – Use `KUBECONFIG` environment variable (recommended, no overwrite)

**macOS / Linux (Bash/Zsh):** ([SAP Learning][10])

```bash
export KUBECONFIG=/absolute/path/to/kubeconfig.yaml
```

Add that line to your shell profile if you want it permanent.

**Windows (PowerShell):** ([Scribd][8])

```powershell
$Env:KUBECONFIG = "C:\full\path\to\kubeconfig.yaml"
```

(For a permanent user env var, set `KUBECONFIG` via *System Properties → Environment Variables* instead.)

#### Option B – Copy into the default location

By default, kubectl reads `~/.kube/config` (or `%USERPROFILE%\.kube\config` on Windows). ([Kubernetes][1])

* macOS / Linux:

  ```bash
  mkdir -p ~/.kube
  cp /path/to/kubeconfig.yaml ~/.kube/config
  ```

* Windows (PowerShell):

  ```powershell
  New-Item -ItemType Directory -Force "$Env:USERPROFILE\.kube" | Out-Null
  Copy-Item -Force "C:\path\to\kubeconfig.yaml" "$Env:USERPROFILE\.kube\config"
  ```

> Be careful not to accidentally overwrite another cluster config unless that's what you want.

---

## 5. Test the OIDC login + connectivity

With:

* `kubectl` installed,
* `krew` installed and on PATH,
* `oidc-login` plugin installed,
* `KUBECONFIG` pointing at your Kyma `kubeconfig.yaml`,

run:

```bash
kubectl get namespace
```

What happens under the hood:

1. `kubectl` reads the OIDC-enabled user entry in `kubeconfig` (which uses an `exec` section pointing to `kubectl oidc-login get-token`). ([GitHub][4])
2. `kubectl` invokes the `oidc-login` plugin.
3. **A browser window opens**, prompting you to log in to SAP BTP via your configured IdP.
4. After successful authentication, `kubelogin` (the plugin) gets an ID token/refresh token from the provider, writes the token into your kubeconfig or returns it as credentials, and `kubectl` uses it against the Kyma cluster's API server. ([GitHub][4])

On success you should see a list of namespaces in the Kyma cluster. If authentication or permissions fail, you'll typically see a 401/403 error or an RBAC error.

---

## 6. Quick checklist

For each OS, you *should* see:

* `kubectl version --client` → prints a client version.
* `kubectl krew` → krew usage/help.
* `kubectl oidc-login --help` → plugin help.
* `kubectl config get-contexts` → shows the Kyma context from your kubeconfig. ([SAP Learning][10])
* `kubectl get namespace` → triggers browser login once, then returns namespaces.

---

## Next Steps

Once you have kubectl configured and can access your Kyma cluster:

1. **Verify cluster modules**: Check that required Kyma modules are enabled (istio, api-gateway, telemetry)
2. **Check permissions**: Ensure you have appropriate RBAC permissions for your deployment
3. **Continue with setup**: Proceed to the main [deployment guide](README.md#quick-start) to deploy the SAP LLM Gateway

---

## References

[1]: https://kubernetes.io/docs/reference/kubectl/ "Command line tool (kubectl)"
[2]: https://pwittrock.github.io/docs/tasks/tools/install-kubectl/ "Install and Set Up kubectl - Kubernetes"
[3]: https://krew.sigs.k8s.io/docs/user-guide/setup/install/ "Installing - Krew - Kubernetes"
[4]: https://github.com/int128/kubelogin "int128/kubelogin: kubectl plugin for Kubernetes OpenID ..."
[5]: https://formulae.brew.sh/formula/kubelogin "kubelogin"
[6]: https://kubernetes.io/docs/tasks/tools/ "Install Tools"
[7]: https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/ "Install and Set Up kubectl on Windows"
[8]: https://www.scribd.com/document/874737284/SAP-BTP-Access-Kyma "SAP BTP Access Kyma | PDF | Transport Layer Security"
[9]: https://developers.sap.com/tutorials/deploy-to-kyma..html "Deploy in SAP BTP, Kyma Runtime | SAP Tutorials"
[10]: https://learning.sap.com/learning-journeys/developing-applications-in-sap-btp-kyma-runtime/setting-and-configuring-kubectl-for-kyma_b3d25bea-0ef5-498e-bd15-10ef0c23ed06 "Setting and Configuring Kubectl for Kyma"