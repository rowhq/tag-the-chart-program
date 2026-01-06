#!/bin/bash
set -e

echo "🔨 Building program..."
cd "$(dirname "$0")/.."
anchor build

echo ""
echo "📤 Deploying to devnet..."
anchor deploy --provider.cluster devnet

echo ""
echo "🧪 Running end-to-end test script..."
ts-node scripts/execute-swap.ts

echo ""
echo "✅ Done!"
