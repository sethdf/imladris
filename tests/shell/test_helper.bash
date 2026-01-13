#!/usr/bin/env bash
# test_helper.bash - Common setup for bats tests

# Get the directory containing the test file
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"
SCRIPTS_DIR="$PROJECT_ROOT/scripts"

# Mock directory for fake commands
MOCK_DIR="$(mktemp -d)"
export PATH="$MOCK_DIR:$PATH"

# Cleanup on exit
cleanup() {
    rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Create a mock command
# Usage: create_mock <command_name> <exit_code> [output]
create_mock() {
    local cmd="$1"
    local exit_code="${2:-0}"
    local output="${3:-}"

    cat > "$MOCK_DIR/$cmd" <<EOF
#!/bin/bash
echo "$output"
exit $exit_code
EOF
    chmod +x "$MOCK_DIR/$cmd"
}

# Create a mock that records calls
# Usage: create_recording_mock <command_name>
create_recording_mock() {
    local cmd="$1"
    local record_file="$MOCK_DIR/${cmd}_calls"

    cat > "$MOCK_DIR/$cmd" <<EOF
#!/bin/bash
echo "\$@" >> "$record_file"
exit 0
EOF
    chmod +x "$MOCK_DIR/$cmd"
}

# Get recorded calls for a mock
# Usage: get_mock_calls <command_name>
get_mock_calls() {
    local cmd="$1"
    local record_file="$MOCK_DIR/${cmd}_calls"
    [[ -f "$record_file" ]] && cat "$record_file"
}

# Source a script's functions without running main
# Usage: source_functions <script_path>
source_functions() {
    local script="$1"
    # Extract functions only (skip main execution)
    # This is a simplified approach - works for scripts that check for sourcing
    (
        # Prevent main from running by defining it as a no-op first
        main() { :; }
        source "$script"
    )
}

# Assert that a string contains a substring
# Usage: assert_contains <string> <substring>
assert_contains() {
    local string="$1"
    local substring="$2"
    if [[ "$string" != *"$substring"* ]]; then
        echo "Expected '$string' to contain '$substring'" >&2
        return 1
    fi
}

# Assert that a file exists
# Usage: assert_file_exists <path>
assert_file_exists() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        echo "Expected file '$path' to exist" >&2
        return 1
    fi
}

# Assert that a file has specific permissions
# Usage: assert_file_mode <path> <mode>
assert_file_mode() {
    local path="$1"
    local expected_mode="$2"
    local actual_mode
    actual_mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)
    if [[ "$actual_mode" != "$expected_mode" ]]; then
        echo "Expected '$path' to have mode $expected_mode, got $actual_mode" >&2
        return 1
    fi
}
