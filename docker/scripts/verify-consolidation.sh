#!/bin/sh

# verify-consolidation.sh
# Verifies that UI5 resources consolidation was successful

set -eu

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default paths
ADMIN_ROOT="${ADMIN_ROOT:-/app/services/admin}"
APPS_DIR="${ADMIN_ROOT}/app"
CENTRAL_RESOURCES="$ADMIN_ROOT/app/resources"

# Test options
TEST_HTTP=${TEST_HTTP:-false}
HTTP_PORT=${HTTP_PORT:-4004}
VERBOSE=${VERBOSE:-false}

log() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

verbose() {
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${NC}[VERBOSE]${NC} $1"
    fi
}

# Show usage
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Verify UI5 resources consolidation results.

Options:
    --test-http         Test HTTP serving of symlinked resources
    --port PORT         HTTP port to test (default: 4004)
    --verbose           Show verbose output
    -h, --help          Show this help message

Environment variables:
    ADMIN_ROOT          Root directory of admin service (default: /app/services/admin)
    TEST_HTTP           Test HTTP serving (default: false)
    HTTP_PORT           Port for HTTP testing (default: 4004)
    VERBOSE             Verbose output (default: false)

Examples:
    $0                  # Basic verification
    $0 --test-http      # Include HTTP serving tests
    $0 --verbose        # Detailed output

EOF
}

# Format bytes to human readable
format_bytes() {
    local bytes="$1"
    if [ "$bytes" -ge 1073741824 ]; then
        printf "%.1fGB" "$(echo "$bytes / 1073741824" | bc -l)"
    elif [ "$bytes" -ge 1048576 ]; then
        printf "%.1fMB" "$(echo "$bytes / 1048576" | bc -l)"
    elif [ "$bytes" -ge 1024 ]; then
        printf "%.1fKB" "$(echo "$bytes / 1024" | bc -l)"
    else
        echo "${bytes}B"
    fi
}

# Get directory size in bytes
get_dir_size() {
    local dir="$1"
    if [ -d "$dir" ]; then
        du -sb "$dir" 2>/dev/null | cut -f1
    else
        echo "0"
    fi
}

# Check if consolidation exists
check_consolidation_exists() {
    log "Checking if consolidation was performed..."
    
    if [ ! -d "$CENTRAL_RESOURCES" ]; then
        error "Central resources directory not found: $CENTRAL_RESOURCES"
        echo "Run 'consolidate-ui5-resources.sh' first to perform consolidation."
        return 1
    fi
    
    success "Central resources directory exists: $CENTRAL_RESOURCES"
    
    local central_size
    central_size=$(get_dir_size "$CENTRAL_RESOURCES")
    echo "Central resources size: $(format_bytes $central_size)"
    
    return 0
}

# Find all UI5 apps
find_ui5_apps() {
    local apps_file
    apps_file=$(mktemp)
    
    verbose "Scanning for UI5 apps in $APPS_DIR..."
    
    find "$APPS_DIR" -type d -path "*/dist/resources" 2>/dev/null | while IFS= read -r app_path; do
        local app_dir
        app_dir=$(dirname "$app_path")
        local app_name
        app_name=$(basename "$(dirname "$app_dir")")
        echo "$app_name:$app_path" >> "$apps_file"
        verbose "Found UI5 app: $app_name"
    done
    
    cat "$apps_file"
    rm -f "$apps_file"
}

# Verify symlinks integrity
verify_symlinks() {
    log "Verifying symlinks integrity..."
    
    local total_links=0
    local broken_links=0
    local valid_links=0
    
    find "$APPS_DIR" -type l 2>/dev/null | while IFS= read -r symlink; do
        total_links=$((total_links + 1))
        
        if [ -L "$symlink" ]; then
            local target
            target=$(readlink "$symlink")
            
            if [ -e "$symlink" ]; then
                valid_links=$((valid_links + 1))
                verbose "Valid symlink: $symlink → $target"
            else
                broken_links=$((broken_links + 1))
                error "Broken symlink: $symlink → $target"
            fi
        fi
    done
    
    echo "Total symlinks: $total_links"
    echo "Valid symlinks: $valid_links"
    echo "Broken symlinks: $broken_links"
    
    if [ "$broken_links" -eq 0 ]; then
        success "All symlinks are valid"
        return 0
    else
        error "$broken_links broken symlinks found"
        return 1
    fi
}

# Calculate space usage
calculate_space_usage() {
    log "Calculating space usage..."
    
    local apps
    apps=$(find_ui5_apps)
    
    local total_app_resources_size=0
    local symlinks_count=0
    local regular_files_count=0
    
    echo
    echo "=== SPACE USAGE BY APP ==="
    
    while IFS= read -r app_info; do
        [ -z "$app_info" ] && continue
        
        local app_name="${app_info%%:*}"
        local resources_path="${app_info##*:}"
        
        if [ -d "$resources_path" ]; then
            local app_size
            app_size=$(get_dir_size "$resources_path")
            total_app_resources_size=$((total_app_resources_size + app_size))
            
            # Count symlinks vs regular files in this app (avoid subshell)
            local app_symlinks=0
            local app_regular_files=0
            local temp_file
            temp_file=$(mktemp)
            
            find "$resources_path" \( -type f -o -type l \) 2>/dev/null > "$temp_file"
            
            while IFS= read -r file; do
                if [ -L "$file" ]; then
                    app_symlinks=$((app_symlinks + 1))
                elif [ -f "$file" ]; then
                    app_regular_files=$((app_regular_files + 1))
                fi
            done < "$temp_file"
            
            rm -f "$temp_file"
            
            symlinks_count=$((symlinks_count + app_symlinks))
            regular_files_count=$((regular_files_count + app_regular_files))
            
            echo "$app_name:"
            echo "  Size: $(format_bytes $app_size)"
            echo "  Symlinks: $app_symlinks"
            echo "  Regular files: $app_regular_files"
        fi
    done <<EOF
$apps
EOF
    
    local central_size
    central_size=$(get_dir_size "$CENTRAL_RESOURCES")
    
    echo
    echo "=== TOTAL SPACE USAGE ==="
    echo "Central resources: $(format_bytes $central_size)"
    echo "App resources (symlinks + unique files): $(format_bytes $total_app_resources_size)"
    echo "Total current usage: $(format_bytes $((central_size + total_app_resources_size)))"
    echo
    echo "Total symlinks: $symlinks_count"
    echo "Total regular files: $regular_files_count"
    
    # Try to calculate original size if backup exists
    if [ -f "$ADMIN_ROOT/.resources-backup-location" ]; then
        local backup_location
        backup_location=$(cat "$ADMIN_ROOT/.resources-backup-location")
        
        if [ -d "$backup_location" ]; then
            local backup_size
            backup_size=$(get_dir_size "$backup_location")
            local savings=$((backup_size - central_size - total_app_resources_size))
            local savings_percent=0
            
            if [ "$backup_size" -gt 0 ]; then
                savings_percent=$((savings * 100 / backup_size))
            fi
            
            echo
            echo "=== CONSOLIDATION RESULTS ==="
            echo "Original size (from backup): $(format_bytes $backup_size)"
            echo "Current size: $(format_bytes $((central_size + total_app_resources_size)))"
            echo "Space saved: $(format_bytes $savings) (${savings_percent}%)"
        fi
    fi
}

# Test HTTP serving of symlinked resources
test_http_serving() {
    if [ "$TEST_HTTP" = "false" ]; then
        return 0
    fi
    
    log "Testing HTTP serving of symlinked resources..."
    
    # Check if curl is available
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl not available, skipping HTTP tests"
        return 0
    fi
    
    # Check if service is running
    if ! curl -s "http://localhost:$HTTP_PORT/health" >/dev/null 2>&1; then
        warn "Admin service not responding on port $HTTP_PORT, skipping HTTP tests"
        return 0
    fi
    
    local tested_count=0
    local successful_tests=0
    
    # Find some symlinked files to test
    local test_files_temp
    test_files_temp=$(mktemp)
    
    find "$APPS_DIR" -type l \( -name "*.js" -o -name "*.css" \) 2>/dev/null | head -5 | while IFS= read -r symlink; do
        if [ -L "$symlink" ]; then
            # Convert file path to HTTP path
            local http_path="${symlink#$ADMIN_ROOT}"
            echo "$http_path" >> "$test_files_temp"
            tested_count=$((tested_count + 1))
        fi
    done
    
    local file_count
    file_count=$(wc -l < "$test_files_temp")
    echo "Testing $file_count symlinked resources via HTTP..."
    
    while IFS= read -r http_path; do
        local url="http://localhost:$HTTP_PORT$http_path"
        
        verbose "Testing: $url"
        
        if curl -s -f -I "$url" >/dev/null 2>&1; then
            successful_tests=$((successful_tests + 1))
            verbose "  ✓ Success"
        else
            error "  ✗ Failed: $url"
        fi
    done < "$test_files_temp"
    
    rm -f "$test_files_temp"
    
    echo "HTTP tests: $successful_tests/$file_count successful"
    
    if [ "$successful_tests" -eq "$file_count" ]; then
        success "All HTTP tests passed - symlinked resources serve correctly"
        return 0
    else
        error "Some HTTP tests failed"
        return 1
    fi
}

# Check file integrity
check_file_integrity() {
    log "Checking file integrity..."
    
    local checked_files=0
    local integrity_errors=0
    
    # Sample some symlinked files and verify they match their targets
    find "$APPS_DIR" -type l 2>/dev/null | head -10 | while IFS= read -r symlink; do
        if [ -L "$symlink" ]; then
            local target
            target=$(readlink "$symlink")
            local absolute_target
            
            # Convert relative path to absolute
            case "$target" in
                /*)
                    absolute_target="$target"
                    ;;
                *)
                    absolute_target="$(dirname "$symlink")/$target"
                    ;;
            esac
            
            # Resolve any .. components
            absolute_target=$(cd "$(dirname "$absolute_target")" && pwd)/$(basename "$absolute_target")
            
            if [ -f "$absolute_target" ]; then
                # Compare file sizes as a basic integrity check
                local symlink_size
                local target_size
                symlink_size=$(stat -f%z "$symlink" 2>/dev/null || stat -c%s "$symlink" 2>/dev/null)
                target_size=$(stat -f%z "$absolute_target" 2>/dev/null || stat -c%s "$absolute_target" 2>/dev/null)
                
                if [ "$symlink_size" = "$target_size" ]; then
                    verbose "Integrity OK: $(basename "$symlink")"
                else
                    error "Integrity mismatch: $symlink ($symlink_size) vs $absolute_target ($target_size)"
                    integrity_errors=$((integrity_errors + 1))
                fi
            else
                error "Target not found: $absolute_target (for $symlink)"
                integrity_errors=$((integrity_errors + 1))
            fi
            
            checked_files=$((checked_files + 1))
        fi
    done
    
    echo "File integrity checks: $checked_files files checked, $integrity_errors errors"
    
    if [ "$integrity_errors" -eq 0 ]; then
        success "File integrity verification passed"
        return 0
    else
        error "File integrity issues found"
        return 1
    fi
}

# Generate consolidation report
generate_report() {
    log "Generating consolidation report..."
    
    local report_file="$ADMIN_ROOT/consolidation-report.txt"
    
    {
        echo "=== UI5 RESOURCES CONSOLIDATION REPORT ==="
        echo "Generated: $(date)"
        echo "Admin root: $ADMIN_ROOT"
        echo "Central resources: $CENTRAL_RESOURCES"
        echo
        
        echo "=== DIRECTORY STRUCTURE ==="
        if command -v tree >/dev/null 2>&1; then
            tree -L 3 "$CENTRAL_RESOURCES" 2>/dev/null || echo "Central resources structure not available"
        else
            find "$CENTRAL_RESOURCES" -type d | head -20
        fi
        echo
        
        echo "=== SYMLINK SUMMARY ==="
        find "$APPS_DIR" -type l | wc -l | xargs echo "Total symlinks:"
        find "$APPS_DIR" -type f | wc -l | xargs echo "Regular files:"
        echo
        
        echo "=== SPACE USAGE ==="
        get_dir_size "$CENTRAL_RESOURCES" | xargs -I {} echo "Central resources: $(format_bytes {})"
        
        local total_app_size=0
        find "$APPS_DIR" -type d -path "*/dist/resources" 2>/dev/null | while IFS= read -r resources_dir; do
            local size
            size=$(get_dir_size "$resources_dir")
            total_app_size=$((total_app_size + size))
        done
        
        echo "App resources: $(format_bytes $total_app_size)"
        echo "Total: $(format_bytes $(($(get_dir_size "$CENTRAL_RESOURCES") + total_app_size)))"
        
    } > "$report_file"
    
    success "Report generated: $report_file"
}

# Main verification function
main() {
    echo "=== UI5 RESOURCES CONSOLIDATION VERIFICATION ==="
    echo "Admin root: $ADMIN_ROOT"
    echo "Central resources: $CENTRAL_RESOURCES"
    echo "Test HTTP: $TEST_HTTP"
    echo
    
    local exit_code=0
    
    # Basic checks
    check_consolidation_exists || exit_code=1
    
    echo
    verify_symlinks || exit_code=1
    
    echo
    calculate_space_usage
    
    echo
    check_file_integrity || exit_code=1
    
    echo
    test_http_serving || exit_code=1
    
    echo
    generate_report
    
    echo
    if [ "$exit_code" -eq 0 ]; then
        success "All verification checks passed!"
        echo
        echo "=== NEXT STEPS ==="
        echo "1. Test your UI5 applications to ensure they work correctly"
        echo "2. Monitor for any 404 errors in application logs"
        echo "3. Consider integrating consolidation into your Docker build process"
    else
        error "Some verification checks failed"
        echo "Review the output above and fix any issues before proceeding"
    fi
    
    return $exit_code
}

# Parse command line arguments
while [ $# -gt 0 ]; do
    case $1 in
        --test-http)
            TEST_HTTP="true"
            shift
            ;;
        --port)
            HTTP_PORT="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE="true"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

main