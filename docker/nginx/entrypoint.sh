#!/bin/sh
set -e

echo "Starting SAP LLM Gateway Nginx with configurable setup..."

# Default values for environment variables
: ${NGINX_PORT:=8080}
: ${SERVER_NAME:=localhost}
: ${BASE_URL:=http://localhost:8080}
: ${LOGOUT_REDIRECT_URL:=${BASE_URL}/admin/app/shell/}

# Service hosts and ports with defaults
# Use Kubernetes service environment variables if available, otherwise fallback to Docker values
: ${OAUTH2_PROXY_SERVICE_HOST:=${OAUTH2_PROXY_HOST:-oauth2-proxy}}
: ${OAUTH2_PROXY_SERVICE_PORT:=${OAUTH2_PROXY_PORT:-4180}}
: ${OAUTH2_AUTH_PATH:=/oauth2/auth}
: ${OAUTH2_PROXY_PATH:=/oauth2}
: ${OAUTH2_SIGN_OUT_PATH:=/oauth2/sign_out}
: ${DEX_SERVICE_HOST:=${DEX_HOST:-dex}}
: ${DEX_SERVICE_PORT:=${DEX_PORT:-5556}}
: ${ADMIN_SERVICE_HOST:=${ADMIN_HOST:-admin}}
: ${ADMIN_SERVICE_PORT:=${ADMIN_PORT:-4004}}
: ${GATEWAY_SERVICE_HOST:=${GATEWAY_HOST:-gateway}}
: ${GATEWAY_SERVICE_PORT:=${GATEWAY_PORT:-3000}}


# Request timeout configuration (default 15 minutes)
: ${REQUEST_TIMEOUT_SECONDS:=900}

# Configuration mode: template or volume
: ${CONFIG_MODE:=template}

echo "Configuration mode: ${CONFIG_MODE}"

if [ "${CONFIG_MODE}" = "template" ]; then
    echo "Using template mode - generating configuration from environment variables"
    
    # Export all variables for envsubst
    export NGINX_PORT SERVER_NAME BASE_URL LOGOUT_REDIRECT_URL
    export OAUTH2_PROXY_HOST OAUTH2_PROXY_PORT DEX_HOST DEX_PORT ADMIN_HOST ADMIN_PORT
    export GATEWAY_HOST GATEWAY_PORT REQUEST_TIMEOUT_SECONDS
    # Export the SERVICE variables that are used in the nginx template
    export OAUTH2_PROXY_SERVICE_HOST OAUTH2_PROXY_SERVICE_PORT OAUTH2_AUTH_PATH OAUTH2_PROXY_PATH OAUTH2_SIGN_OUT_PATH
    export DEX_SERVICE_HOST DEX_SERVICE_PORT ADMIN_SERVICE_HOST ADMIN_SERVICE_PORT
    export GATEWAY_SERVICE_HOST GATEWAY_SERVICE_PORT
    
    # Debug: Print the SERVICE variables
    echo "DEBUG: OAUTH2_PROXY_SERVICE_HOST=${OAUTH2_PROXY_SERVICE_HOST}"
    echo "DEBUG: OAUTH2_PROXY_SERVICE_PORT=${OAUTH2_PROXY_SERVICE_PORT}"
    echo "DEBUG: DEX_SERVICE_HOST=${DEX_SERVICE_HOST}"
    echo "DEBUG: DEX_SERVICE_PORT=${DEX_SERVICE_PORT}"
    
    # Process nginx.conf template
    if [ -f /etc/nginx/templates/nginx.conf.tmpl ]; then
        echo "Processing nginx.conf template..."
        envsubst '${NGINX_PORT} ${SERVER_NAME} ${BASE_URL} ${LOGOUT_REDIRECT_URL} ${OAUTH2_PROXY_SERVICE_HOST} ${OAUTH2_PROXY_SERVICE_PORT} ${OAUTH2_AUTH_PATH} ${OAUTH2_PROXY_PATH} ${OAUTH2_SIGN_OUT_PATH} ${DEX_SERVICE_HOST} ${DEX_SERVICE_PORT} ${ADMIN_SERVICE_HOST} ${ADMIN_SERVICE_PORT} ${GATEWAY_SERVICE_HOST} ${GATEWAY_SERVICE_PORT} ${REQUEST_TIMEOUT_SECONDS}' \
            < /etc/nginx/templates/nginx.conf.tmpl \
            > /etc/nginx/nginx.conf
        echo "nginx.conf generated successfully"
    else
        echo "ERROR: nginx.conf template not found at /etc/nginx/templates/nginx.conf.tmpl"
        exit 1
    fi
    
    # Process proxy_params if template exists
    if [ -f /etc/nginx/templates/proxy_params.tmpl ]; then
        echo "Processing proxy_params template..."
        envsubst < /etc/nginx/templates/proxy_params.tmpl > /etc/nginx/proxy_params
    elif [ -f /etc/nginx/proxy_params ]; then
        echo "Using existing proxy_params file"
    else
        # Create default proxy_params if not exists
        echo "Creating default proxy_params..."
        cat > /etc/nginx/proxy_params <<EOF
proxy_set_header Host              \$host;
proxy_set_header X-Real-IP         \$remote_addr;
proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_redirect  off;
EOF
    fi
    
elif [ "${CONFIG_MODE}" = "volume" ]; then
    echo "Using volume mode - expecting configuration files to be mounted"
    
    # Verify required files exist
    if [ ! -f /etc/nginx/nginx.conf ]; then
        echo "ERROR: nginx.conf not found in volume mode"
        exit 1
    fi
    
    echo "Configuration files verified"
    
elif [ "${CONFIG_MODE}" = "configmap" ]; then
    echo "Using configmap mode - expecting Kubernetes ConfigMaps to be mounted"
    
    # For Kyma deployment: Use minimal nginx.conf that includes conf.d
    # The actual configuration comes from ConfigMaps mounted to /etc/nginx/conf.d/
    if [ ! -f /etc/nginx/nginx.conf ]; then
        echo "Creating minimal nginx.conf for ConfigMap mode..."
        cat > /etc/nginx/nginx.conf <<'NGINX_EOF'
# Minimal nginx configuration for Kubernetes ConfigMap mode
# Provider-specific configuration will be included from /etc/nginx/conf.d/

worker_processes auto;
worker_rlimit_nofile 65535;
error_log /var/log/nginx/error.log;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    
    # Access log without API keys. Keep this block identical to the copy in templates/nginx.conf.tmpl.
    # Gateway clients may send the key as ?key= or ?api_key= (a name
    # with a %-escape or a [..] suffix counts too); log_format would write it verbatim through
    # $request and $http_referer. A map gives one value per match (no global replace), so when
    # the query carries such a parameter the whole query is replaced, not just the value.
    # Not covered: error_log lines (e.g. upstream errors) still contain the request line and
    # cannot be masked by log_format; keep error_log at its default level and access restricted.
    map $query_string $sail_query_has_key {
        default 0;
        "~*(^|&)(key|api_key)(%5b[^=&]*|\[[^=&]*\])?=" 1;
        "~*(^|&)[^=&]*%[^=&]*=" 1;
    }
    map $request_uri $sail_request_path { "~^(?<p>[^?]*)" $p; default $request_uri; }
    map $sail_query_has_key $sail_logged_uri {
        default $request_uri;
        1 "$sail_request_path?<query redacted>";
    }
    map $http_referer $sail_logged_referer {
        default $http_referer;
        "~*[?&](key|api_key)(%5b[^=&#]*|\[[^=&#]*\])?=" "<referer query redacted>";
        "~*[?&][^=&#]*%[^=&#]*=" "<referer query redacted>";
    }

    log_format main '$remote_addr - $remote_user [$time_local] "$request_method $sail_logged_uri $server_protocol" '
                    '$status $body_bytes_sent "$sail_logged_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;
    
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    
    # Client request limits for large AI payloads
    client_max_body_size 50M;
    
    # Include all configuration files from conf.d
    # This is where Kubernetes ConfigMaps will mount provider-specific configs
    include /etc/nginx/conf.d/*.conf;
}
NGINX_EOF
    fi
    
    # Ensure conf.d directory exists
    mkdir -p /etc/nginx/conf.d
    
    echo "ConfigMap mode initialized"
    
else
    echo "ERROR: Invalid CONFIG_MODE: ${CONFIG_MODE}"
    echo "CONFIG_MODE must be 'template', 'volume', or 'configmap'"
    exit 1
fi

# Test nginx configuration
echo "Testing nginx configuration..."
nginx -t

if [ $? -ne 0 ]; then
    echo "ERROR: Nginx configuration test failed"
    exit 1
fi

echo "Nginx configuration test passed"

# Start nginx
echo "Starting nginx..."
exec nginx -g "daemon off;"