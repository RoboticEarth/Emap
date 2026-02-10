#!/bin/bash

# Emap Universal System Setup Script
# Supports: Debian/Ubuntu (apt), Arch (pacman), FreeBSD (pkg)

echo "=========================================="
echo "   Emap Universal System Setup"
echo "=========================================="

# 1. Identify Operating System and Package Manager
if [ -f /etc/debian_version ]; then
    PM="apt"
    echo "Detected: Debian/Ubuntu-based system"
elif [ -f /etc/fedora-release ]; then
    PM="dnf"
    echo "Detected: Fedora-based system"
elif [ -f /etc/arch-release ]; then
    PM="pacman"
    echo "Detected: Arch-based system"
elif [[ "$OSTYPE" == "freebsd"* ]]; then
    PM="pkg"
    echo "Detected: FreeBSD system"
else
    echo "Unknown OS. Attempting to detect package manager..."
    if command -v apt-get &> /dev/null; then PM="apt";
    elif command -v dnf &> /dev/null; then PM="dnf";
    elif command -v pacman &> /dev/null; then PM="pacman";
    elif command -v pkg &> /dev/null; then PM="pkg";
    else
        echo "Error: Supported package manager (apt, dnf, pacman, pkg) not found."
        exit 1
    fi
fi

# 2. Install Dependencies
echo "[1/5] Installing system dependencies using $PM..."

case $PM in
            apt)
                sudo apt-get update
                sudo apt-get install -y build-essential pkg-config libssl-dev \
                    qtbase5-dev qtwebengine5-dev rustc cargo udisks2 cage \
                    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
                    gstreamer1.0-plugins-good gstreamer1.0-libav nodejs npm \
                    alsa-utils pipewire pipewire-audio-client-libraries
                ;;
            dnf)
                sudo dnf groupinstall -y "Development Tools"
                sudo dnf install -y pkg-config openssl-devel qt5-qtbase-devel \
                    qt5-qtwebengine-devel rust cargo udisks2 cage \
                    gstreamer1-devel gstreamer1-plugins-base-devel \
                    gstreamer1-plugins-good gstreamer1-libav nodejs \
                    alsa-utils pipewire pipewire-utils
                ;;
            pacman)
                sudo pacman -Syu --needed --noconfirm base-devel pkgconf openssl \
                    qt5-base qt5-webengine rust udisks2 cage \
                    gst-plugins-good gst-libav nodejs npm \
                    alsa-utils pipewire pipewire-alsa pipewire-pulse
                ;;
            pkg)
                sudo pkg update
                sudo pkg install -y pkgconf openssl qt5-buildtools qt5-qmake \
                    qt5-widgets qt5-webengine rust automount cage \
                    gstreamer1-plugins-good gstreamer1-libav node \
                    alsa-utils
                ;;
        esac    
    # 3. Setup UI (JavaScript)
    echo "[2/5] Setting up UI dependencies (Node.js)..."
    cd ui
    if [ -f "package.json" ]; then
        npm install
        npm run build
    fi
    cd ..
    
    # 4. Configure USB Auto-Mounting & Links
    echo "[3/5] Configuring USB auto-mounting and links..."
    # Create a standard link folder that the app always checks
    sudo mkdir -p /media
    sudo chmod 777 /media
    
    if [ "$PM" == "pkg" ]; then
        echo "Configuring FreeBSD automount..."
        sudo sysrc automount_enable="YES"
        sudo service automount start
    else
        # For Linux, udisks2 usually mounts to /media/$USER or /run/media/$USER
        # We ensure the base /media is accessible
        sudo chmod +t /media 
    fi
    
    # 5. Build the Application
    echo "[4/5] Building Emap Application..."
    cargo build --release
    
    # 6. Create Launch Script (The Kiosk Mode)
    echo "[5/6] Creating start_emap.sh kiosk script..."
    # We use full paths so it works from boot services
    APP_PATH=$(pwd)
    cat <<EOF > start_emap.sh
    #!/bin/bash
    # This script launches Emap in a pure Wayland Kiosk mode using Cage
    
    # Disable screen blanking and power management (Linux TTY)
    if command -v setterm &> /dev/null; then
        setterm -blank 0 -powersave off -powerdown 0 < /dev/tty7 > /dev/tty7 2>&1
    fi
    
    export QT_QPA_PLATFORM=wayland
    export QT_VIDEO_HOLEPUNCH=1
    export XDG_RUNTIME_DIR=/run/user/\$(id -u)
    
    # Ensure runtime dir exists for Wayland
    if [ ! -d "\$XDG_RUNTIME_DIR" ]; then
        export XDG_RUNTIME_DIR=/tmp/wayland-runtime-\$(id -u)
        mkdir -p \$XDG_RUNTIME_DIR
        chmod 700 \$XDG_RUNTIME_DIR
    fi
    
    cd $APP_PATH
    # Cage launches the app fullscreen and inhibits idle by default in many versions
    cage ./target/release/emap
    EOF    chmod +x start_emap.sh
    
    # 7. Configure Start on Boot
    echo "[6/6] Configuring Start on Boot..."
    if [ "$PM" == "pkg" ]; then
        # FreeBSD RC Script
        echo "Creating FreeBSD RC script..."
        cat <<EOF | sudo tee /usr/local/etc/rc.d/emap
    #!/bin/sh
    # PROVIDE: emap
    # REQUIRE: LOGIN cleanvar
    # KEYWORD: shutdown
    
    . /etc/rc.subr
    
    name="emap"
    rcvar="emap_enable"
    command="$APP_PATH/start_emap.sh"
    
    load_rc_config \$name
    run_rc_command "\$1"
    EOF
        sudo chmod +x /usr/local/etc/rc.d/emap
        echo "To enable on FreeBSD: sudo sysrc emap_enable=YES"
    else
        # Linux systemd Service
        echo "Creating Linux systemd service..."
        cat <<EOF | sudo tee /etc/systemd/system/emap.service
    [Unit]
    Description=Emap Projection Kiosk
    After=network.target sound.target
    
    [Service]
    Type=simple
    User=$(whoami)
    WorkingDirectory=$APP_PATH
    ExecStart=$APP_PATH/start_emap.sh
    Restart=always
    RestartSec=5
    # Give it a virtual TTY if needed
    StandardInput=tty
    StandardOutput=journal
    TTYPath=/dev/tty7
    
    [Install]
    WantedBy=multi-user.target
    EOF
        sudo systemctl daemon-reload
        echo "To enable on Linux: sudo systemctl enable emap"
    fi
    
    # 8. Finalizing
    echo "=========================================="
    echo "Setup Complete!"
    echo "1. To test manually: ./start_emap.sh"
    echo "2. To enable start-on-boot:"
    if [ "$PM" == "pkg" ]; then
        echo "   sudo sysrc emap_enable=YES"
    else
        echo "   sudo systemctl enable emap"
    fi
    echo "=========================================="
# --- CLEANUP SECTION (Commented out for development) ---
# The following commands reduce disk usage by deleting build artifacts
# after the binary is created. 
#
# echo "Cleaning up build files..."
# # Keep only the final binary and assets
# cp target/release/emap ./emap_runner
# rm -rf target/
# rm -rf ~/.cargo/registry
# rm -rf ~/.cargo/git
# -------------------------------------------------------

echo "=========================================="
echo "Setup Complete!"
if [ -f "./emap_runner" ]; then
    echo "Run the app using: ./emap_runner"
else
    echo "Run the app using: ./target/release/emap"
fi
echo "=========================================="