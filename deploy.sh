#!/bin/bash

# Check if the correct number of arguments are provided
if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <username> <server_ip>"
    exit 1
fi

USERNAME=$1
SERVER_IP=$2
BINARY_NAME="truto-daemon-linux-x64" # Replace with the actual binary name if different
SERVICE_NAME="truto-daemon" # Replace with the actual service name if different
ENV_FILE=".env"

# Build the app
bun run build-linux

# Copy the binary to the server
scp $BINARY_NAME $USERNAME@$SERVER_IP:~/

# Set permissions and capabilities on the server
ssh $USERNAME@$SERVER_IP << EOF
    # Stop the existing service if it is running
    if systemctl is-active --quiet $SERVICE_NAME; then
        sudo systemctl stop $SERVICE_NAME
    fi

    # Replace the binary
    chmod +x ~/$BINARY_NAME
    sudo setcap CAP_NET_BIND_SERVICE=+eip ~/$BINARY_NAME
EOF

# Copy the .env.<client_name> file to the server
scp $ENV_FILE $USERNAME@$SERVER_IP:~/.env

# Copy the service file to the server
scp truto-daemon.service $USERNAME@$SERVER_IP:~/

# Copy the migrations folder to the server
scp -r migrations $USERNAME@$SERVER_IP:~/

# Copy the jobs folder to the server
scp -r jobs $USERNAME@$SERVER_IP:~/

# Update the service file on the server
ssh $USERNAME@$SERVER_IP << EOF
    sudo mv ~/truto-daemon.service /etc/systemd/system/truto-daemon.service
    sudo chown root:root /etc/systemd/system/truto-daemon.service
    sudo chmod 644 /etc/systemd/system/truto-daemon.service
    sudo sed -i 's|ExecStart=.*|ExecStart=/$USERNAME/$BINARY_NAME|' /etc/systemd/system/truto-daemon.service
    sudo sed -i 's|EnvironmentFile=.*|EnvironmentFile=/$USERNAME/.env|' /etc/systemd/system/truto-daemon.service
    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    sudo systemctl start $SERVICE_NAME
    sudo systemctl status $SERVICE_NAME
    sudo journalctl -u $SERVICE_NAME
EOF
