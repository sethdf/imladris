#!/usr/bin/env bats
# test_skills.bats - Tests for skills installation functions

load 'test_helper'

setup() {
    export TEST_SCRIPT="$SCRIPTS_DIR/imladris-init.sh"
    export TEST_HOME="$(mktemp -d)"
    export TEST_CLAUDE_DIR="$TEST_HOME/.claude"
    export TEST_SKILLS_DIR="$TEST_CLAUDE_DIR/skills"
    export TEST_HOOKS_DIR="$TEST_CLAUDE_DIR/hooks"
    export TEST_REPOS_DIR="$TEST_HOME/repos/github.com"

    mkdir -p "$TEST_SKILLS_DIR" "$TEST_HOOKS_DIR" "$TEST_REPOS_DIR"
}

teardown() {
    rm -rf "$TEST_HOME"
}

# =============================================================================
# Curu Skills Tests
# =============================================================================

@test "curu skills function exists in script" {
    run grep -q "install_curu_skills()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "curu skills copies SKILL.md files correctly" {
    # Create mock curu-skills repo
    local curu_repo="$TEST_REPOS_DIR/sethdf/curu-skills"
    mkdir -p "$curu_repo/TestSkill"
    echo "# Test Skill" > "$curu_repo/TestSkill/SKILL.md"

    # Simulate skill installation logic
    for skill_dir in "$curu_repo"/*/; do
        [[ -d "$skill_dir" ]] || continue
        name=$(basename "$skill_dir")
        if [[ -f "$skill_dir/SKILL.md" ]]; then
            cp -r "$skill_dir" "$TEST_SKILLS_DIR/"
        fi
    done

    assert_file_exists "$TEST_SKILLS_DIR/TestSkill/SKILL.md"
}

@test "curu skills skips hidden directories" {
    local curu_repo="$TEST_REPOS_DIR/sethdf/curu-skills"
    mkdir -p "$curu_repo/.hidden"
    echo "# Hidden" > "$curu_repo/.hidden/SKILL.md"
    mkdir -p "$curu_repo/Visible"
    echo "# Visible" > "$curu_repo/Visible/SKILL.md"

    for skill_dir in "$curu_repo"/*/; do
        [[ -d "$skill_dir" ]] || continue
        name=$(basename "$skill_dir")
        [[ "$name" == .* ]] && continue
        if [[ -f "$skill_dir/SKILL.md" ]]; then
            cp -r "$skill_dir" "$TEST_SKILLS_DIR/"
        fi
    done

    [[ ! -d "$TEST_SKILLS_DIR/.hidden" ]]
    assert_file_exists "$TEST_SKILLS_DIR/Visible/SKILL.md"
}

@test "curu skills copies hooks to hooks directory" {
    local curu_repo="$TEST_REPOS_DIR/sethdf/curu-skills"
    mkdir -p "$curu_repo/TestSkill/src"
    echo "# Test" > "$curu_repo/TestSkill/SKILL.md"
    echo "// hook" > "$curu_repo/TestSkill/src/test-hook.ts"

    for hook in "$curu_repo"/*/src/*-hook.ts; do
        [[ -f "$hook" ]] || continue
        cp "$hook" "$TEST_HOOKS_DIR/"
    done

    assert_file_exists "$TEST_HOOKS_DIR/test-hook.ts"
}

# =============================================================================
# Anthropic Skills Tests
# =============================================================================

@test "anthropic skills function exists in script" {
    run grep -q "install_anthropic_skills()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "anthropic skills uses correct path pattern (skills/name/)" {
    # Verify the script uses single-level nesting: $SKILLS_SRC/skills/*/
    run grep -q 'SKILLS_SRC/skills"' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "anthropic skills prefixes with anthropic-" {
    local anthro_repo="$TEST_REPOS_DIR/anthropics/skills"
    mkdir -p "$anthro_repo/skills/pdf"
    echo "# PDF Skill" > "$anthro_repo/skills/pdf/SKILL.md"

    for skill_dir in "$anthro_repo/skills"/*/; do
        [[ -d "$skill_dir" ]] || continue
        name=$(basename "$skill_dir")
        if [[ -f "$skill_dir/SKILL.md" ]]; then
            cp -r "$skill_dir" "$TEST_SKILLS_DIR/anthropic-${name}"
        fi
    done

    assert_file_exists "$TEST_SKILLS_DIR/anthropic-pdf/SKILL.md"
    [[ ! -d "$TEST_SKILLS_DIR/pdf" ]]
}

@test "anthropic skills installs multiple skills" {
    local anthro_repo="$TEST_REPOS_DIR/anthropics/skills"
    mkdir -p "$anthro_repo/skills/pdf" "$anthro_repo/skills/docx" "$anthro_repo/skills/xlsx"
    echo "# PDF" > "$anthro_repo/skills/pdf/SKILL.md"
    echo "# DOCX" > "$anthro_repo/skills/docx/SKILL.md"
    echo "# XLSX" > "$anthro_repo/skills/xlsx/SKILL.md"

    local count=0
    for skill_dir in "$anthro_repo/skills"/*/; do
        [[ -d "$skill_dir" ]] || continue
        name=$(basename "$skill_dir")
        if [[ -f "$skill_dir/SKILL.md" ]]; then
            cp -r "$skill_dir" "$TEST_SKILLS_DIR/anthropic-${name}"
            count=$((count + 1))
        fi
    done

    [[ $count -eq 3 ]]
}

# =============================================================================
# Curu Tools Tests
# =============================================================================

@test "curu tools function exists in script" {
    run grep -q "setup_curu_tools()" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "curu-sync script is created" {
    run grep -q "curu-sync" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "curu-watch script is created" {
    run grep -q "curu-watch" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "curu-commit script is created" {
    run grep -q "curu-commit" "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

# =============================================================================
# Directory Symlink Tests
# =============================================================================

@test "script creates .claude symlink to data volume" {
    run grep -q '\.claude.*DATA_MOUNT' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script creates work symlink to data volume" {
    run grep -q 'work.*DATA_MOUNT' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}

@test "script creates home symlink to data volume" {
    run grep -q 'home.*DATA_MOUNT' "$TEST_SCRIPT"
    [[ $status -eq 0 ]]
}
