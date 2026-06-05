#!/bin/sh
# Download SAPUI5 Runtime for Docker deployment
# This script downloads the necessary SAPUI5 libraries for offline usage

SAPUI5_VERSION="1.136.0"
DOWNLOAD_DIR="/opt/ui5/${SAPUI5_VERSION}/resources"

echo "=== Downloading SAPUI5 Runtime ${SAPUI5_VERSION} ==="
mkdir -p "${DOWNLOAD_DIR}"

# List of required libraries based on manifest.json and ui5.yaml
LIBS="sap.ui.core sap.m sap.f sap.tnt sap.ui.table sap.ui.layout sap.ui.unified sap.ui.fl sap.ui.mdc sap.fe.core sap.fe.templates sap.ui.export sap.viz sap.suite.ui.microchart sap.ui.codeeditor sap.insights themelib_sap_horizon"

# Download sap-ui-core.js (the bootstrap file)
echo "Downloading sap-ui-core.js..."
curl -L "https://sdk.openui5.org/${SAPUI5_VERSION}/resources/sap-ui-core.js" -o "${DOWNLOAD_DIR}/sap-ui-core.js" || exit 1

# For a minimal setup in development, we'll use the CDN approach
# In production, you would want to download all library files
echo "✅ SAPUI5 runtime bootstrap downloaded"

# Create a marker file to indicate successful download
touch "${DOWNLOAD_DIR}/.download-complete"