#!/bin/bash

# Check if the correct number of arguments are provided
if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <username> <server_ip> <client_name>"
    exit 1
fi

USERNAME=$1
SERVER_IP=$2
CLIENT_NAME=$3
BINARY_NAME="truto-daemon-linux-x64" # Replace with the actual binary name if different
SERVICE_NAME="truto-daemon" # Replace with the actual service name if different
ENV_FILE=".env.$CLIENT_NAME"

# --- Remote: Install bun (and unzip if needed) on the remote server ---
ssh $USERNAME@$SERVER_IP << EOF > /dev/null 2>&1
# Check if bun is installed by testing its default location.
if [ ! -x "/$USERNAME/.bun/bin/bun" ]; then
    echo "bun is not installed on the remote server. Checking for unzip..."
    if ! command -v unzip &>/dev/null; then
        echo "unzip is not installed. Installing unzip..."
        if command -v apt-get &>/dev/null; then
            sudo apt-get update && sudo apt-get install -y unzip
        elif command -v yum &>/dev/null; then
            sudo yum install -y unzip
        elif command -v brew &>/dev/null; then
            brew install unzip
        else
            echo "No supported package manager found. Please install unzip manually."
            exit 1
        fi
    fi
    echo "Installing bun on the remote server..."
    curl -fsSL https://bun.sh/install | bash
    # If needed, you can source your shell config to update PATH, e.g., source ~/.bashrc
fi
EOF


# Build the app
bun run build-linux

# Copy the binary to the server
scp $BINARY_NAME $USERNAME@$SERVER_IP:~/

# Copy the .env.<client_name> file to the server
scp $ENV_FILE $USERNAME@$SERVER_IP:~/.env

# Copy the service file to the server
scp truto-daemon.service $USERNAME@$SERVER_IP:~/

# Copy the migrations folder to the server
scp -r migrations $USERNAME@$SERVER_IP:~/

# Copy the jobs folder to the server
scp -r jobs $USERNAME@$SERVER_IP:~/

# Copy package.json to the server
scp package.json $USERNAME@$SERVER_IP:~/

# Update the service file on the server
ssh $USERNAME@$SERVER_IP << EOF > /dev/null 2>&1
    /$USERNAME/.bun/bin/bun install
    chmod +x ~/$BINARY_NAME
    sudo setcap CAP_NET_BIND_SERVICE=+eip ~/$BINARY_NAME
    if systemctl is-active --quiet $SERVICE_NAME; then
      sudo systemctl stop $SERVICE_NAME
    fi
    sudo mv ~/truto-daemon.service /etc/systemd/system/truto-daemon.service
    sudo chown root:root /etc/systemd/system/truto-daemon.service
    sudo chmod 644 /etc/systemd/system/truto-daemon.service
    sudo sed -i 's|ExecStart=.*|ExecStart=/$USERNAME/$BINARY_NAME|' /etc/systemd/system/truto-daemon.service
    sudo sed -i 's|EnvironmentFile=.*|EnvironmentFile=/$USERNAME/.env|' /etc/systemd/system/truto-daemon.service
    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    sudo systemctl start $SERVICE_NAME
    sudo systemctl status $SERVICE_NAME
EOF

ssh $USERNAME@$SERVER_IP << EOF
    sudo journalctl -u $SERVICE_NAME
EOF
