#!/bin/bash

# Emap Setup & Update Script for Debian
# This script installs dependencies, builds the project, and cleans up the source.

set -e

REPO_URL="https://github.com/RoboticEarth/Emap.git"
BINARY_NAME="emap"
INSTALL_DIR="$(pwd)"
TEMP_BUILD_DIR="$INSTALL_DIR/build_tmp_$(date +%s)"

echo "--- Emap Setup Start ---"

# 1. Install System Dependencies
echo "Checking and installing system dependencies..."
sudo apt-get update
sudo apt-get install -y 
    build-essential 
    pkg-config 
    libssl-dev 
    libsqlite3-dev 
    qtbase5-dev 
    qtdeclarative5-dev 
    qtwebengine5-dev 
    libxcb-xinerama0 
    curl 
    git 
    lsb-release

# 2. Install Node.js (if not present)
if ! command -v npm &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. Install Rust (if not present)
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
else
    # Ensure cargo is in PATH for the current script
    source $HOME/.cargo/env || true
fi

# 4. Prepare Build Workspace
echo "Preparing build workspace..."
mkdir -p "$TEMP_BUILD_DIR"
git clone "$REPO_URL" "$TEMP_BUILD_DIR"
cd "$TEMP_BUILD_DIR"

# 5. Build UI
echo "Building Frontend..."
cd ui
npm install
npm run build
cd ..

# 6. Build Backend
echo "Building Backend (this may take a while)..."
cargo build --release

# 7. Deploy Artifacts
echo "Deploying final compiled results..."
# Move binary
cp "target/release/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME.new"

# Move UI dist
rm -rf "$INSTALL_DIR/ui"
mkdir -p "$INSTALL_DIR/ui"
cp -r "ui/dist" "$INSTALL_DIR/ui/dist"

# Ensure data directories exist in the installation root
mkdir -p "$INSTALL_DIR/assets"
mkdir -p "$INSTALL_DIR/projects"
mkdir -p "$INSTALL_DIR/system_data"

# Finalize binary replacement
mv "$INSTALL_DIR/$BINARY_NAME.new" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# 8. Cleanup
echo "Cleaning up source files..."
cd "$INSTALL_DIR"
rm -rf "$TEMP_BUILD_DIR"

# Optional: if the script was run from inside a repo, and we want to "delete everything else"
# as per user instruction, we should remove the current directory's source files
# but keep the essentials.
# CAUTION: This will delete files in the current directory.
# Since the user asked to "delete everything else except the final compiled result", 
# and the script is intended to be in the root, we'll perform a targetted cleanup.

FILES_TO_KEEP=("$BINARY_NAME" "ui" "assets" "projects" "system_data" "setup.sh")

echo "Finalizing minimal installation..."
for item in *; do
    keep=false
    for target in "${FILES_TO_KEEP[@]}"; do
        if [ "$item" == "$target" ]; then
            keep=true
            break
        fi
    done
    if [ "$keep" == "false" ]; then
        rm -rf "$item"
    fi
done

echo ""
echo "=========================================="
echo "Emap Setup/Update Complete!"
echo "To run the application: ./$BINARY_NAME"
echo "=========================================="
