#!/bin/bash

# =============================================================================
# Line Ending Converter Script
# =============================================================================
# This script automatically converts line endings in text files between 
# Windows (CRLF) and Unix (LF) formats. It analyzes each file to determine 
# the dominant line ending type and converts accordingly:
# - If >50% of lines have CRLF endings, converts to LF (Unix format)
# - Otherwise, converts to CRLF (Windows format)
#
# Options:
# -u, --unix: Always convert to Unix format (LF)
# -g, --git: Process only git-tracked files with predefined extensions
#
# Excludes node_modules and .git directories from processing.
# Requires dos2unix and unix2dos utilities to be installed.
# =============================================================================

# Default values
ALWAYS_UNIX=false
USE_GIT_FILES=false
PATTERN=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -u|--unix)
            ALWAYS_UNIX=true
            shift
            ;;
        -g|--git)
            USE_GIT_FILES=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS] [pattern]"
            echo ""
            echo "Options:"
            echo "  -u, --unix    Always convert to Unix format (LF)"
            echo "  -g, --git     Process only git-tracked files with predefined extensions"
            echo "                (*.sh, *.js, *.ts, *.json, *.xml, *.svg, *.css, *.yaml, *.md, .env*)"
            echo "  -h, --help    Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0 '*.js'           # Process all .js files"
            echo "  $0 -u '*.sh'        # Convert all .sh files to Unix format"
            echo "  $0 -g               # Process all git-tracked files with predefined extensions"
            echo "  $0 -u -g            # Convert all git-tracked files to Unix format"
            exit 0
            ;;
        *)
            PATTERN="$1"
            shift
            ;;
    esac
done

# Check if pattern is provided when not using git mode
if [ "$USE_GIT_FILES" = false ] && [ -z "$PATTERN" ]; then
    echo "Error: Pattern required when not using -g/--git option"
    echo "Use '$0 --help' for usage information"
    exit 1
fi

# Function to process each file
process_file() {
    local file="$1"
    
    # Skip if file doesn't exist or is not a regular file
    if [ ! -f "$file" ]; then
        return
    fi
    
    if [ "$ALWAYS_UNIX" = true ]; then
        echo "Converting to LF: $file"
        dos2unix -v -k "$file"
    else
        # Count CRLF endings
        local crlf_count=$(grep -U $'\r$' "$file" 2>/dev/null | wc -l)
        # Count total lines
        local total_lines=$(wc -l < "$file" 2>/dev/null)
        
        # If more than 50% of lines have CRLF, consider it a Windows file
        if [ $total_lines -gt 0 ] && [ $crlf_count -gt $((total_lines / 2)) ]; then
            echo "Converting CRLF to LF: $file"
            dos2unix -v -k "$file"
        else
            echo "Converting LF to CRLF: $file"
            unix2dos -v -k "$file"
        fi
    fi
}

export -f process_file
export ALWAYS_UNIX

# Check if git is available and we're in a git repository
if [ "$USE_GIT_FILES" = true ]; then
    if ! command -v git &> /dev/null; then
        echo "Error: git is not installed"
        exit 1
    fi
    
    if ! git rev-parse --git-dir &> /dev/null; then
        echo "Error: Not in a git repository"
        exit 1
    fi
fi

# Process files
if [ "$USE_GIT_FILES" = true ]; then
    echo "Processing git-tracked files with predefined extensions..."
    
    # Define the extensions to process
    EXTENSIONS=("*.sh" "*.js" "*.ts" "*.json" "*.xml" "*.svg" "*.css" "*.yaml" "*.md" ".env*")
    
    # Get all git-tracked files
    for ext in "${EXTENSIONS[@]}"; do
        # Use git ls-files to get tracked files matching the pattern
        git ls-files "$ext" 2>/dev/null | while IFS= read -r file; do
            # Skip if file is in node_modules
            if [[ "$file" != *"/node_modules/"* ]]; then
                process_file "$file"
            fi
        done
    done
else
    echo "Processing files matching pattern: $PATTERN"
    
    # Find files and process them
    find . -type f -name "$PATTERN" \
        ! -path "*/node_modules/*" \
        ! -path "*/.git/*" \
        -print0 | xargs -0 -I {} bash -c 'process_file "{}"'
fi

echo "Conversion completed!"
