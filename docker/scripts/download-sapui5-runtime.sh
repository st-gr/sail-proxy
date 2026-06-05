#!/bin/sh
# Download SAPUI5 Runtime for Docker deployment
# This script downloads the complete SAPUI5 runtime for offline usage

set -e

SAPUI5_VERSION="${SAPUI5_VERSION:-1.136.0}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/tmp/sapui5-runtime}"
TARGET_DIR="${TARGET_DIR:-/opt/ui5/${SAPUI5_VERSION}/resources}"

echo "=== Downloading SAPUI5 Runtime ${SAPUI5_VERSION} ==="
mkdir -p "${DOWNLOAD_DIR}" "${TARGET_DIR}"

# Download from SAPUI5 CDN (requires valid license)
# Note: This is a simplified approach. In production, you would:
# 1. Use SAP Download Manager or 
# 2. Copy from an existing SAP NetWeaver installation or
# 3. Use the UI5 Tooling framework download mechanism

# For now, we'll use the UI5 Tooling to download the framework
cd "${DOWNLOAD_DIR}"

# Create a minimal UI5 project to trigger framework download
cat > ui5.yaml << EOF
specVersion: "3.0"
metadata:
  name: sapui5-downloader
type: application
framework:
  name: SAPUI5
  version: "${SAPUI5_VERSION}"
  libraries:
    - name: sap.ui.core
    - name: sap.m
    - name: sap.f
    - name: sap.tnt
    - name: sap.ui.table
    - name: sap.ui.layout
    - name: sap.ui.unified
    - name: sap.ui.fl
    - name: sap.ui.mdc
    - name: sap.fe.core
    - name: sap.fe.templates
    - name: sap.ui.export
    - name: sap.viz
    - name: sap.suite.ui.microchart
    - name: sap.ui.codeeditor
    - name: sap.insights
    - name: themelib_sap_horizon
EOF

# Create minimal package.json
cat > package.json << EOF
{
  "name": "sapui5-downloader",
  "version": "1.0.0",
  "devDependencies": {
    "@ui5/cli": "^3.0.0"
  }
}
EOF

# Install UI5 CLI
npm install

# Use UI5 CLI to download the framework
# This will download to ~/.ui5/framework/
npx ui5 use SAPUI5@${SAPUI5_VERSION}

# Copy the downloaded framework to target directory
if [ -d "${HOME}/.ui5/framework/sapui5/${SAPUI5_VERSION}/resources" ]; then
    cp -r "${HOME}/.ui5/framework/sapui5/${SAPUI5_VERSION}/resources"/* "${TARGET_DIR}/"
    echo "✅ SAPUI5 runtime copied to ${TARGET_DIR}"
else
    echo "❌ Failed to find downloaded SAPUI5 framework"
    exit 1
fi

# Cleanup
cd /
rm -rf "${DOWNLOAD_DIR}"

echo "✅ SAPUI5 runtime ${SAPUI5_VERSION} ready at ${TARGET_DIR}"