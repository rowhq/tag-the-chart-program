#!/bin/bash
set -e

# Usage: ./scripts/deploy.sh [devnet|mainnet]
NETWORK=${1:-devnet}

# Validate network
if [[ "$NETWORK" != "devnet" && "$NETWORK" != "mainnet" ]]; then
  echo "❌ Invalid network. Use: devnet or mainnet"
  echo "Usage: ./scripts/deploy.sh [devnet|mainnet]"
  exit 1
fi

# Set cluster for anchor (uses "mainnet" not "mainnet-beta")
ANCHOR_CLUSTER=$([[ "$NETWORK" = "mainnet" ]] && echo "mainnet" || echo "devnet")
# Set cluster for solana CLI and explorer (uses "mainnet-beta")
SOLANA_CLUSTER=$([[ "$NETWORK" = "mainnet" ]] && echo "mainnet-beta" || echo "devnet")

echo "🚀 Deploying to $NETWORK..."
echo ""

# Show deployer info
echo "💳 Deployer: $(solana address)"
echo "💰 Balance: $(solana balance)"
echo ""

# Build
echo "🔨 Building program..."
anchor build

# Deploy
echo "📤 Deploying to $ANCHOR_CLUSTER..."
anchor deploy --provider.cluster "$ANCHOR_CLUSTER"

# Get program ID
PROGRAM_ID=$(solana address -k target/deploy/tag_the_chart_program-keypair.json)

echo ""
echo "✅ Deployment complete!"
echo "📝 Program ID: $PROGRAM_ID"
echo "🌐 Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=$SOLANA_CLUSTER"
echo ""
