/**
 * Deploy script for SAP LLM Gateway on Kyma using "Mesh at the Edge" pattern
 * This script applies the generated manifests with Istio configuration for edge services
 * 
 * Usage: node kyma/scripts/deploy-kyma.js
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');

const execAsync = promisify(exec);

async function runCommand(command, description, options = {}) {
  console.log(`\n${description}...`);
  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error('Warning:', stderr.trim());
    return { success: true, stdout, stderr };
  } catch (error) {
    // allowFailure is for probing a resource that is legitimately absent:
    // `kubectl get` exits non-zero with NotFound on stderr, which is an
    // answer, not a fault. Callers branch on `.success` instead. Shell
    // redirection would be the other way to silence it, but there is no
    // spelling of it that works on both cmd.exe and sh — `2>nul` creates a
    // file called nul under sh, `2>/dev/null` fails under cmd.exe — so the
    // discarding happens here, in portable JavaScript.
    if (!options.allowFailure) console.error(`Error: ${error.message}`);
    return { success: false, error };
  }
}

async function deployAndWait(service, type, manifestPath) {
  const filePath = service === 'postgres' || service === 'valkey' ? 
    path.join(manifestPath, 'core', `${service}.yaml`) :
    service === 'dex' || service === 'oauth2-proxy' ?
      path.join(manifestPath, 'auth', `${service}.yaml`) :
      path.join(manifestPath, 'core', `${service}.yaml`);
      
  await runCommand(
    `kubectl apply -f "${filePath}"`,
    `Deploying ${service}`
  );
  
  await runCommand(
    `kubectl -n sail-proxy rollout status ${type}/${service} --timeout=300s`,
    `Waiting for ${service} to be ready`
  );
}

// The api_config ConfigMap embeds a full copy of api_config.json as a YAML block
// scalar, indented four spaces. This is the exact rendering setup-kyma.js's
// createApiConfigMap() produces; keep the two in step.
function renderApiConfigMap(apiConfigContent, namespace) {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: admin-api-config
  namespace: ${namespace}
data:
  api_config.json: |
${apiConfigContent.split('\n').map(line => '    ' + line).join('\n')}
`;
}

// templates/configmaps/ is gitignored: every file in it is a local artifact of
// the last setup-kyma.js run. admin-api-config.yaml therefore carries whatever
// api_config.json looked like on the day setup was run, and deploying it
// afterwards seeds the cluster with that stale copy — which is how a machine
// set up before the six-group restructure of api_config.json would push the old
// flat shape to a cluster whose schema rejects it. Re-render it from the
// repository's api_config.json immediately before applying, so the ConfigMap is
// never older than the checkout.
function refreshApiConfigMap(templatesPath) {
  const configMapPath = path.join(templatesPath, 'configmaps', 'admin-api-config.yaml');
  const apiConfigPath = path.resolve(templatesPath, '..', '..', 'services', 'admin', 'api_config.json');

  if (!fs.existsSync(configMapPath)) {
    // No ConfigMap yet means setup-kyma.js has not run; it will generate one.
    return;
  }
  if (!fs.existsSync(apiConfigPath)) {
    console.log('⚠️  services/admin/api_config.json not found - leaving admin-api-config.yaml untouched');
    return;
  }

  // Preserve the namespace the ConfigMap was generated with rather than assuming
  // the default, so a non-default namespace is not silently rewritten.
  const existing = fs.readFileSync(configMapPath, 'utf8');
  const namespaceMatch = existing.match(/^\s+namespace:\s*(\S+)\s*$/m);
  const namespace = namespaceMatch ? namespaceMatch[1] : 'sail-proxy';

  const refreshed = renderApiConfigMap(fs.readFileSync(apiConfigPath, 'utf8'), namespace);
  if (refreshed === existing) {
    return;
  }

  fs.writeFileSync(configMapPath, refreshed);
  console.log('🔄 Refreshed admin-api-config.yaml from services/admin/api_config.json (it was stale)');
}

async function cleanupAndApplyIstioSystemPolicies(templatesPath) {
  // Look in manifests directory, not templates
  const kymaDir = path.resolve(templatesPath, '..');
  const istioSystemManifestsPath = path.join(kymaDir, 'manifests', 'istio-system');
  
  if (!fs.existsSync(istioSystemManifestsPath)) {
    console.log('No istio-system manifests found, skipping IP allowlist configuration');
    return;
  }
  
  // Check for existing authorization policies that might conflict
  console.log('Checking for existing IP allowlist policies...');
  
  try {
    // Only look for policies created by this system (sail-proxy specific)
    // Filtering happens here rather than through `| grep`: grep does not exist
    // on Windows, and its exit-1-on-no-match was doubling as control flow —
    // both the match and the "nothing matched" branch are explicit now.
    const { stdout } = await execAsync('kubectl get authorizationpolicies -n istio-system -o name');
    const policies = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes('allowlist-sail-proxy'));
    if (policies.length > 0) {
      console.log(`Found existing sail-proxy IP allowlist policies: ${policies.join(', ')}`);

      // Force delete only sail-proxy allowlist policies
      for (const policy of policies) {
        await runCommand(
          `kubectl delete ${policy} -n istio-system --force --grace-period=0`,
          `Force removing existing sail-proxy policy ${policy}`
        );
      }

      // Wait a moment for deletion to complete
      console.log('Waiting for policy deletion to complete...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log('No existing sail-proxy IP allowlist policies found');
    }
  } catch (error) {
    // kubectl error (no istio-system, no cluster access) - proceed with deployment
    console.log('No existing sail-proxy IP allowlist policies found');
  }
  
  // Apply new istio-system manifests with force to ensure replacement
  await runCommand(
    `kubectl apply -f "${istioSystemManifestsPath}/" --force-conflicts=true --server-side`,
    'Force applying istio-system IP allowlist configuration'
  );
}

// Fail-closed boundary: only unambiguous cp.* / healthcheck.cp.* hosts may ever be turned into
// an ALLOW. A wildcard or the app's own host here would defeat the IP allowlist, so it is dropped.
const CP_HOST = /^(healthcheck\.)?cp\.[a-z0-9-]+\.kyma\.ondemand\.com$/;

// Ensure the SAP Connectivity Proxy (SCC tunnel) hosts have ALLOW policies whenever the shared
// ingress gateway is ALREADY in deny-by-default. Reads the live Gateway so it also works for
// internal-only deployments (where the cluster subdomain was never collected at setup) and for
// deny-by-default caused by other apps.
//
// SECURITY: cp ALLOW policies are host-scoped, so they only ever grant the dedicated cp.* /
// healthcheck.cp.* hosts (which route to the Connectivity Proxy, NOT to sail-proxy). Every host
// read from the live Gateway is validated against CP_HOST before use, so a wildcard or unexpected
// host can never become an ALLOW that widens app access. It also refuses to act on an
// unrestricted gateway (which would itself strand every other host).
async function ensureConnectivityProxyAllowlist(savedConfig) {
  if (savedConfig && savedConfig.sccTunnel === false) {
    console.log('SCC tunnel support disabled by config, skipping cp allowlist');
    return;
  }

  // 1) Is the Connectivity Proxy present? Read its Gateway hosts (authoritative source).
  let hosts = [];
  try {
    // Double quotes, not single: cmd.exe does not strip single quotes, so kubectl
    // would receive them as part of the jsonpath and fail to parse it. Double
    // quotes are stripped by both cmd.exe and sh, and they still stop sh from
    // brace-expanding {...} or globbing [*].
    const { stdout } = await execAsync(
      'kubectl get gateway connectivity-proxy-tunnel -n kyma-system -o jsonpath="{.spec.servers[*].hosts[*]}"');
    hosts = stdout.split(/\s+/).map(h => h.trim()).filter(Boolean);
  } catch (e) {
    console.log('No connectivity-proxy-tunnel Gateway found, skipping cp allowlist (no SCC tunnel in this cluster)');
    return;
  }

  // Fail-closed validation: strip any "namespace/" prefix, then keep ONLY recognizable cp.* hosts.
  // This is the security boundary — a wildcard or the app host here would defeat the IP allowlist.
  hosts = hosts
    .map(h => (h.includes('/') ? h.split('/').pop() : h).trim())
    .filter(h => CP_HOST.test(h));
  if (hosts.length === 0) {
    console.log('connectivity-proxy-tunnel Gateway exposed no recognizable cp.* host; refusing to add ALLOW (fail-closed)');
    return;
  }

  // 2) Is the shared ingress gateway already deny-by-default? Only then is it SAFE to add cp ALLOWs.
  //    (Adding the first ALLOW to an unrestricted gateway would strand every other host.)
  //    The check EXCLUDES allowlist-cp-* so a re-run cannot treat its own policies as justification.
  let denyByDefault = false;
  try {
    const { stdout } = await execAsync('kubectl get authorizationpolicy -n istio-system -o json');
    const items = (JSON.parse(stdout).items || []);
    denyByDefault = items.some(p => {
      const name = p.metadata?.name || '';
      const ml = p.spec?.selector?.matchLabels || {};
      const targetsGw = ml['istio'] === 'ingressgateway' || ml['app'] === 'istio-ingressgateway';
      return p.spec?.action === 'ALLOW' && targetsGw && !name.startsWith('allowlist-cp-');
    });
  } catch (e) { /* treat as not deny-by-default */ }
  if (!denyByDefault) {
    console.log('Shared ingress gateway is not deny-by-default; cp ALLOW policies not needed (and would be unsafe)');
    return;
  }

  // 3) Apply the two ALLOW policies from the validated live hosts (host + host:443).
  const tunnelHosts = hosts.filter(h => !h.startsWith('healthcheck.'));
  const hcHosts     = hosts.filter(h =>  h.startsWith('healthcheck.'));
  const withPort = hs => hs.flatMap(h => [h, `${h}:443`]);
  const q = arr => arr.map(h => `"${h}"`).join(', ');
  const docs = [];
  if (tunnelHosts.length) docs.push(
`apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allowlist-cp-tunnel
  namespace: istio-system
  labels: { app: connectivity-proxy }
spec:
  selector: { matchLabels: { istio: ingressgateway } }
  action: ALLOW
  rules:
  - to:
    - operation:
        hosts: [${q(withPort(tunnelHosts))}]`);
  if (hcHosts.length) docs.push(
`apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allowlist-cp-healthcheck
  namespace: istio-system
  labels: { app: connectivity-proxy }
spec:
  selector: { matchLabels: { istio: ingressgateway } }
  action: ALLOW
  rules:
  - to:
    - operation:
        hosts: [${q(withPort(hcHosts))}]
        methods: ["GET", "HEAD"]
        paths: ["/healthcheck", "/"]`);
  if (!docs.length) return;

  // Write to a temp file and apply server-side (matches cleanupAndApplyIstioSystemPolicies and
  // avoids any shell-quoting of the generated manifest).
  const manifest = docs.join('\n---\n');
  const tmpPath = path.join(os.tmpdir(), 'connectivity-proxy-allow.yaml');
  fs.writeFileSync(tmpPath, manifest);
  try {
    await runCommand(
      `kubectl apply -f "${tmpPath}" --force-conflicts=true --server-side`,
      'Applying SCC Connectivity Proxy ALLOW policies (cp tunnel + healthcheck)');
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function deployToKyma() {
  console.log('=== SAP LLM Gateway Kyma Deployment (Mesh at the Edge) ===\n');
  console.log('This deployment uses the "Mesh at the Edge" pattern:');
  console.log('- Edge services with sidecars: nginx, oauth2-proxy (for ingress gateway connectivity)');
  console.log('- Dex runs WITHOUT sidecar (disabled to prevent communication issues)');
  console.log('- Backend services (gateway, admin, postgres, valkey) run WITHOUT sidecars');
  console.log('- Namespace uses PERMISSIVE mTLS for mixed mesh/non-mesh communication\n');

  // Get absolute paths based on script location
  const scriptsDir = __dirname;
  const kymaDir = path.resolve(scriptsDir, '..');
  const manifestPath = path.join(kymaDir, 'manifests');
  const templatesPath = path.join(kymaDir, 'templates');
  
  // Check if manifests exist
  if (!fs.existsSync(manifestPath)) {
    console.error('Error: Manifests directory not found. Please run setup-kyma.js first.');
    process.exit(1);
  }
  
  // Get deployment config from environment variable
  let savedConfig = {};
  if (process.env.KYMA_DEPLOY_CONFIG) {
    try {
      // Decode base64 config
      const decodedConfig = Buffer.from(process.env.KYMA_DEPLOY_CONFIG, 'base64').toString('utf8');
      savedConfig = JSON.parse(decodedConfig);
      
      // Clear the environment variable immediately
      delete process.env.KYMA_DEPLOY_CONFIG;
      console.log('🔒 Deployment configuration loaded and environment variable cleared\n');
    } catch (e) {
      console.error('⚠️  Error decoding deployment configuration:', e.message);
      delete process.env.KYMA_DEPLOY_CONFIG;
    }
  }

  // 1. Create namespace with Istio injection enabled
  console.log('Step 1: Creating namespace with Istio injection enabled...');
  await runCommand(
    `kubectl apply -f "${path.join(manifestPath, 'core', 'namespace.yaml')}"`,
    'Creating namespace'
  );
  
  // Enable Istio injection for the namespace (required for mesh-at-edge pattern)
  await runCommand(
    'kubectl label namespace sail-proxy istio-injection=enabled --overwrite',
    'Enabling Istio injection for namespace'
  );

  // 2. Create image pull secret if credentials are available
  if (savedConfig.imagePullSecrets && savedConfig.dockerUsername && savedConfig.dockerPassword) {
    console.log('\nStep 2: Creating image pull secret...');
    
    const createSecretCmd = `kubectl create secret docker-registry registry-secret ` +
      `--docker-server=${savedConfig.containerRegistry} ` +
      `--docker-username=${savedConfig.dockerUsername} ` +
      `--docker-password="${savedConfig.dockerPassword}" ` +
      `--namespace=sail-proxy --dry-run=client -o yaml | kubectl apply -f -`;
    
    await runCommand(
      createSecretCmd,
      'Creating registry-secret'
    );
  }

  // 3. Apply networking configuration for mesh-at-edge pattern
  const step3Label = savedConfig.imagePullSecrets ? 'Step 3' : 'Step 2';
  console.log(`\n${step3Label}: Applying mesh-at-edge networking configuration...`);
  
  // Apply PeerAuthentication for PERMISSIVE mTLS
  console.log('\nApplying PeerAuthentication for PERMISSIVE mTLS...');
  const peerAuthYaml = `apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: sail-proxy
spec:
  mtls:
    mode: PERMISSIVE`;
  
  // Via a temp file rather than `echo '<yaml>' |`: multi-line YAML wrapped in
  // single quotes is sh-only syntax, and cmd.exe would hand the quotes and the
  // unsplit lines straight to kubectl. This is the same approach
  // applyConnectivityProxyAllowPolicies() already uses for its generated
  // manifests, for the same shell-quoting reason.
  const peerAuthPath = path.join(os.tmpdir(), 'sail-proxy-peerauthentication.yaml');
  fs.writeFileSync(peerAuthPath, peerAuthYaml);
  try {
    // Path is quoted: os.tmpdir() honours TEMP, which on Windows can resolve to
    // a directory containing spaces, and double quotes are the one form both
    // cmd.exe and sh strip correctly.
    await runCommand(
      `kubectl apply -f "${peerAuthPath}"`,
      'Creating PeerAuthentication'
    );
  } finally {
    fs.unlinkSync(peerAuthPath);
  }
  
  // Apply DestinationRules for non-mesh services
  const destinationRulesPath = path.join(manifestPath, 'networking', 'destination-rules.yaml');
  if (fs.existsSync(destinationRulesPath)) {
    await runCommand(
      `kubectl apply -f "${destinationRulesPath}"`,
      'Applying DestinationRules for non-mesh services'
    );
  }
  
  // Clean up any existing authorization policies and apply new ones
  await cleanupAndApplyIstioSystemPolicies(templatesPath);

  // Keep the SAP Connectivity Proxy (SCC tunnel) hosts reachable when the shared ingress gateway
  // is deny-by-default. Runs for BOTH deployment types and only acts when already locked down.
  await ensureConnectivityProxyAllowlist(savedConfig);

  // 4. Label edge services for Istio injection
  const step4Label = savedConfig.imagePullSecrets ? 'Step 4' : 'Step 3';
  console.log(`\n${step4Label}: Configuring Istio sidecar injection for services...`);
  
  // Edge services that NEED sidecars for ingress gateway
  const edgeServices = ['nginx', 'oauth2-proxy', 'dex'];
  // Backend services that DON'T need sidecars
  const backendServices = ['gateway', 'admin', 'postgres', 'valkey'];
  
  console.log('\nEdge services with sidecars: nginx, oauth2-proxy (for ingress gateway)');
  console.log('Edge service without sidecar: dex (disabled for communication fix)');
  console.log('Backend services (no sidecars): gateway, admin, postgres, valkey');

  // 5. Apply all manifests in the correct order
  const step5Label = savedConfig.imagePullSecrets ? 'Step 5' : 'Step 4';
  console.log(`\n${step5Label}: Applying all manifests in correct order...`);
  
  // Apply secrets first - they are required for deployments
  const secretsPath = path.join(templatesPath, 'secrets');
  if (fs.existsSync(secretsPath)) {
    console.log('\nApplying secrets individually to ensure proper creation...');
    const secretFiles = ['admin-env.yaml', 'gateway-env.yaml', 'gateway-migration-env.yaml', 'oauth2-proxy-secrets.yaml', 'postgres-env.yaml'];
    
    for (const secretFile of secretFiles) {
      const secretFilePath = path.join(secretsPath, secretFile);
      if (fs.existsSync(secretFilePath)) {
        await runCommand(
          `kubectl apply -f "${secretFilePath}"`,
          `Applying ${secretFile}`
        );
      }
    }
  }
  
  // Apply configmaps - required for nginx and dex
  const configmapsPath = path.join(templatesPath, 'configmaps');
  if (fs.existsSync(configmapsPath)) {
    refreshApiConfigMap(templatesPath);
    await runCommand(
      `kubectl apply -f "${configmapsPath}/"`,
      'Applying configmaps'
    );
  }
  
  // Apply network policies first
  const networkPoliciesPath = path.join(manifestPath, 'core', 'network-policies.yaml');
  if (fs.existsSync(networkPoliciesPath)) {
    await runCommand(
      `kubectl apply -f "${networkPoliciesPath}"`,
      'Applying network policies'
    );
  } else {
    console.log('⚠️  No network policies found - skipping');
  }
  
  console.log('\nDeploying services in dependency order...');
  
  // Step 1: Deploy data stores first (no dependencies)
  console.log('\n--- Deploying data stores ---');
  await deployAndWait('postgres', 'statefulset', manifestPath);
  await deployAndWait('valkey', 'deployment', manifestPath);
  
  // Step 2: Deploy Dex (no dependencies)
  console.log('\n--- Deploying identity provider ---');
  // Apply Dex RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding) first
  const dexRbacPath = path.join(manifestPath, 'auth', 'dex-rbac.yaml');
  if (fs.existsSync(dexRbacPath)) {
    await runCommand(
      `kubectl apply -f "${dexRbacPath}"`,
      'Applying Dex RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)'
    );
  }
  await deployAndWait('dex', 'deployment', manifestPath);
  
  // Step 3: Deploy OAuth2-Proxy (depends on Dex)
  console.log('\n--- Deploying OAuth2-Proxy ---');
  await deployAndWait('oauth2-proxy', 'deployment', manifestPath);
  
  // Step 4: Deploy Admin service (depends on Postgres and Valkey)
  console.log('\n--- Deploying Admin service ---');
  await deployAndWait('admin', 'deployment', manifestPath);
  
  // Step 5: Deploy Gateway service (depends on Admin and Valkey)
  console.log('\n--- Deploying Gateway service ---');
  await deployAndWait('gateway', 'deployment', manifestPath);
  
  // Step 6: Deploy NGINX last (depends on all other services)
  console.log('\n--- Deploying NGINX edge proxy ---');
  await deployAndWait('nginx', 'deployment', manifestPath);
  
  // Apply networking manifests
  const networkingPath = path.join(manifestPath, 'networking');
  if (fs.existsSync(networkingPath)) {
    await runCommand(
      `kubectl apply -f "${networkingPath}/"`,
      'Applying networking manifests'
    );
  }

  // 6. Services are already deployed and waited for in the correct order
  const step6Label = savedConfig.imagePullSecrets ? 'Step 6' : 'Step 5';
  console.log(`\n${step6Label}: All services have been deployed in dependency order.`);

  // 7. Check pod status
  const step7Label = savedConfig.imagePullSecrets ? 'Step 7' : 'Step 6';
  console.log(`\n${step7Label}: Current pod status:`);
  await runCommand(
    'kubectl -n sail-proxy get pods',
    'Getting pod status'
  );
  
  console.log('\n🔍 Checking sidecar injection status...');
  console.log('nginx, oauth2-proxy should show 2/2 containers (app + sidecar)');
  console.log('dex, gateway, admin, postgres, valkey should show 1/1 container (app only)\n');

  // 8. Check VirtualService and ingress status
  const step8Label = savedConfig.imagePullSecrets ? 'Step 8' : 'Step 7';
  console.log(`\n${step8Label}: Checking ingress status...`);
  
  // First check if VirtualService exists (streaming deployment)
  const vsResult = await runCommand(
    'kubectl -n sail-proxy get virtualservice sail-proxy-streaming -o json',
    'Checking VirtualService status',
    { allowFailure: true }
  );

  let isStreamingDeployment = false;
  let hostFromVS = null;

  if (vsResult.success && vsResult.stdout) {
    try {
      const vs = JSON.parse(vsResult.stdout);
      isStreamingDeployment = true;
      // Extract host from VirtualService (typically from Gateway selector)
      const gateways = vs.spec?.gateways || [];
      if (gateways.length > 0) {
        // Get the Gateway to find the host
        const gatewayResult = await runCommand(
          `kubectl -n sail-proxy get gateway ${gateways[0].replace('sail-proxy/', '')} -o json`,
          'Getting Gateway details',
          { allowFailure: true }
        );
        if (gatewayResult.success && gatewayResult.stdout) {
          const gateway = JSON.parse(gatewayResult.stdout);
          hostFromVS = gateway.spec?.servers?.[0]?.hosts?.[0] || 'unknown';
        }
      }
      console.log('\n✅ VirtualService deployment detected (streaming-optimized)');
    } catch (e) {
      console.log('\n⚠️  VirtualService found but could not parse details');
    }
  }
  
  if (!isStreamingDeployment) {
    // Fallback: check for APIRule (legacy deployment)
    const apiRuleResult = await runCommand(
      'kubectl -n sail-proxy get apirule sail-proxy -o json',
      'Checking APIRule status',
      { allowFailure: true }
    );

    if (apiRuleResult.success && apiRuleResult.stdout) {
      try {
        const apiRule = JSON.parse(apiRuleResult.stdout);
        const status = apiRule.status?.state || 'Unknown';
        const description = apiRule.status?.description || 'No description';
        
        console.log(`\nAPIRule Status: ${status}`);
        console.log(`Description: ${description}`);
        
        if (status === 'Ready') {
          const host = apiRule.spec?.hosts?.[0] || 'unknown';
          console.log(`\n✅ Deployment successful!`);
          console.log(`\nYour application is available at:`);
          console.log(`  Gateway API: https://${host}/gateway`);
          console.log(`  Admin OData: https://${host}/admin/odata/v4/admin`);
          console.log(`  Adm.Cockpit: https://${host}/admin/app/shell/`);
        } else if (status === 'Error' && description.includes('does not have an injected istio sidecar')) {
          console.log('\n⚠️  Edge services need Istio sidecars. Restarting edge services...');
          
          // Restart only edge services
          for (const deployment of edgeServices) {
            await runCommand(
              `kubectl -n sail-proxy rollout restart deployment/${deployment}`,
              `Restarting ${deployment} to inject sidecar`
            );
          }
          
          console.log('\nWaiting for edge services to restart with sidecars...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          for (const deployment of edgeServices) {
            await runCommand(
              `kubectl -n sail-proxy rollout status deployment/${deployment} --timeout=300s`,
              `Waiting for ${deployment} with sidecar`
            );
          }
          
          console.log('\nPlease check APIRule status again: kubectl -n sail-proxy get apirule');
        }
      } catch (e) {
        console.error('Error parsing APIRule status:', e.message);
      }
    } else {
      console.log('\n⚠️  No APIRule found - this appears to be a VirtualService-based deployment');
      isStreamingDeployment = true;
    }
  }
  
  if (isStreamingDeployment) {
    console.log('\n✅ Deployment successful!');
    console.log('\n🚀 VirtualService-based deployment with streaming optimizations:');
    console.log('  - Enhanced streaming support for Claude and OpenAI endpoints');
    console.log('  - Disabled retries and extended timeouts for AI model responses');
    console.log('  - HTTP/1.1 enforcement for better streaming compatibility');
    
    if (hostFromVS && hostFromVS !== 'unknown') {
      console.log(`\nYour application is available at:`);
      console.log(`  Gateway API: https://${hostFromVS}/gateway`);
      console.log(`  Admin OData: https://${hostFromVS}/admin/odata/v4/admin`);
      console.log(`  Adm.Cockpit: https://${hostFromVS}/admin/app/shell/`);
    } else {
      console.log('\nTo find your application URL, check:');
      console.log('kubectl -n sail-proxy get gateway -o yaml');
    }
  }

  console.log('\n=== Deployment completed ===\n');
  
  // Final instructions
  console.log('Mesh-at-Edge Pattern Summary:');
  console.log('- Namespace has PERMISSIVE mTLS (mixed mesh/non-mesh communication allowed)');
  console.log('- Edge services with sidecars: nginx (2/2), oauth2-proxy (2/2)');
  console.log('- Edge service without sidecar: dex (1/1) - sidecar disabled to fix communication');
  console.log('- Backend services (gateway, admin, postgres, valkey) run without sidecars (1/1)');
  console.log('- DestinationRules disable mTLS to non-mesh services\n');
  
  console.log('Next steps:');
  console.log('1. Verify pod status: kubectl -n sail-proxy get pods');
  console.log('   - nginx, oauth2-proxy should show 2/2 (app + sidecar)');
  console.log('   - dex, gateway, admin should show 1/1 (app only)');
  console.log('2. Check ingress status: kubectl -n sail-proxy get virtualservice,gateway');
  console.log('3. Test external access from your whitelisted IP');
  console.log('4. Monitor logs: kubectl -n sail-proxy logs -f deployment/admin');
  console.log('\nTroubleshooting:');
  console.log('- If services can\'t communicate, check: kubectl -n sail-proxy get peerauthentication');
  console.log('- If ingress fails, ensure nginx has sidecar: kubectl -n sail-proxy get pod -l app=nginx');
}

// Run the deployment. Guarded so the ConfigMap rendering helpers can be
// required from tests; the script is only ever invoked as `node deploy-kyma.js`
// (directly or spawned by setup-kyma.js), so require.main is always this file.
if (require.main === module) {
  deployToKyma().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
  });
}

module.exports = { renderApiConfigMap, refreshApiConfigMap };